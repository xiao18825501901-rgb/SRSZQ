"""Raw policy accuracy on the frozen, replay-isolated tactical evaluation set."""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import torch

from engine import srszq
from eval.champion_gate import load_checkpoint_network
from model import encode
from training.audit_training_state import _atomic_json


def aggregate_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def summarize(group: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "positions": len(group),
            "top1Accuracy": sum(bool(row["correct"]) for row in group) / len(group),
            "targetProbabilityMean": sum(float(row["targetProbability"]) for row in group) / len(group),
        }

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[row["category"]].append(row)
    return {
        **summarize(rows),
        "byCategory": {category: summarize(group) for category, group in sorted(groups.items())},
    }


def _rebuild(record: dict[str, Any]) -> dict[str, Any]:
    source = record["state"]
    state = srszq.create_state(int(source["size"]))
    state["board"] = [[None if cell == "." else cell for cell in row] for row in source["board"]]
    state["turn"] = state["moves"] = int(source["turn"])
    return state


def evaluate(records: list[dict[str, Any]], checkpoint: str) -> dict[str, Any]:
    if not torch.cuda.is_available():
        raise RuntimeError("tactical evaluation requires CUDA")
    device = torch.device("cuda")
    network, checkpoint_meta = load_checkpoint_network(checkpoint, device)
    rows: list[dict[str, Any]] = []
    with torch.inference_mode():
        for record in records:
            state = _rebuild(record)
            tensor = torch.from_numpy(np.asarray([encode.encode_state(state)], dtype=np.float32)).to(device)
            logits, _ = network(tensor)
            legal = [tuple(move) for move in record["legalMoves"]]
            legal_logits = torch.tensor(
                [float(logits[0, row * 17 + col]) for row, col in legal], device=device
            )
            probabilities = torch.softmax(legal_logits, dim=0).cpu().tolist()
            top_move = legal[int(torch.argmax(legal_logits).item())]
            optimal = {tuple(move) for move in record["optimalMoves"]}
            rows.append(
                {
                    "positionHash": record["positionHash"],
                    "boardSize": record["boardSize"],
                    "actor": record["actor"],
                    "category": record["category"],
                    "correct": top_move in optimal,
                    "topMove": list(top_move),
                    "targetProbability": sum(
                        probability for move, probability in zip(legal, probabilities) if move in optimal
                    ),
                }
            )
    result = aggregate_rows(rows)
    result["checkpoint"] = str(Path(checkpoint).resolve())
    result["checkpointMeta"] = checkpoint_meta
    result["rows"] = rows
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--positions", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    records = [json.loads(line) for line in Path(args.positions).read_text(encoding="utf-8").splitlines() if line]
    result = evaluate(records, args.checkpoint)
    _atomic_json(Path(args.out), result)
    print(json.dumps({key: value for key, value in result.items() if key != "rows"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
