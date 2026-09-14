"""Replay value-target audit for Invitus Phase 4C.

The ledger terminal result is the authoritative game outcome. Replay samples
are selected with deterministic reservoir sampling, then their stored value
targets are compared with the target recomputed from that ledger result.
"""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path
from typing import Any

from training.audit_training_state import _atomic_json

WINNERS = ("A", "B", "C", "DRAW")


def target_for_result(result: str) -> tuple[float, float, float, float]:
    normalized = str(result).upper()
    if normalized in {"A", "A_WIN"}:
        return 1.0, 0.0, 0.0, 0.0
    if normalized in {"B", "B_WIN"}:
        return 0.0, 1.0, 0.0, 0.0
    if normalized in {"C", "C_WIN"}:
        return 0.0, 0.0, 1.0, 0.0
    if normalized == "DRAW":
        return 0.0, 0.0, 0.0, 1.0
    raise ValueError(f"unknown terminal result: {result!r}")


def winner_for_result(result: str) -> str:
    return WINNERS[target_for_result(result).index(1.0)]


def stage_for_sample(sample: dict[str, Any]) -> str:
    """Occupancy-normalized stage: first/middle/final third of board capacity."""
    size = int(sample["size"])
    fraction = int(sample["turn"]) / max(1, size * size)
    if fraction < 1.0 / 3.0:
        return "early"
    if fraction < 2.0 / 3.0:
        return "mid"
    return "late"


def _ledger_results(root: Path) -> tuple[dict[str, str], int]:
    path = root / "logs" / "INVICTUS_TRAINING_LEDGER.jsonl"
    if not path.exists():
        raise FileNotFoundError(f"ledger not found: {path}")
    results: dict[str, str] = {}
    conflicts = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            game_id = record.get("game_id")
            result = record.get("terminal_result") or record.get("result")
            if not game_id or not result:
                continue
            previous = results.get(str(game_id))
            if previous is not None and previous != result:
                conflicts += 1
            results[str(game_id)] = str(result)
    return results, conflicts


def _reservoir_samples(root: Path, cap: int, seed: int) -> tuple[list[dict[str, Any]], int]:
    rng = random.Random(seed)
    reservoir: list[dict[str, Any]] = []
    seen = 0
    for shard in sorted((root / "replay").glob("shard_*.jsonl")):
        with shard.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                sample = json.loads(line)
                seen += 1
                if len(reservoir) < cap:
                    reservoir.append(sample)
                else:
                    index = rng.randrange(seen)
                    if index < cap:
                        reservoir[index] = sample
    return reservoir, seen


def audit_run(root: str | Path, cap: int, seed: int) -> dict[str, Any]:
    run_root = Path(root).resolve()
    ledger, ledger_conflicts = _ledger_results(run_root)
    samples, replay_samples_seen = _reservoir_samples(run_root, cap, seed)
    winner_distribution = {winner: 0 for winner in WINNERS}
    actor_by_winner = {actor: {winner: 0 for winner in WINNERS} for actor in "ABC"}
    board_by_winner = {size: {winner: 0 for winner in WINNERS} for size in ("13", "17")}
    stage_by_winner = {stage: {winner: 0 for winner in WINNERS} for stage in ("early", "mid", "late")}
    mismatches = missing_ledger = malformed = 0
    mismatch_examples: list[dict[str, Any]] = []

    for sample in samples:
        game_id = str(sample.get("game_id", ""))
        result = ledger.get(game_id)
        if result is None:
            missing_ledger += 1
            continue
        try:
            expected = target_for_result(result)
            stored = tuple(float(value) for value in sample["outcome"])
            actor = str(sample["actor"])
            board_size = str(int(sample["size"]))
            if actor not in actor_by_winner or board_size not in board_by_winner or len(stored) != 4:
                raise ValueError("invalid actor, board size, or target width")
        except (KeyError, TypeError, ValueError):
            malformed += 1
            continue
        winner = winner_for_result(result)
        winner_distribution[winner] += 1
        actor_by_winner[actor][winner] += 1
        board_by_winner[board_size][winner] += 1
        stage_by_winner[stage_for_sample(sample)][winner] += 1
        if stored != expected:
            mismatches += 1
            if len(mismatch_examples) < 20:
                mismatch_examples.append(
                    {"gameId": game_id, "stored": list(stored), "recomputed": list(expected)}
                )

    return {
        "root": str(run_root),
        "seed": seed,
        "requested": cap,
        "sampled": len(samples),
        "replaySamplesSeen": replay_samples_seen,
        "ledgerGames": len(ledger),
        "ledgerConflicts": ledger_conflicts,
        "missingLedger": missing_ledger,
        "malformed": malformed,
        "mismatches": mismatches,
        "mismatchExamples": mismatch_examples,
        "winnerDistribution": winner_distribution,
        "actorByWinner": actor_by_winner,
        "boardByWinner": board_by_winner,
        "stageByWinner": stage_by_winner,
        "pass": (
            len(samples) == cap
            and ledger_conflicts == 0
            and missing_ledger == 0
            and malformed == 0
            and mismatches == 0
        ),
    }


def parse_run(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("run must use LABEL=PATH")
    label, path = value.split("=", 1)
    if not label or not path:
        raise argparse.ArgumentTypeError("run must use LABEL=PATH")
    return label, Path(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="append", type=parse_run, required=True)
    parser.add_argument("--samples-per-run", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=20260914)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.samples_per_run < 1:
        parser.error("samples-per-run must be positive")

    runs = {
        label: audit_run(path, args.samples_per_run, args.seed + index)
        for index, (label, path) in enumerate(args.run)
    }
    total_sampled = sum(run["sampled"] for run in runs.values())
    result = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runs": runs,
        "totalSampled": total_sampled,
        "totalMismatches": sum(run["mismatches"] for run in runs.values()),
        "pass": total_sampled >= 10_000 and all(run["pass"] for run in runs.values()),
    }
    _atomic_json(Path(args.out), result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
