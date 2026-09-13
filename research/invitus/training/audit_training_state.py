"""Reconcile Invitus ledger, checkpoint, replay, progress, and manifest evidence.

The script never trusts checkpoint filenames. A resumable formal count is the
largest checkpoint counter whose corresponding ledger game is still present in
the retained replay window. Raw ledger progress remains visible separately so
an uncheckpointed tail cannot silently inflate the recovery counter.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch


def _as_int(value: Any, default: int = -1) -> int:
    try:
        if hasattr(value, "item"):
            value = value.item()
        return int(value)
    except (TypeError, ValueError):
        return default


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _optimizer_step(checkpoint: dict[str, Any]) -> int:
    steps = []
    for state in checkpoint.get("opt", {}).get("state", {}).values():
        if isinstance(state, dict) and "step" in state:
            steps.append(_as_int(state["step"], 0))
    return max(steps, default=0)


def _seat_counts(records: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter({"A": 0, "B": 0, "C": 0})
    for record in records:
        assignments = record.get("seat_assignments")
        if isinstance(assignments, str):
            agents = assignments.split("-")
            for seat, agent in zip("ABC", agents):
                if agent.startswith("invitus"):
                    counts[seat] += 1
        elif isinstance(assignments, dict):
            for seat in "ABC":
                agent = assignments.get(seat)
                if isinstance(agent, (list, tuple)):
                    agent = agent[0] if agent else None
                if isinstance(agent, str) and agent.startswith("invitus"):
                    counts[seat] += 1
    return {seat: counts[seat] for seat in "ABC"}


def _read_ledger(path: Path, record_kind: str = "formal") -> dict[str, Any]:
    valid: list[dict[str, Any]] = []
    seen: set[str] = set()
    duplicates = invalid = excluded = rows = 0
    parse_errors: list[str] = []
    if not path.exists():
        return {
            "records": valid,
            "rows": rows,
            "duplicates": duplicates,
            "invalid": invalid,
            "excluded": excluded,
            "parseErrors": ["ledger file is missing"],
        }
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            rows += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                invalid += 1
                parse_errors.append(f"line {line_number}: {error.msg}")
                continue
            if record.get("kind") != record_kind:
                excluded += 1
                continue
            game_id = record.get("game_id")
            is_valid = (
                record.get("completed") is True
                and isinstance(game_id, str)
                and bool(game_id)
                and _as_int(record.get("num_samples"), 0) > 0
            )
            if not is_valid:
                invalid += 1
                continue
            if game_id in seen:
                duplicates += 1
                continue
            seen.add(game_id)
            valid.append(record)
    return {
        "records": valid,
        "rows": rows,
        "duplicates": duplicates,
        "invalid": invalid,
        "excluded": excluded,
        "parseErrors": parse_errors,
    }


def _read_replay(replay_dir: Path, episode_by_game: dict[str, int]) -> dict[str, Any]:
    shards = sorted(replay_dir.glob("shard_*.jsonl")) if replay_dir.exists() else []
    game_ids: set[str] = set()
    samples = invalid = 0
    parse_errors: list[str] = []
    for shard in shards:
        with shard.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    sample = json.loads(line)
                except json.JSONDecodeError as error:
                    invalid += 1
                    parse_errors.append(f"{shard.name}:{line_number}: {error.msg}")
                    continue
                samples += 1
                game_id = sample.get("game_id")
                if isinstance(game_id, str) and game_id:
                    game_ids.add(game_id)
                else:
                    invalid += 1
    covered_episodes = sorted(episode_by_game[game_id] for game_id in game_ids if game_id in episode_by_game)
    return {
        "shards": shards,
        "samples": samples,
        "invalid": invalid,
        "gameIds": game_ids,
        "coveredEpisodes": covered_episodes,
        "parseErrors": parse_errors,
    }


def _read_checkpoints(checkpoint_dir: Path, ledger_count: int) -> tuple[list[dict[str, Any]], dict[str, str]]:
    checkpoints: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    for path in sorted(checkpoint_dir.glob("*.pt")) if checkpoint_dir.exists() else []:
        try:
            checkpoint = torch.load(path, map_location="cpu", weights_only=False)
            counter = _as_int(checkpoint.get("counter"))
            if counter < 0:
                raise ValueError("missing or invalid embedded counter")
            cfg = checkpoint.get("cfg") if isinstance(checkpoint.get("cfg"), dict) else {}
            checkpoints.append(
                {
                    "path": path,
                    "relativePath": f"checkpoints/{path.name}",
                    "counter": counter,
                    "optimizerStep": _optimizer_step(checkpoint),
                    "schedulerStep": _as_int(checkpoint.get("sched", {}).get("last_epoch"), 0),
                    "rngStatePresent": checkpoint.get("rng") is not None,
                    "modelConfig": {
                        "name": checkpoint.get("net"),
                        "channels": cfg.get("channels"),
                        "blocks": cfg.get("blocks"),
                    },
                    "sha256": _sha256(path),
                    "mtime": path.stat().st_mtime,
                    "withinLedger": counter <= ledger_count,
                }
            )
        except Exception as error:
            errors[path.name] = str(error).splitlines()[0][:240]
    return checkpoints, errors


def _read_progress(path: Path) -> tuple[int | None, str | None]:
    if not path.exists():
        return None, "progress file is missing"
    try:
        progress = json.loads(path.read_text(encoding="utf-8"))
        counter = _as_int(progress.get("counter"))
        if counter < 0:
            return None, "progress counter is missing or invalid"
        return counter, None
    except Exception as error:
        return None, str(error).splitlines()[0][:240]


def _detect_git_sha(root: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-c", "safe.directory=*", "rev-parse", "HEAD"],
            cwd=root,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return "unknown"


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp")
    temp_path = Path(handle.name)
    try:
        with handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def audit_training_state(
    root: str | Path,
    git_sha: str | None = None,
    write_manifest: bool = True,
    record_kind: str = "formal",
) -> dict[str, Any]:
    root = Path(root).resolve()
    if record_kind not in {"formal", "experiment"}:
        raise ValueError(f"unsupported record kind: {record_kind}")
    ledger = _read_ledger(root / "logs" / "INVICTUS_TRAINING_LEDGER.jsonl", record_kind)
    records = ledger["records"]
    episode_by_game = {record["game_id"]: index for index, record in enumerate(records, 1)}
    replay = _read_replay(root / "replay", episode_by_game)
    checkpoints, checkpoint_errors = _read_checkpoints(root / "checkpoints", len(records))
    valid_checkpoints = [checkpoint for checkpoint in checkpoints if checkpoint["withinLedger"]]
    latest_valid = max(valid_checkpoints, key=lambda item: (item["counter"], item["mtime"]), default=None)
    supported = [
        checkpoint
        for checkpoint in valid_checkpoints
        if checkpoint["counter"] > 0 and records[checkpoint["counter"] - 1]["game_id"] in replay["gameIds"]
    ]
    latest_supported = max(supported, key=lambda item: (item["counter"], item["mtime"]), default=None)
    formal_episodes = latest_supported["counter"] if latest_supported else 0
    progress_counter, progress_error = _read_progress(root / "logs" / "progress.json")

    consistency_errors: list[str] = []
    if ledger["duplicates"]:
        consistency_errors.append(f"ledger has {ledger['duplicates']} duplicate game_id records")
    if ledger["invalid"]:
        consistency_errors.append(f"ledger has {ledger['invalid']} invalid {record_kind} rows")
    if ledger["parseErrors"]:
        consistency_errors.append("ledger contains JSON parse errors")
    if replay["invalid"] or replay["parseErrors"]:
        consistency_errors.append("replay contains invalid samples or JSON parse errors")
    if checkpoint_errors:
        consistency_errors.append("one or more checkpoints could not be loaded")
    if latest_valid is None:
        consistency_errors.append("no loadable checkpoint is supported by the ledger")
    else:
        checkpoint_counter = latest_valid["counter"]
        if checkpoint_counter != len(records):
            consistency_errors.append(f"ledger episode {len(records)} is ahead of checkpoint episode {checkpoint_counter}")
        if checkpoint_counter > 0 and records[checkpoint_counter - 1]["game_id"] not in replay["gameIds"]:
            consistency_errors.append(f"checkpoint episode {checkpoint_counter} is absent from retained replay")
        if progress_counter != checkpoint_counter:
            consistency_errors.append(
                f"progress episode {progress_counter} does not match checkpoint episode {checkpoint_counter}"
            )
    if progress_error:
        consistency_errors.append(progress_error)

    verified_records = records[:formal_episodes]
    raw_board_counts = Counter(str(record.get("board_size")) for record in records)
    board_counts = Counter(str(record.get("board_size")) for record in verified_records)
    latest_record = verified_records[-1] if verified_records else None
    raw_latest_record = records[-1] if records else None

    state: dict[str, Any] = {
        "recordKind": record_kind,
        "episodeCount": formal_episodes,
        "ledgerEpisodeCount": len(records),
        "formalEpisodes": formal_episodes if record_kind == "formal" else 0,
        "ledgerFormalEpisodes": len(records) if record_kind == "formal" else 0,
        "latestCheckpoint": latest_valid["relativePath"] if latest_valid else None,
        "latestConsistentCheckpoint": latest_supported["relativePath"] if latest_supported else None,
        "latestGameId": latest_record.get("game_id") if latest_record else None,
        "rawLatestGameId": raw_latest_record.get("game_id") if raw_latest_record else None,
        "checkpointEpisodeCount": latest_valid["counter"] if latest_valid else None,
        "progressEpisodeCount": progress_counter,
        "optimizerStep": latest_valid["optimizerStep"] if latest_valid else None,
        "schedulerStep": latest_valid["schedulerStep"] if latest_valid else None,
        "replayChunkCount": len(replay["shards"]),
        "replaySampleCount": replay["samples"],
        "replayGameCount": len([game_id for game_id in replay["gameIds"] if game_id in episode_by_game]),
        "replayFormalGameCount": (
            len([game_id for game_id in replay["gameIds"] if game_id in episode_by_game])
            if record_kind == "formal"
            else 0
        ),
        "replayMinEpisode": min(replay["coveredEpisodes"], default=None),
        "replayMaxEpisode": max(replay["coveredEpisodes"], default=None),
        "boardCounts": {"13": board_counts["13"], "17": board_counts["17"]},
        "rawBoardCounts": {"13": raw_board_counts["13"], "17": raw_board_counts["17"]},
        "seatCounts": _seat_counts(verified_records),
        "rawSeatCounts": _seat_counts(records),
        "modelConfig": latest_valid["modelConfig"] if latest_valid else None,
        "gitSha": git_sha or _detect_git_sha(root),
        "rngStatePresent": latest_valid["rngStatePresent"] if latest_valid else False,
        "checkpointSha256": latest_valid["sha256"] if latest_valid else None,
        "ledgerRows": ledger["rows"],
        "duplicateGameIds": ledger["duplicates"],
        "invalidLedgerRows": ledger["invalid"],
        "excludedLedgerRows": ledger["excluded"],
        "checkpointErrors": checkpoint_errors,
        "consistencyErrors": consistency_errors,
        "stateConsistent": not consistency_errors,
        "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if write_manifest:
        _atomic_json(root / "training_state.json", state)
    return state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--git-sha", default=None)
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--record-kind", choices=("formal", "experiment"), default="formal")
    args = parser.parse_args()
    state = audit_training_state(
        args.root,
        git_sha=args.git_sha,
        write_manifest=not args.no_write,
        record_kind=args.record_kind,
    )
    print(json.dumps(state, ensure_ascii=False, indent=2))
    print(f"RECORD_KIND={state['recordKind']}")
    print(f"LEDGER_EPISODE_COUNT={state['ledgerEpisodeCount']}")
    print(f"FORMAL_LEDGER_COUNT={state['ledgerFormalEpisodes']}")
    print(f"LATEST_VALID_CHECKPOINT={state['latestCheckpoint']}")
    print(f"CHECKPOINT_EPISODE_COUNT={state['checkpointEpisodeCount']}")
    print(f"REPLAY_MAX_EPISODE={state['replayMaxEpisode']}")
    print(f"OPTIMIZER_STEP={state['optimizerStep']}")
    print(f"STATE_CONSISTENT={str(state['stateConsistent']).lower()}")
    return 0 if state["stateConsistent"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
