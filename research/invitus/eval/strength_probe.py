"""Mini strength probe: candidate vs arbitrary tactic spec pairs, seat-balanced.

用法：--specs random,3,maxn  → 三个 matchup：vs random+random、vs 3★+3★、vs maxn+maxn。
评估局 formal=false，永不计入训练。
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

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
    parser.add_argument("--specs", default="random,3,maxn")
    parser.add_argument("--games-per-matchup", type=int, default=30)
    parser.add_argument("--sims", type=int, default=16)
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.games_per_matchup % 3 != 0:
        parser.error("games-per-matchup must be divisible by 3")
    return args


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("strength probe requires CUDA")
    device = torch.device("cuda")
    net, meta = load_checkpoint_network(args.checkpoint, device)
    service = InferenceService(net, device, max_batch_size=128, max_wait_ms=2.0, precision="fp32")
    bridge = TacticBridge(REPO_ROOT)
    specs = [s.strip() for s in args.specs.split(",") if s.strip()]
    results = {"checkpoint": str(Path(args.checkpoint).resolve()), "checkpointMeta": meta, "matchups": []}
    try:
        for index, spec in enumerate(specs):
            pair: list = [int(spec) if spec.isdigit() else spec, int(spec) if spec.isdigit() else spec]
            started = time.monotonic()
            matchup = run_matchup(
                service, None, bridge, pair, f"{spec}+{spec}",
                args.games_per_matchup, args.sims, args.threads, args.seed + index * 7,
            )
            matchup["elapsedSeconds"] = round(time.monotonic() - started, 3)
            results["matchups"].append(matchup)
            print(
                f"{spec}+{spec}: adjusted={matchup['seatAdjustedWinRate']} "
                f"CI95=[{matchup['wilson95Lower']},{matchup['wilson95Upper']}] ({matchup['elapsedSeconds']}s)",
                flush=True,
            )
    finally:
        bridge.close()
        service.close()
    _atomic_json(Path(args.out), results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
