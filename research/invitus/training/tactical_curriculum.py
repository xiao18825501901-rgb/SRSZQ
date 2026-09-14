"""Offline controlled T0/T10/T20 tactical curriculum ablation.

Every arm starts from the same checkpoint and samples from the same frozen
self-play replay pool.  The optimizer-step count and batch size stay fixed;
only the fraction replaced by policy-supervised tactical records changes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import time
from pathlib import Path
from typing import Any

import torch
import numpy as np

from model.network import InvitusNet
from training.replay import ReplayBuffer
from training.train import train_batch


def curriculum_batch_counts(batch_size: int, tactical_ratio: float) -> tuple[int, int]:
    if batch_size < 1 or not 0.0 <= tactical_ratio <= 1.0:
        raise ValueError("invalid batch size or tactical ratio")
    tactical = int(round(batch_size * tactical_ratio))
    return batch_size - tactical, tactical


def tactical_record_to_sample(record: dict[str, Any]) -> dict[str, Any]:
    state = record["state"]
    return {
        "board": list(state["board"]),
        "turn": int(state["turn"]),
        "size": int(state["size"]),
        "actor": record["actor"],
        "legal": [list(move) for move in record["legalMoves"]],
        "visits": {key: float(value) for key, value in record["policyTarget"].items()},
        "outcome": record.get("outcome"),
        "value_loss_mask": int(record.get("valueLossMask", 0)),
        "game_id": f"tactical:{record['positionHash']}",
        "cp": "tactical-curriculum",
        "tactical_category": record["category"],
        "canonical": record["canonical"],
    }


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def verify_dataset_file(path: Path, expected_split: str) -> dict[str, Any]:
    manifest_path = path.with_suffix(path.suffix + ".manifest.json")
    if not manifest_path.is_file():
        raise RuntimeError(f"missing tactical dataset manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if manifest.get("split") != expected_split or manifest.get("sha256") != digest:
        raise RuntimeError(f"tactical dataset identity mismatch: {path}")
    return manifest


def load_tactical_dataset(training_path: Path, evaluation_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    train_manifest = verify_dataset_file(training_path, "train")
    eval_manifest = verify_dataset_file(evaluation_path, "eval")
    evaluation_canonicals = {row["canonical"] for row in _load_jsonl(evaluation_path)}
    training_records = _load_jsonl(training_path)
    overlap = evaluation_canonicals & {row["canonical"] for row in training_records}
    if overlap:
        raise RuntimeError(f"tactical train/eval leakage: {len(overlap)} canonical positions")
    return training_records, {
        "trainingSha256": train_manifest["sha256"],
        "evaluationSha256": eval_manifest["sha256"],
        "canonicalOverlap": len(overlap),
    }


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def _load_replay(path: Path) -> list[dict[str, Any]]:
    replay = ReplayBuffer(path)
    return list(replay.iter_samples(replay.shards()))


def run_curriculum(
    checkpoint_path: Path,
    replay_dir: Path,
    tactical_path: Path,
    evaluation_path: Path,
    output_path: Path,
    ratio: float,
    steps: int,
    batch_size: int,
    seed: int,
) -> dict[str, Any]:
    if not torch.cuda.is_available():
        raise RuntimeError("tactical curriculum requires CUDA")
    tactical_records, dataset_identity = load_tactical_dataset(tactical_path, evaluation_path)
    _seed_everything(seed)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    cfg = dict(checkpoint.get("cfg") or {})
    representation = str(cfg.get("value_representation", "absolute"))
    value_loss = str(cfg.get("value_loss", "ce"))
    device = torch.device("cuda")
    net = InvitusNet(
        int(cfg["channels"]), int(cfg["blocks"]), value_representation=representation
    ).to(device)
    net.load_state_dict(checkpoint["model"])
    optimizer = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    if checkpoint.get("opt"):
        optimizer.load_state_dict(checkpoint["opt"])

    selfplay = _load_replay(replay_dir)
    tactical = [tactical_record_to_sample(row) for row in tactical_records]
    if not selfplay or (ratio > 0 and not tactical):
        raise RuntimeError("curriculum inputs are empty")
    selfplay_count, tactical_count = curriculum_batch_counts(batch_size, ratio)
    selfplay_rng = random.Random(seed)
    tactical_rng = random.Random(seed + 1_000_003)
    metrics: list[dict[str, float]] = []
    started = time.monotonic()
    for step in range(steps):
        batch = [selfplay[selfplay_rng.randrange(len(selfplay))] for _ in range(selfplay_count)]
        batch.extend(tactical[tactical_rng.randrange(len(tactical))] for _ in range(tactical_count))
        policy_loss, value_loss_value, loss, gradient_norm, entropy = train_batch(
            net,
            device,
            optimizer,
            batch,
            entropy_weight=float(cfg.get("entropy_weight", 0.05)),
            target_tau=float(cfg.get("target_tau", 2.0)),
            value_smooth=float(cfg.get("value_smooth", 0.0)),
            value_representation=representation,
            value_loss_type=value_loss,
        )
        metrics.append(
            {
                "step": step + 1,
                "policyLoss": policy_loss,
                "valueLoss": value_loss_value,
                "loss": loss,
                "gradientNorm": gradient_norm,
                "policyEntropy": entropy,
            }
        )

    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_cfg = {**cfg, "tactical_ratio": ratio, "tactical_steps": steps, "tactical_seed": seed}
    result = {
        "sourceCheckpoint": str(checkpoint_path.resolve()),
        "sourceCounter": int(checkpoint.get("counter", -1)),
        "selfplayReplay": str(replay_dir.resolve()),
        "tacticalDataset": str(tactical_path.resolve()),
        "tacticalDatasetSha256": dataset_identity["trainingSha256"],
        "evaluationDataset": str(evaluation_path.resolve()),
        "evaluationDatasetSha256": dataset_identity["evaluationSha256"],
        "canonicalOverlap": dataset_identity["canonicalOverlap"],
        "ratio": ratio,
        "steps": steps,
        "batchSize": batch_size,
        "selfplayPerBatch": selfplay_count,
        "tacticalPerBatch": tactical_count,
        "selfplayPoolSize": len(selfplay),
        "tacticalPoolSize": len(tactical),
        "seed": seed,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "finalMetrics": metrics[-1],
        "meanPolicyLoss": sum(row["policyLoss"] for row in metrics) / len(metrics),
        "meanValueLoss": sum(row["valueLoss"] for row in metrics) / len(metrics),
    }
    tmp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    torch.save(
        {
            "model": net.state_dict(),
            "opt": optimizer.state_dict(),
            "counter": int(checkpoint.get("counter", -1)),
            "cfg": output_cfg,
            "extra": {"tacticalCurriculum": result},
            "net": checkpoint.get("net", "Small"),
        },
        tmp_path,
    )
    os.replace(tmp_path, output_path)
    output_path.with_suffix(output_path.suffix + ".json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--replay-dir", required=True)
    parser.add_argument("--tactical-dataset", required=True)
    parser.add_argument("--evaluation-dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ratio", type=float, required=True)
    parser.add_argument("--steps", type=int, default=200)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--seed", type=int, default=20260960)
    args = parser.parse_args()
    result = run_curriculum(
        Path(args.checkpoint), Path(args.replay_dir), Path(args.tactical_dataset), Path(args.evaluation_dataset),
        Path(args.out), args.ratio, args.steps, args.batch, args.seed,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
