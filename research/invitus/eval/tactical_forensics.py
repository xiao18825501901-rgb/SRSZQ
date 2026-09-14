"""Programmatic tactical failure forensics for seat-balanced matchups."""
from __future__ import annotations

import argparse
import copy
import json
import random
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import torch

from engine import srszq
from eval.champion_gate import load_checkpoint_network
from eval.match import play_matchup
from inference.service import InferenceService
from mcts.tactical import immediate_winning_moves, root_tactical_moves
from training.audit_training_state import _atomic_json
from training.league import TacticBridge

REPO_ROOT = Path(__file__).resolve().parents[3]
CATEGORIES = (
    "MISSED_IMMEDIATE_WIN",
    "MISSED_REQUIRED_BLOCK",
    "CREATED_OPPONENT_IMMEDIATE_WIN",
    "ILLEGAL_FOUR_AVOIDANCE_ERROR",
    "VICTORY_RIGHT_MISUNDERSTANDING",
    "DOUBLE_THREAT_MISS",
    "SHALLOW_2PLY_MISS",
    "VALUE_SEARCH_ERROR",
    "LONG_HORIZON_STRATEGY",
    "UNKNOWN",
)


def rebuild_trace_state(record: dict[str, Any]) -> dict[str, Any]:
    size = int(record["size"])
    state = srszq.create_state(size)
    for row in range(size):
        for col, cell in enumerate(record["board"][row]):
            state["board"][row][col] = None if cell == "." else cell
    state["turn"] = int(record["turn"])
    state["moves"] = int(record["turn"])
    return state


def classify_candidate_turn(record: dict[str, Any]) -> str | None:
    """Return only a category that can be proved from the engine state."""
    state = rebuild_trace_state(record)
    move = tuple(int(value) for value in record["move"])
    legal = srszq.legal_moves(state)
    if move not in legal:
        if move in srszq.forbidden_moves(state):
            return "ILLEGAL_FOUR_AVOIDANCE_ERROR"
        return "VICTORY_RIGHT_MISUNDERSTANDING"

    own_wins = immediate_winning_moves(state)
    if own_wins and move not in own_wins:
        return "MISSED_IMMEDIATE_WIN"
    required, reason = root_tactical_moves(state)
    if reason == "forced_defense" and required is not None and move not in required:
        return "MISSED_REQUIRED_BLOCK"

    child = copy.deepcopy(state)
    result = srszq.apply_move(child, move[0], move[1])
    if result != "ok":
        return "ILLEGAL_FOUR_AVOIDANCE_ERROR"
    threats = immediate_winning_moves(child)
    if len(threats) >= 2:
        return "DOUBLE_THREAT_MISS"
    if len(threats) == 1:
        return "CREATED_OPPONENT_IMMEDIATE_WIN"
    return None


def analyze_game(candidate_seat: str, result: str, meta: dict[str, Any]) -> dict[str, Any]:
    candidate_won = result == f"{candidate_seat}_WIN"
    candidate_lost = result.endswith("_WIN") and not candidate_won
    nn_turns = [row for row in meta.get("trace", []) if row.get("actor") == candidate_seat]
    shield = {"immediate_win": 0, "forced_defense": 0}
    for row in nn_turns:
        reason = row.get("rootTacticalReason")
        if reason in shield:
            shield[reason] += 1
    first_error = None
    evidence = None
    if candidate_lost:
        for row in nn_turns:
            category = classify_candidate_turn(row)
            if category is not None:
                first_error = category
                evidence = row
                break
        if first_error is None:
            first_error = "UNKNOWN"
    return {
        "result": result,
        "candidateWon": candidate_won,
        "candidateLost": candidate_lost,
        "candidateTurns": len(nn_turns),
        "rootShield": shield,
        "firstError": first_error,
        "evidence": evidence,
        "moves": meta.get("moves"),
    }


def run_matchup_forensics(
    service: InferenceService,
    bridge: TacticBridge,
    spec: str | int,
    games: int,
    sims: int,
    threads: int,
    seed: int,
) -> dict[str, Any]:
    tasks = [(seat, index) for seat in "ABC" for index in range(games // 3)]
    size_mix = (13, 13, 17)

    def play(task: tuple[str, int]) -> dict[str, Any]:
        seat, index = task
        task_seed = seed + "ABC".index(seat) * 1_000_003 + index * 97
        rng = random.Random(task_seed)
        size = size_mix[rng.randrange(len(size_mix))]
        seats: dict[str, tuple[str, ...]] = {seat: ("nn",)}
        nn_agents = {seat: (None, torch.device("cuda"), service, sims)}
        for other in "ABC":
            if other != seat:
                seats[other] = ("tactic", spec)
        result, meta = play_matchup(size, seats, nn_agents, sims, bridge, rng, collect_trace=True)
        analyzed = analyze_game(seat, result, meta)
        return {"candidateSeat": seat, "boardSize": size, "seed": task_seed, **analyzed}

    with ThreadPoolExecutor(max_workers=threads) as executor:
        details = list(executor.map(play, tasks))
    histogram = {category: 0 for category in CATEGORIES}
    for row in details:
        if row["firstError"] is not None:
            histogram[row["firstError"]] += 1
    losses = sum(row["candidateLost"] for row in details)
    wins = sum(row["candidateWon"] for row in details)
    shields = {
        reason: sum(row["rootShield"][reason] for row in details)
        for reason in ("immediate_win", "forced_defense")
    }
    return {
        "opponents": f"{spec}+{spec}",
        "games": len(details),
        "wins": wins,
        "losses": losses,
        "draws": len(details) - wins - losses,
        "histogram": histogram,
        "rootShield": shields,
        "details": details,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--specs", default="3,maxn")
    parser.add_argument("--games-per-matchup", type=int, default=102)
    parser.add_argument("--sims", type=int, default=16)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260940)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.games_per_matchup < 102 or args.games_per_matchup % 3:
        parser.error("games-per-matchup must be at least 102 and divisible by 3")
    if not torch.cuda.is_available():
        raise RuntimeError("tactical forensics requires CUDA")

    device = torch.device("cuda")
    net, meta = load_checkpoint_network(args.checkpoint, device)
    service = InferenceService(net, device, max_batch_size=128, max_wait_ms=2.0, precision="fp32")
    bridge = TacticBridge(REPO_ROOT)
    before = dict(bridge.metrics)
    started = time.monotonic()
    try:
        matchups = []
        for index, text in enumerate(args.specs.split(",")):
            text = text.strip()
            spec: str | int = int(text) if text.isdigit() else text
            matchups.append(
                run_matchup_forensics(
                    service, bridge, spec, args.games_per_matchup, args.sims,
                    args.threads, args.seed + index * 10_000_019,
                )
            )
    finally:
        bridge_delta = {key: bridge.metrics[key] - before[key] for key in bridge.metrics}
        bridge.close()
        service.close()
    result = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "checkpointMeta": meta,
        "sims": args.sims,
        "bridge": bridge_delta,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "matchups": matchups,
        "pass": bridge_delta["fallbacks"] == 0,
    }
    _atomic_json(Path(args.out), result)
    print(json.dumps({
        "pass": result["pass"],
        "bridge": bridge_delta,
        "matchups": [
            {key: matchup[key] for key in ("opponents", "games", "wins", "losses", "draws", "histogram", "rootShield")}
            for matchup in matchups
        ],
    }, ensure_ascii=False, indent=2))
    return 0 if result["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
