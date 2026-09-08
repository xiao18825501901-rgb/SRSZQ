"""Exact oracle generation: harvest legal endgame positions from replay tails
and solve them exhaustively with the exact MaxN solver.

Outputs one JSONL record per solved position (acceptance-criteria format):
state, legalMoves, exactBestMoves, exactOutcomeVector, actor, boardSize,
remainingMoves, nodes, solveTime. Solver draw vectors (1/3,1/3,1/3,0) are
converted to the training outcome convention [0,0,0,1].

Oracle data is evaluation evidence only; it is NEVER counted as formal games.
"""
from __future__ import annotations

import argparse
import copy
import json
import random
import time
from pathlib import Path
from typing import Any

from engine import srszq
from exact.solver import ExactSolver, canonical_key

ACTOR_INDEX = {"A": 0, "B": 1, "C": 2}


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


def harvest_replay_tails(
    replay_dir: str,
    per_game_tail: int,
    max_branch: int,
    rng: random.Random,
) -> list[tuple[str, dict[str, Any]]]:
    """Group replay samples by game and keep the last per_game_tail samples of each game."""
    shards = sorted(Path(replay_dir).glob("shard_*.jsonl"))
    games: dict[str, list[dict[str, Any]]] = {}
    for shard in shards:
        with shard.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                sample = json.loads(line)
                games.setdefault(sample["game_id"], []).append(sample)
    candidates: list[tuple[str, dict[str, Any]]] = []
    for game_id, samples in games.items():
        for sample in samples[-per_game_tail:]:
            legal = sample.get("legal") or []
            if 0 < len(legal) <= max_branch:
                candidates.append((game_id, sample))
    rng.shuffle(candidates)
    return candidates


def solve_position(sample: dict[str, Any], max_branch: int) -> dict[str, Any] | None:
    state = rebuild_state(sample)
    legal = srszq.legal_moves(state)
    if not legal or len(legal) > max_branch:
        return None
    actor = srszq.current_player(state)
    actor_index = ACTOR_INDEX[actor]
    solver = ExactSolver(max_branch=max_branch)
    started = time.monotonic()
    best_move, best_vector = solver.best_move(state)
    solve_seconds = time.monotonic() - started
    # Collect every move whose child outcome equals the best vector.
    best_moves: list[list[int]] = []
    for (row, col) in legal:
        child = copy.deepcopy(state)
        srszq.apply_move(child, row, col)
        child_vector = solver.solve(child)
        if child_vector == best_vector:
            best_moves.append([row, col])
    outcome = list(best_vector)
    if best_vector == (1 / 3, 1 / 3, 1 / 3, 0.0):
        outcome = [0.0, 0.0, 0.0, 1.0]  # solver draw convention -> training convention
    return {
        "canonical": canonical_key(state),
        "state": {
            "board": [["." if cell is None else cell for cell in row] for row in state["board"]],
            "turn": state["turn"],
            "size": state["n"],
        },
        "boardSize": state["n"],
        "actor": actor,
        "legalMoves": [[row, col] for (row, col) in legal],
        "exactBestMoves": best_moves,
        "exactOutcomeVector": outcome,
        "exactRawVector": list(best_vector),
        "remainingMoves": len(legal),
        "nodes": solver.nodes,
        "solveTimeSec": round(solve_seconds, 4),
        "gameId": sample.get("game_id"),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay-dir", required=True)
    parser.add_argument("--out", required=True, help="oracle jsonl path")
    parser.add_argument("--per-game-tail", type=int, default=4)
    parser.add_argument("--max-branch", type=int, default=10)
    parser.add_argument("--max-positions", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20260908)
    args = parser.parse_args()
    if args.per_game_tail < 1 or args.max_branch < 1 or args.max_positions < 1:
        parser.error("per-game-tail, max-branch, max-positions must be positive")
    return args


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    candidates = harvest_replay_tails(args.replay_dir, args.per_game_tail, args.max_branch, rng)
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    written = skipped_dupes = failed = 0
    with out_path.open("w", encoding="utf-8") as handle:
        for game_id, sample in candidates:
            if written >= args.max_positions:
                break
            record = solve_position(sample, args.max_branch)
            if record is None:
                failed += 1
                continue
            if record["canonical"] in seen:
                skipped_dupes += 1
                continue
            seen.add(record["canonical"])
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            written += 1
    print(json.dumps({
        "event": "oracle_generated",
        "out": str(out_path),
        "candidates": len(candidates),
        "written": written,
        "skippedDuplicates": skipped_dupes,
        "failed": failed,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
