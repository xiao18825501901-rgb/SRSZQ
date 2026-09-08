"""Value calibration: Brier / LogLoss / ECE of the value head vs realized
outcome vectors, split by board size and seat.

Data source: replay samples (outcome vectors are stored per sample) or an
evaluation games JSONL (fresh state -> outcome records). For final acceptance
use fresh evaluation games; replay-based numbers are in-sample and labeled as
such. Calibration data is NEVER counted as formal training episodes.
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
from model import encode
from training.audit_training_state import _atomic_json

CANVAS = 17
BINS = 10


def rebuild_state(sample: dict[str, Any]) -> dict[str, Any]:
    size = int(sample["size"])
    state = srszq.create_state(size)
    for r in range(size):
        row = sample["board"][r]
        for c in range(size):
            cell = row[c]
            state["board"][r][c] = cell if cell != "." else None
    state["turn"] = int(sample["turn"])
    state["moves"] = int(sample["turn"])
    return state


def load_replay_samples(replay_dir: str, cap: int, seed: int) -> list[dict[str, Any]]:
    shards = sorted(Path(replay_dir).glob("shard_*.jsonl"))
    samples: list[dict[str, Any]] = []
    for shard in shards:
        with shard.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and line.startswith("{"):
                    samples.append(json.loads(line))
    rng = random.Random(seed)
    rng.shuffle(samples)
    return samples[:cap]


def ece_top_label(confidences: np.ndarray, correct: np.ndarray, bins: int = BINS) -> float:
    """Standard top-label ECE: bin by the model's confidence in its predicted
    class, then compare per-bin mean confidence with empirical accuracy."""
    edges = np.linspace(0.0, 1.0, bins + 1)
    ece = 0.0
    total = len(correct)
    for index in range(bins):
        low, high = edges[index], edges[index + 1]
        mask = (confidences >= low) & (confidences < (high if index < bins - 1 else high + 1e-9))
        if not mask.any():
            continue
        confidence = float(np.mean(confidences[mask]))
        accuracy = float(np.mean(correct[mask]))
        ece += (len(correct[mask]) / total) * abs(confidence - accuracy)
    return ece


def calibrate(
    net: torch.nn.Module,
    device: torch.device,
    samples: list[dict[str, Any]],
    batch_size: int = 512,
) -> dict[str, Any]:
    net.eval()
    groups: dict[tuple[str, str], list[tuple[float, float, float, float]]] = {}
    for start in range(0, len(samples), batch_size):
        batch = samples[start:start + batch_size]
        planes = np.asarray([encode.encode_state(rebuild_state(sample)) for sample in batch], dtype=np.float32)
        with torch.inference_mode():
            logits, log_values = net(torch.from_numpy(planes).to(device))
        values = torch.softmax(log_values, dim=1).detach().float().cpu().numpy()
        for sample, value in zip(batch, values):
            outcome = sample["outcome"]
            label = int(np.argmax(outcome))
            prob_true = float(value[label])
            top = int(np.argmax(value))
            conf_top = float(value[top])
            correct = 1.0 if top == label else 0.0
            brier = float(np.mean((value - np.asarray(outcome, dtype=np.float32)) ** 2))
            key = (str(sample["size"]), str(sample.get("actor", "?")))
            groups.setdefault(key, []).append((prob_true, brier, conf_top, correct))

    summaries: list[dict[str, Any]] = []
    for (board_size, actor), rows in sorted(groups.items()):
        probabilities = np.asarray([row[0] for row in rows])
        briers = [row[1] for row in rows]
        confidences = np.asarray([row[2] for row in rows])
        correct = np.asarray([row[3] for row in rows])
        loglosses = [-math.log(max(p, 1e-9)) for p in probabilities]
        ece = ece_top_label(confidences, correct)
        summaries.append({
            "boardSize": int(board_size),
            "actor": actor,
            "samples": len(rows),
            "brierMean": round(float(np.mean(briers)), 6),
            "logLossMean": round(float(np.mean(loglosses)), 6),
            "ece": round(ece, 6),
        })
    return {"groups": summaries, "totalSamples": len(samples)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--replay-dir", default="", help="replay shards (in-sample)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-samples", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=20260908)
    args = parser.parse_args()
    return args


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("calibration requires CUDA")
    device = torch.device("cuda")
    if not args.replay_dir:
        raise RuntimeError("--replay-dir is required (evaluation-games source planned for final acceptance)")
    samples = load_replay_samples(args.replay_dir, args.max_samples, args.seed)
    if not samples:
        raise RuntimeError("no replay samples found")
    net, meta = load_checkpoint_network(args.checkpoint, device)
    started = time.monotonic()
    result = calibrate(net, device, samples)
    result["checkpoint"] = str(Path(args.checkpoint).resolve())
    result["checkpointMeta"] = meta
    result["inSample"] = True
    result["elapsedSeconds"] = round(time.monotonic() - started, 3)
    result["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _atomic_json(Path(args.out), result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
