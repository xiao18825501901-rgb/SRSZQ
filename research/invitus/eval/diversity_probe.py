"""Policy diversity / entropy / value-distribution probe (training diagnostics).

Plays fresh self-play games with the checkpoint in EVALUATION mode (Dirichlet
OFF), but keeps the training temperature schedule (temp=1 for the first 8
moves) so opening diversity reflects real training behavior. Records:

  - NN policy entropy over legal moves (by board size)
  - MCTS root visit-distribution entropy (by board size)
  - opening diversity: first 3/6/9 plies sequences (unique count, entropy,
    top frequency)
  - value-head predicted A/B/C/DRAW distribution vs realized outcome
    distribution (seat-bias check)

Probe games are evaluation evidence only; NEVER counted as formal episodes.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import torch

from engine import srszq
from eval.champion_gate import load_checkpoint_network
from mcts.nn_mcts import NNMCTS
from model import encode
from training.audit_training_state import _atomic_json

CANVAS = 17
TEMPERATURE_FIRST = 8


def entropy(probs: np.ndarray) -> float:
    probs = probs[probs > 0]
    return float(-(probs * np.log(probs)).sum())


def play_probe_game(
    net: torch.nn.Module,
    device: torch.device,
    sims: int,
    seed: int,
    size_mix: tuple[int, ...] = (13, 13, 17),
) -> dict[str, Any]:
    rng = random.Random(seed)
    size = size_mix[rng.randrange(len(size_mix))]
    state = srszq.create_state(size)
    move_no = 0
    guard = 0
    policy_entropies: list[float] = []
    visit_entropies: list[float] = []
    opening_moves: list[str] = []
    value_preds: list[list[float]] = []
    chosen_visits: list[float] = []
    while state["status"] == "playing" and guard < size * size + 32:
        legal = srszq.legal_moves(state)
        if not legal:
            srszq._advance_pass_chain(state)
            guard += 1
            continue
        planes = np.asarray([encode.encode_state(state)], dtype=np.float32)
        with torch.inference_mode():
            logits, log_values = net(torch.from_numpy(planes).to(device))
        masked = np.full(CANVAS * CANVAS, -np.inf, dtype=np.float32)
        for row, col in legal:
            masked[row * CANVAS + col] = logits[0][row * CANVAS + col].item()
        policy = np.exp(masked - masked.max())
        policy = policy / policy.sum()
        policy_entropies.append(entropy(policy))
        values = torch.softmax(log_values[0], dim=0).detach().float().cpu().numpy()
        value_preds.append(values.tolist())

        search = NNMCTS(net, device, sims=sims, exact=None, rng=random.Random(rng.getrandbits(32)), train=False)
        search.search(state)
        visits = np.zeros(CANVAS * CANVAS, dtype=np.float64)
        for (row, col), child in search.root.children.items():
            visits[row * CANVAS + col] = float(child.N)
        visit_entropies.append(entropy(visits / visits.sum()))
        temperature = 1.0 if move_no < TEMPERATURE_FIRST else 0.0
        move, _ = search.best_move(temperature=temperature)
        opening_moves.append(f"{move[0]},{move[1]}")
        chosen_visits.append(float(search.root.children[move].N))
        srszq.apply_move(state, move[0], move[1])
        move_no += 1
        guard += 1
    if state["status"] == "playing":
        state["status"] = "draw"
    if state["status"] == "won":
        outcome = [0.0, 0.0, 0.0, 0.0]
        outcome["ABC".index(state["winner"])] = 1.0
    else:
        outcome = [0.0, 0.0, 0.0, 1.0]
    return {
        "size": size,
        "policyEntropies": policy_entropies,
        "visitEntropies": visit_entropies,
        "openingMoves": opening_moves,
        "valuePreds": value_preds,
        "outcome": outcome,
    }


def opening_stats(opening_lists: list[list[str]], plies: int) -> dict[str, Any]:
    sequences = ["-".join(moves[:plies]) for moves in opening_lists if len(moves) >= plies]
    counts = Counter(sequences)
    probs = np.asarray([count for count in counts.values()], dtype=np.float64)
    probs = probs / probs.sum()
    return {
        "plies": plies,
        "games": len(sequences),
        "unique": len(counts),
        "entropy": entropy(probs),
        "topFrequency": float(probs.max()),
        "topOpening": counts.most_common(1)[0][0] if counts else "",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--games", type=int, default=120)
    parser.add_argument("--sims", type=int, default=16)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    return args


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("diversity probe requires CUDA")
    device = torch.device("cuda")
    net, meta = load_checkpoint_network(args.checkpoint, device)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        results = list(
            executor.map(
                lambda seed: play_probe_game(net, device, args.sims, seed),
                [args.seed + index for index in range(args.games)],
            )
        )
    by_size: dict[str, dict[str, list[float]]] = {}
    outcome_counts = Counter()
    value_mean = np.zeros(4)
    value_count = 0
    for result in results:
        key = str(result["size"])
        bucket = by_size.setdefault(key, {"policy": [], "visits": []})
        bucket["policy"].extend(result["policyEntropies"])
        bucket["visits"].extend(result["visitEntropies"])
        outcome_counts[tuple(result["outcome"])] += 1
        for vector in result["valuePreds"]:
            value_mean += np.asarray(vector)
            value_count += 1
    value_mean = (value_mean / max(1, value_count)).tolist()
    record = {
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "checkpointMeta": meta,
        "games": len(results),
        "sims": args.sims,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "entropyBySize": {
            size: {
                "positions": len(bucket["policy"]),
                "policyEntropyMean": round(float(np.mean(bucket["policy"])), 4),
                "visitEntropyMean": round(float(np.mean(bucket["visits"])), 4),
            }
            for size, bucket in sorted(by_size.items())
        },
        "openings": [opening_stats([r["openingMoves"] for r in results], plies) for plies in (3, 6, 9)],
        "valuePredictedMean": [round(value, 4) for value in value_mean],
        "outcomeDistribution": {
            "A": sum(1 for r in results if r["outcome"][0] == 1),
            "B": sum(1 for r in results if r["outcome"][1] == 1),
            "C": sum(1 for r in results if r["outcome"][2] == 1),
            "DRAW": sum(1 for r in results if r["outcome"][3] == 1),
        },
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _atomic_json(Path(args.out), record)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
