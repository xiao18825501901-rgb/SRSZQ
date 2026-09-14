"""Create and evaluate a deterministic, replay-isolated fixed probe set."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import torch

from engine import srszq
from model import encode
from model.network import InvitusNet
from model.value import output_to_absolute

STAGES = {"early": (0.08, 0.18), "mid": (0.38, 0.52), "late": (0.70, 0.82)}


def _state_hash(state: dict[str, Any]) -> str:
    payload = json.dumps(
        {"n": state["n"], "turn": state["turn"], "board": state["board"]},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _non_winning_moves(state: dict[str, Any]) -> list[tuple[int, int]]:
    player = srszq.current_player(state)
    return [
        move
        for move in srszq.legal_moves(state)
        if not srszq.creates_four_through(state["board"], move[0], move[1], player)
    ]


def _make_state(size: int, stage: str, actor: str, rng: random.Random) -> dict[str, Any]:
    low, high = STAGES[stage]
    minimum = max(3, int(size * size * low))
    maximum = min(size * size - 12, int(size * size * high))
    targets = [turn for turn in range(minimum, maximum + 1) if "ABC"[turn % 3] == actor]
    for _ in range(200):
        target = rng.choice(targets)
        state = srszq.create_state(size)
        while state["turn"] < target and state["status"] == "playing":
            legal = _non_winning_moves(state)
            if not legal:
                break
            move = rng.choice(legal)
            srszq.apply_move(state, move[0], move[1])
        if (
            state["status"] == "playing"
            and state["turn"] == target
            and srszq.current_player(state) == actor
            and srszq.legal_moves(state)
        ):
            return state
    raise RuntimeError(f"failed to generate {size} {stage} {actor} probe")


def generate_records(count: int, seed: int) -> list[dict[str, Any]]:
    if count < 18:
        raise ValueError("fixed probe set requires at least 18 positions")
    rng = random.Random(seed)
    cells = [(size, stage, actor) for size in (13, 17) for stage in STAGES for actor in "ABC"]
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index in range(count):
        size, stage, actor = cells[index % len(cells)]
        state = _make_state(size, stage, actor, rng)
        position_hash = _state_hash(state)
        if position_hash in seen:
            raise RuntimeError("fixed probe generator produced a duplicate position")
        seen.add(position_hash)
        records.append(
            {
                "positionHash": position_hash,
                "board": [["." if cell is None else cell for cell in row] for row in state["board"]],
                "turn": state["turn"],
                "boardSize": size,
                "actor": actor,
                "round": srszq.round_of(state),
                "eligible": srszq.eligible_of(state),
                "stage": stage,
                "legalMoves": [list(move) for move in srszq.legal_moves(state)],
            }
        )
    return records


def _rebuild(record: dict[str, Any]) -> dict[str, Any]:
    state = srszq.create_state(int(record["boardSize"]))
    state["board"] = [[None if cell == "." else cell for cell in row] for row in record["board"]]
    state["turn"] = int(record["turn"])
    state["moves"] = int(record["turn"])
    return state


def evaluate_records(records: list[dict[str, Any]], checkpoint_path: str) -> dict[str, Any]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    cfg = checkpoint.get("cfg", {})
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    value_representation = str(cfg.get("value_representation", "absolute"))
    net = InvitusNet(
        int(cfg["channels"]),
        int(cfg["blocks"]),
        value_representation=value_representation,
    ).to(device)
    net.load_state_dict(checkpoint["model"])
    net.eval()
    rows: list[dict[str, Any]] = []
    with torch.no_grad():
        for record in records:
            state = _rebuild(record)
            planes = torch.from_numpy(np.asarray(encode.encode_state(state), dtype=np.float32)[None]).to(device)
            logits, log_value = net(planes)
            legal = [tuple(move) for move in record["legalMoves"]]
            values = np.asarray([float(logits[0, row * 17 + col]) for row, col in legal], dtype=np.float64)
            values -= values.max()
            policy = np.exp(values)
            policy /= policy.sum()
            entropy = -sum(float(p) * math.log(float(p)) for p in policy if p > 0)
            absolute_value = output_to_absolute(
                torch.exp(log_value[0]).cpu().tolist(),
                record["actor"],
                value_representation,
            )
            rows.append(
                {
                    "positionHash": record["positionHash"],
                    "boardSize": record["boardSize"],
                    "stage": record["stage"],
                    "actor": record["actor"],
                    "policyEntropy": entropy,
                    "top1Probability": float(policy.max()),
                    "valuePrediction": list(absolute_value),
                }
            )
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[f"{row['boardSize']}:{row['stage']}:{row['actor']}"].append(row)

    def aggregate(items: list[dict[str, Any]]) -> dict[str, Any]:
        width = len(items[0]["valuePrediction"])
        return {
            "count": len(items),
            "policyEntropyMean": sum(row["policyEntropy"] for row in items) / len(items),
            "top1ProbabilityMean": sum(row["top1Probability"] for row in items) / len(items),
            "valuePredictionMean": [
                sum(row["valuePrediction"][index] for row in items) / len(items) for index in range(width)
            ],
        }

    return {
        "checkpoint": str(Path(checkpoint_path).resolve()),
        "checkpointCounter": int(checkpoint["counter"]),
        "positions": len(rows),
        "overall": aggregate(rows),
        "groups": {key: aggregate(items) for key, items in sorted(groups.items())},
        "rows": rows,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate", action="store_true")
    parser.add_argument("--positions", required=True)
    parser.add_argument("--count", type=int, default=300)
    parser.add_argument("--seed", type=int, default=20260914)
    parser.add_argument("--checkpoint", default="")
    parser.add_argument("--out", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    positions_path = Path(args.positions).expanduser().resolve()
    if args.generate:
        records = generate_records(args.count, args.seed)
        positions_path.parent.mkdir(parents=True, exist_ok=True)
        positions_path.write_text(
            "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
            encoding="utf-8",
        )
        print(json.dumps({"event": "fixed_probe_generated", "positions": len(records), "path": str(positions_path)}))
    records = [json.loads(line) for line in positions_path.read_text(encoding="utf-8").splitlines() if line]
    if args.checkpoint:
        if not args.out:
            raise RuntimeError("--out is required with --checkpoint")
        result = evaluate_records(records, args.checkpoint)
        out_path = Path(args.out).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"event": "fixed_probe_evaluated", "positions": len(records), "out": str(out_path)}))
    counts = Counter((record["boardSize"], record["stage"], record["actor"]) for record in records)
    print(json.dumps({"event": "fixed_probe_balance", "cells": len(counts), "min": min(counts.values()), "max": max(counts.values())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
