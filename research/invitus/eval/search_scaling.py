"""Search scaling sweep: champion strength vs MCTS sims budget.

Runs the vs 5*+5* and vs maxn+maxn matchups at each --sims level with
seat-balanced rotation and aggregates one JSON per level plus a combined
report. More search must never make the champion materially weaker.

Sweep games are evaluation evidence only; NEVER counted as formal episodes.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import torch

from eval.champion_gate import load_checkpoint_network, run_matchup
from inference.service import InferenceService
from training.audit_training_state import _atomic_json
from training.league import TacticBridge

REPO_ROOT = Path(__file__).resolve().parents[3]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--sims-levels", default="100,200,400,800,1600,3200")
    parser.add_argument("--games-per-matchup", type=int, default=60)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.games_per_matchup % 3 != 0:
        parser.error("games-per-matchup must be divisible by 3 (seat rotation)")
    return args


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("search scaling requires CUDA")
    device = torch.device("cuda")
    net, meta = load_checkpoint_network(args.checkpoint, device)
    service = InferenceService(
        net, device, max_batch_size=128, max_wait_ms=2.0, precision="fp32", compile_model=False
    )
    bridge = TacticBridge(REPO_ROOT)
    levels = [int(level) for level in args.sims_levels.split(",") if level.strip()]
    levels.sort()
    results: dict[str, Any] = {
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "checkpointMeta": meta,
        "gamesPerMatchup": args.games_per_matchup,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "levels": [],
    }
    try:
        for index, sims in enumerate(levels):
            level: dict[str, Any] = {"sims": sims, "matchups": []}
            for pair, name in (([5, 5], "5star+5star"), (["maxn", "maxn"], "maxn+maxn")):
                started = time.monotonic()
                matchup = run_matchup(
                    service, None, bridge, pair, name,
                    args.games_per_matchup, sims, args.threads, args.seed + index * 10 + len(pair),
                )
                matchup["elapsedSeconds"] = round(time.monotonic() - started, 3)
                level["matchups"].append(matchup)
                print(
                    f"SIMS {sims} {name}: adjusted={matchup['seatAdjustedWinRate']} "
                    f"CI95=[{matchup['wilson95Lower']},{matchup['wilson95Upper']}] "
                    f"p={matchup['pValueVsThird']} ({matchup['elapsedSeconds']}s)",
                    flush=True,
                )
            results["levels"].append(level)
    finally:
        bridge.close()
        service.close()
    _atomic_json(Path(args.out), results)
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
