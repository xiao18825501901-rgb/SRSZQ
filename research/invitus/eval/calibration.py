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
from model.value import output_to_absolute
from training.audit_training_state import _atomic_json
from eval.value_target_rca import stage_for_sample

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


def _rounded_vector(values: np.ndarray) -> list[float]:
    return [round(float(value), 6) for value in values.tolist()]


def summarize_group(values: np.ndarray, outcomes: np.ndarray, bins: int = BINS) -> dict[str, Any]:
    labels = np.argmax(outcomes, axis=1)
    top = np.argmax(values, axis=1)
    confidences = values[np.arange(len(values)), top]
    correct = (top == labels).astype(np.float32)
    true_probabilities = values[np.arange(len(values)), labels]
    brier = np.mean((values - outcomes) ** 2, axis=1)
    reliability: list[dict[str, Any]] = []
    edges = np.linspace(0.0, 1.0, bins + 1)
    for index in range(bins):
        low, high = float(edges[index]), float(edges[index + 1])
        mask = (confidences >= low) & (
            confidences < (high if index < bins - 1 else high + 1e-9)
        )
        count = int(mask.sum())
        reliability.append({
            "low": round(low, 3),
            "high": round(high, 3),
            "count": count,
            "meanConfidence": round(float(confidences[mask].mean()), 6) if count else None,
            "accuracy": round(float(correct[mask].mean()), 6) if count else None,
            "predictedMean": _rounded_vector(values[mask].mean(axis=0)) if count else None,
            "empiricalOutcome": _rounded_vector(outcomes[mask].mean(axis=0)) if count else None,
        })
    predicted = values.mean(axis=0)
    empirical = outcomes.mean(axis=0)
    return {
        "samples": len(values),
        "brierMean": round(float(brier.mean()), 6),
        "logLossMean": round(float(np.mean(-np.log(np.maximum(true_probabilities, 1e-9)))), 6),
        "ece": round(ece_top_label(confidences, correct, bins), 6),
        "predictedMean": _rounded_vector(predicted),
        "empiricalOutcome": _rounded_vector(empirical),
        "calibrationResidual": _rounded_vector(predicted - empirical),
        "meanAbsoluteResidual": round(float(np.mean(np.abs(predicted - empirical))), 6),
        "reliabilityBins": reliability,
    }


def _group_summaries(rows: list[dict[str, Any]], fields: tuple[str, ...]) -> list[dict[str, Any]]:
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(tuple(row[field] for field in fields), []).append(row)
    summaries: list[dict[str, Any]] = []
    for key, group in sorted(groups.items()):
        values = np.asarray([row["value"] for row in group], dtype=np.float32)
        outcomes = np.asarray([row["outcome"] for row in group], dtype=np.float32)
        identity = dict(zip(fields, key))
        summaries.append({**identity, **summarize_group(values, outcomes)})
    return summaries


def calibrate(
    net: torch.nn.Module,
    device: torch.device,
    samples: list[dict[str, Any]],
    batch_size: int = 512,
) -> dict[str, Any]:
    net.eval()
    rows: list[dict[str, Any]] = []
    representation = getattr(net, "value_representation", "absolute")
    for start in range(0, len(samples), batch_size):
        batch = samples[start:start + batch_size]
        planes = np.asarray([encode.encode_state(rebuild_state(sample)) for sample in batch], dtype=np.float32)
        with torch.inference_mode():
            logits, log_values = net(torch.from_numpy(planes).to(device))
        raw_values = torch.softmax(log_values, dim=1).detach().float().cpu().numpy()
        for sample, raw_value in zip(batch, raw_values):
            actor = str(sample.get("actor", "?"))
            value = output_to_absolute(raw_value, actor, representation)
            rows.append({
                "boardSize": int(sample["size"]),
                "actor": actor,
                "stage": stage_for_sample(sample),
                "value": value,
                "outcome": tuple(float(component) for component in sample["outcome"]),
            })

    values = np.asarray([row["value"] for row in rows], dtype=np.float32)
    outcomes = np.asarray([row["outcome"] for row in rows], dtype=np.float32)
    by_board_actor = _group_summaries(rows, ("boardSize", "actor"))
    return {
        "totalSamples": len(rows),
        "valueRepresentation": representation,
        "overall": summarize_group(values, outcomes),
        "byBoard": _group_summaries(rows, ("boardSize",)),
        "byActor": _group_summaries(rows, ("actor",)),
        "byStage": _group_summaries(rows, ("stage",)),
        "byBoardAndActor": by_board_actor,
        "byBoardAndStage": _group_summaries(rows, ("boardSize", "stage")),
        "byActorAndStage": _group_summaries(rows, ("actor", "stage")),
        "byBoardActorStage": _group_summaries(rows, ("boardSize", "actor", "stage")),
        "groups": by_board_actor,
    }


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
