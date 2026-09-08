"""Exact agreement probe: compare a checkpoint's NN policy/value and MCTS
best moves against exact-solved endgame positions.

Agreement metrics per position:
  - policyTop1Agreement: NN policy argmax (legal-masked) is an exact best move
  - policyTop5Agreement: an exact best move appears in NN policy top-5
  - mctsAgreement: MCTS (sims) best move is an exact best move
  - valueBrier: mean squared error of softmax(value head) vs exact outcome
    vector (solver draw vectors already converted to the training convention)

Probe data is evaluation evidence only; it is NEVER counted as formal games.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
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


def rebuild_state(record: dict[str, Any]) -> dict[str, Any]:
    state_block = record["state"]
    size = int(state_block["size"])
    state = srszq.create_state(size)
    for r in range(size):
        row = state_block["board"][r]
        for c in range(size):
            cell = row[c]
            state["board"][r][c] = cell if cell != "." else None
    state["turn"] = int(state_block["turn"])
    state["moves"] = int(state_block["turn"])
    return state


def legal_masked_logits(logits: np.ndarray, legal: list[list[int]]) -> np.ndarray:
    masked = np.full(CANVAS * CANVAS, -np.inf, dtype=np.float32)
    for row, col in legal:
        masked[row * CANVAS + col] = logits[row * CANVAS + col]
    return masked


def evaluate_checkpoint(
    records: list[dict[str, Any]],
    net: torch.nn.Module,
    device: torch.device,
    sims: int,
    seed: int,
    max_positions: int,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    rng = random.Random(seed)
    net.eval()
    for record in records[:max_positions]:
        state = rebuild_state(record)
        legal = [tuple(move) for move in record["legalMoves"]]
        actor = record["actor"]
        best_moves = {tuple(move) for move in record["exactBestMoves"]}
        exact_vector = record["exactOutcomeVector"]

        planes = np.asarray([encode.encode_state(state)], dtype=np.float32)
        with torch.inference_mode():
            logits, log_values = net(torch.from_numpy(planes).to(device))
        logits_np = logits[0].detach().float().cpu().numpy()
        masked = legal_masked_logits(logits_np, [list(m) for m in legal])
        top5 = np.argsort(masked)[::-1][:5]
        top1 = int(top5[0])
        policy_top1_agrees = (top1 // CANVAS, top1 % CANVAS) in best_moves
        policy_top5_agrees = any((idx // CANVAS, idx % CANVAS) in best_moves for idx in top5.tolist())

        values = torch.softmax(log_values[0], dim=0).detach().float().cpu().numpy()
        brier = float(np.mean((values - np.asarray(exact_vector, dtype=np.float32)) ** 2))

        mcts = NNMCTS(net, device, sims=sims, exact=None, rng=random.Random(rng.getrandbits(32)), train=False)
        mcts.search(state)
        mcts_move, _ = mcts.best_move(temperature=0.0)
        mcts_agrees = mcts_move in best_moves

        rows.append({
            "canonical": record["canonical"],
            "boardSize": record["boardSize"],
            "actor": actor,
            "policyTop1Agreement": bool(policy_top1_agrees),
            "policyTop5Agreement": bool(policy_top5_agrees),
            "mctsAgreement": bool(mcts_agrees),
            "valueBrier": round(brier, 6),
            "exactBestMoveCount": len(best_moves),
        })

    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault((str(row["boardSize"]), row["actor"]), []).append(row)
    summaries: list[dict[str, Any]] = []
    for (board_size, seat), group_rows in sorted(groups.items()):
        n = len(group_rows)
        summaries.append({
            "boardSize": int(board_size),
            "actor": seat,
            "positions": n,
            "policyTop1Agreement": round(sum(r["policyTop1Agreement"] for r in group_rows) / n, 4),
            "policyTop5Agreement": round(sum(r["policyTop5Agreement"] for r in group_rows) / n, 4),
            "mctsAgreement": round(sum(r["mctsAgreement"] for r in group_rows) / n, 4),
            "valueBrierMean": round(sum(r["valueBrier"] for r in group_rows) / n, 6),
        })
    total = len(rows)
    return {
        "positions": total,
        "sims": sims,
        "policyTop1Agreement": round(sum(r["policyTop1Agreement"] for r in rows) / max(1, total), 4),
        "policyTop5Agreement": round(sum(r["policyTop5Agreement"] for r in rows) / max(1, total), 4),
        "mctsAgreement": round(sum(r["mctsAgreement"] for r in rows) / max(1, total), 4),
        "valueBrierMean": round(sum(r["valueBrier"] for r in rows) / max(1, total), 6),
        "byBoardAndActor": summaries,
        "detail": rows,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--oracle", required=True, help="exact oracle jsonl")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True, help="output json path")
    parser.add_argument("--sims", type=int, default=16)
    parser.add_argument("--max-positions", type=int, default=0, help="0 = all")
    parser.add_argument("--seed", type=int, default=20260908)
    args = parser.parse_args()
    return args


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("exact agreement probe requires CUDA")
    device = torch.device("cuda")
    records: list[dict[str, Any]] = []
    with Path(args.oracle).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    if not records:
        raise RuntimeError(f"oracle {args.oracle} is empty")
    started = time.monotonic()
    net, meta = load_checkpoint_network(args.checkpoint, device)
    result = evaluate_checkpoint(records, net, device, args.sims, args.seed, args.max_positions or len(records))
    result["checkpoint"] = str(Path(args.checkpoint).resolve())
    result["checkpointMeta"] = meta
    result["elapsedSeconds"] = round(time.monotonic() - started, 3)
    result["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _atomic_json(Path(args.out), result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
