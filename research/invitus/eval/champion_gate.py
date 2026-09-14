"""Champion gate: seat-balanced promotion evaluation for candidate checkpoints.

Matchups (candidate occupies one seat; the other two seats hold the opponent
pair; candidate rotates A/B/C equally within each matchup):

  - production 5* + 5*             (tactic difficulty 5)
  - pure maxn + maxn               (tactic 'maxn')
  - strongest mixed baseline pair  (5* + maxn)
  - current champion + champion    (when a champion exists)

Statistics per matchup: per-seat W/D/L, seat-adjusted win rate (mean over
seats), Wilson 95% CI, one-sided z-test against 1/3. Promotion (internal gate,
not the frozen acceptance): promote the candidate when, versus the champion
pair, the seat-adjusted win-rate 95% CI lower bound > 1/3 OR p < 0.05.

Evaluation games are NEVER counted as formal training episodes.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import torch

from eval.match import play_matchup
from inference.service import InferenceService
from model.network import InvitusNet
from training.audit_training_state import _atomic_json
from training.league import TacticBridge

REPO_ROOT = Path(__file__).resolve().parents[3]


def load_checkpoint_network(path: str, device: torch.device) -> tuple[Any, dict[str, Any]]:
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    cfg = checkpoint.get("cfg") if isinstance(checkpoint.get("cfg"), dict) else {}
    channels = int(cfg["channels"])
    blocks = int(cfg["blocks"])
    value_representation = str(cfg.get("value_representation", "absolute"))
    network = InvitusNet(channels, blocks, value_representation=value_representation).to(device)
    network.load_state_dict(checkpoint["model"])
    network.eval()
    return network, {
        "channels": channels,
        "blocks": blocks,
        "counter": int(checkpoint.get("counter", -1)),
        "valueRepresentation": value_representation,
        "valueLoss": str(cfg.get("value_loss", "ce")),
    }


def wilson_interval(wins: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total <= 0:
        return 0.0, 1.0
    phat = wins / total
    denom = 1 + z * z / total
    centre = (phat + z * z / (2 * total)) / denom
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * total)) / total) / denom
    return max(0.0, centre - margin), min(1.0, centre + margin)


def z_test_vs_third(wins: int, total: int) -> float:
    """One-sided p-value for H0: seat-adjusted win rate <= 1/3."""
    if total <= 0:
        return 1.0
    phat = wins / total
    se = math.sqrt((1 / 3) * (2 / 3) / total)
    z = (phat - 1 / 3) / se
    return 0.5 * math.erfc(z / math.sqrt(2))


def build_match_tasks(games: int, seed: int, size_mix: tuple[int, ...]) -> list[tuple[str, int, int]]:
    """Create a deterministic seat-balanced schedule with one RNG per game."""
    rng = random.Random(seed)
    per_seat = games // 3
    return [
        (seat, size_mix[rng.randrange(len(size_mix))], rng.getrandbits(64))
        for seat in "ABC"
        for _ in range(per_seat)
    ]


def run_matchup(
    candidate_service: InferenceService,
    champion_service: InferenceService | None,
    bridge: TacticBridge,
    opponent_pair: list[Any],
    opponent_pair_name: str,
    games: int,
    sims: int,
    threads: int,
    seed: int,
    size_mix: tuple[int, ...] = (13, 13, 17),
) -> dict[str, Any]:
    """opponent_pair entries: int difficulty or str tactic id; champion pair uses "nn-champion"."""
    results: list[tuple[str, str, int]] = []  # (seat, result, size)
    tasks = build_match_tasks(games, seed, size_mix)

    def play_one(task: tuple[str, int, int]) -> tuple[str, str, int]:
        seat, size, task_seed = task
        seats: dict[str, tuple[str, ...]] = {seat: ("nn",)}
        nn_agents: dict[str, tuple[Any, Any, Any, int]] = {
            seat: (None, torch.device("cuda"), candidate_service, sims)
        }
        others = [s for s in "ABC" if s != seat]
        for index, other in enumerate(others):
            spec = opponent_pair[index]
            if spec == "nn-champion":
                if champion_service is None:
                    raise RuntimeError("champion pair requested but no champion service available")
                seats[other] = ("nn",)
                nn_agents[other] = (None, torch.device("cuda"), champion_service, sims)
            else:
                seats[other] = ("tactic", spec)
        result, _ = play_matchup(size, seats, nn_agents, sims, bridge, random.Random(task_seed))
        return seat, result, size

    with ThreadPoolExecutor(max_workers=threads) as executor:
        for seat, result, size in executor.map(play_one, tasks):
            results.append((seat, result, size))

    per_seat_stats: dict[str, dict[str, int]] = {}
    for seat in "ABC":
        seat_results = [r for s, r, _ in results if s == seat]
        per_seat_stats[seat] = {
            "games": len(seat_results),
            "wins": sum(1 for r in seat_results if r.endswith("_WIN") and r[0] == seat),
            "draws": sum(1 for r in seat_results if r == "DRAW"),
            "losses": sum(1 for r in seat_results if r.endswith("_WIN") and r[0] != seat),
        }
    total_wins = sum(stats["wins"] for stats in per_seat_stats.values())
    total_games = sum(stats["games"] for stats in per_seat_stats.values())
    adjusted_rate = total_wins / max(1, total_games)
    lower, upper = wilson_interval(total_wins, total_games)
    p_value = z_test_vs_third(total_wins, total_games)
    sizes = {"13": sum(1 for _, _, s in results if s == 13), "17": sum(1 for _, _, s in results if s == 17)}
    return {
        "opponents": opponent_pair_name,
        "games": total_games,
        "sizes": sizes,
        "perSeat": per_seat_stats,
        "seatAdjustedWinRate": round(adjusted_rate, 4),
        "wilson95Lower": round(lower, 4),
        "wilson95Upper": round(upper, 4),
        "pValueVsThird": round(p_value, 6),
        "sims": sims,
    }


def load_champion_state(evaluations_dir: Path) -> dict[str, Any]:
    path = evaluations_dir / "champion_state.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"champion": None, "promotedAt": None, "history": []}


def save_champion_state(evaluations_dir: Path, state: dict[str, Any]) -> None:
    evaluations_dir.mkdir(parents=True, exist_ok=True)
    _atomic_json(evaluations_dir / "champion_state.json", state)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, help="candidate checkpoint path")
    parser.add_argument("--champion", default="", help="champion checkpoint path (default: champion_state.json)")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--games-per-matchup", type=int, default=60)
    parser.add_argument("--sims", type=int, default=16)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--promote", action="store_true", help="allow writing promotion to champion_state.json")
    parser.add_argument("--skip-champion-matchup", action="store_true")
    args = parser.parse_args()
    if args.games_per_matchup % 3 != 0:
        parser.error("games-per-matchup must be divisible by 3 (seat rotation)")
    return args


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("champion gate requires CUDA")
    device = torch.device("cuda")
    evaluations_dir = Path(args.data_root) / "evaluations"
    evaluations_dir.mkdir(parents=True, exist_ok=True)
    champion_state = load_champion_state(evaluations_dir)

    candidate_net, candidate_cfg = load_checkpoint_network(args.candidate, device)
    candidate_service = InferenceService(
        candidate_net, device, max_batch_size=128, max_wait_ms=2.0, precision="fp32", compile_model=False
    )
    champion_path = args.champion or champion_state.get("champion")
    champion_service = None
    champion_meta: dict[str, Any] = {}
    if champion_path and not args.skip_champion_matchup and os.path.exists(champion_path):
        champion_net, champion_meta = load_checkpoint_network(champion_path, device)
        champion_service = InferenceService(
            champion_net, device, max_batch_size=128, max_wait_ms=2.0, precision="fp32", compile_model=False
        )
    bridge = TacticBridge(REPO_ROOT)
    try:
        matchups: list[dict[str, Any]] = []
        base_seed = args.seed
        matchups.append(
            run_matchup(
                candidate_service, champion_service, bridge, [5, 5], "5star+5star",
                args.games_per_matchup, args.sims, args.threads, base_seed + 1,
            )
        )
        matchups.append(
            run_matchup(
                candidate_service, champion_service, bridge, ["maxn", "maxn"], "maxn+maxn",
                args.games_per_matchup, args.sims, args.threads, base_seed + 2,
            )
        )
        matchups.append(
            run_matchup(
                candidate_service, champion_service, bridge, [5, "maxn"], "5star+maxn",
                args.games_per_matchup, args.sims, args.threads, base_seed + 3,
            )
        )
        if champion_service is not None:
            matchups.append(
                run_matchup(
                    candidate_service, champion_service, bridge,
                    ["nn-champion", "nn-champion"], "champion+champion",
                    args.games_per_matchup, args.sims, args.threads, base_seed + 4,
                )
            )
    finally:
        bridge.close()
        candidate_service.close()
        if champion_service is not None:
            champion_service.close()

    champion_match = next((m for m in matchups if m["opponents"] == "champion+champion"), None)
    initial_gate = False
    if champion_match is None and not champion_state.get("champion"):
        # No champion exists yet: the FIRST champion must beat the strongest
        # acceptance baseline (5*+5*) significantly before being crowned.
        champion_match = next(m for m in matchups if m["opponents"] == "5star+5star")
        initial_gate = True
    if champion_match is not None:
        promoted = (
            champion_match["seatAdjustedWinRate"] > 1 / 3
            and (champion_match["wilson95Lower"] > 1 / 3 or champion_match["pValueVsThird"] < 0.05)
        )
    else:
        promoted = False
    record = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "candidate": str(Path(args.candidate).resolve()),
        "candidateMeta": candidate_cfg,
        "champion": str(Path(champion_path).resolve()) if champion_path else None,
        "championMeta": champion_meta or None,
        "config": {
            "gamesPerMatchup": args.games_per_matchup,
            "sims": args.sims,
            "threads": args.threads,
            "seed": args.seed,
        },
        "matchups": matchups,
        "promoted": promoted,
        "initialGate": initial_gate,
    }
    run_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    _atomic_json(evaluations_dir / f"champion_gate_{run_id}.json", record)
    if promoted and args.promote:
        champion_state["champion"] = str(Path(args.candidate).resolve())
        champion_state["promotedAt"] = record["timestamp"]
        champion_state["history"] = (champion_state.get("history") or []) + [record]
        save_champion_state(evaluations_dir, champion_state)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    for matchup in matchups:
        print(
            f"MATCHUP {matchup['opponents']}: adjusted={matchup['seatAdjustedWinRate']} "
            f"CI95=[{matchup['wilson95Lower']},{matchup['wilson95Upper']}] p_vs_1/3={matchup['pValueVsThird']}"
        )
    print(f"PROMOTED={str(promoted).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
