"""Exact oracle generation: two independent sources.

1. replay mode（默认）：从 replay 尾局采 legal<=max_branch 的样本。
2. synthetic mode（--synthetic）：随机合法对局（禁止直接获胜手）走至空位
   <=max_branch —— 保证 reachable / rule-consistent，不依赖对局深度。
   这对坍塌后的短局尤为重要（replay 里没有深尾局）。

记录（验收口径）：canonical、state、boardSize、actor、round、eligible、
legalMoves、exactBestMoves、exactOutcomeVector、remainingMoves、nodes、solveTimeSec。

Oracle 数据只用于评估，永不计 formal。
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
from exact.solver import ExactSolver, SolverBudgetExceeded, canonical_key

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


def solve_state_record(
    state: dict[str, Any], max_branch: int, game_id: str | None, max_nodes: int = 200_000
) -> dict[str, Any] | None:
    legal = srszq.legal_moves(state)
    if not legal or len(legal) > max_branch or state["status"] != "playing":
        return None
    actor = srszq.current_player(state)
    solver = ExactSolver(max_branch=max_branch, max_nodes=max_nodes)
    started = time.monotonic()
    try:
        best_move, best_vector = solver.best_move(state)
    except SolverBudgetExceeded:
        return None
    solve_seconds = time.monotonic() - started
    best_moves: list[list[int]] = []
    for (row, col) in legal:
        child = copy.deepcopy(state)
        srszq.apply_move(child, row, col)
        child_vector = solver.solve(child)
        if child_vector == best_vector:
            best_moves.append([row, col])
    outcome = list(best_vector)
    if best_vector == (1 / 3, 1 / 3, 1 / 3, 0.0):
        outcome = [0.0, 0.0, 0.0, 1.0]
    return {
        "canonical": canonical_key(state),
        "state": {
            "board": [["." if cell is None else cell for cell in row] for row in state["board"]],
            "turn": state["turn"],
            "size": state["n"],
        },
        "boardSize": state["n"],
        "actor": actor,
        "round": state["turn"] // 3 + 1,
        "eligible": srszq.eligible_of(state),
        "legalMoves": [[row, col] for (row, col) in legal],
        "exactBestMoves": best_moves,
        "exactOutcomeVector": outcome,
        "exactRawVector": list(best_vector),
        "remainingMoves": len(legal),
        "nodes": solver.nodes,
        "solveTimeSec": round(solve_seconds, 4),
        "gameId": game_id or "synthetic",
    }


def harvest_replay_tails(
    replay_dir: str,
    per_game_tail: int,
    max_branch: int,
    rng: random.Random,
) -> list[tuple[str, dict[str, Any]]]:
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


def synthetic_states(
    size: int,
    count: int,
    max_branch: int,
    rng: random.Random,
    max_attempts_per_state: int = 100,
) -> list[dict[str, Any]]:
    """随机合法对局走至空位<=max_branch（禁止直接获胜手），保证 reachable。
    用 creates_four_through 免 deepcopy 判定获胜手（性能关键）。"""
    states: list[dict[str, Any]] = []
    attempts = 0
    while len(states) < count and attempts < count * max_attempts_per_state:
        attempts += 1
        state = srszq.create_state(size)
        while True:
            legal = srszq.legal_moves(state)
            if not legal:
                break
            if len(legal) <= max_branch:
                break
            player = srszq.current_player(state)
            non_winning = [
                (r, c) for (r, c) in legal
                if not srszq.creates_four_through(state["board"], r, c, player)
            ]
            if not non_winning:
                break  # 任意着都赢 → 放弃此局重开
            (r, c) = rng.choice(non_winning)
            srszq.apply_move(state, r, c)
        if state["status"] == "playing" and 0 < len(srszq.legal_moves(state)) <= max_branch:
            states.append(state)
    return states


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay-dir", default="")
    parser.add_argument("--out", required=True, help="oracle jsonl path")
    parser.add_argument("--per-game-tail", type=int, default=4)
    parser.add_argument("--max-branch", type=int, default=10)
    parser.add_argument("--max-positions", type=int, default=200)
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--synthetic-sizes", default="13,17")
    parser.add_argument("--seed", type=int, default=20260908)
    args = parser.parse_args()
    if not args.synthetic and not args.replay_dir:
        parser.error("either --replay-dir or --synthetic is required")
    return args


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    written = skipped = failed = 0
    with out_path.open("w", encoding="utf-8") as handle:
        def emit(state: dict[str, Any], game_id: str | None) -> bool:
            nonlocal written, skipped, failed
            record = solve_state_record(state, args.max_branch, game_id)
            if record is None:
                failed += 1
                return False
            if record["canonical"] in seen:
                skipped += 1
                return False
            seen.add(record["canonical"])
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            written += 1
            return True

        if args.synthetic:
            sizes = [int(x) for x in args.synthetic_sizes.split(",") if x.strip()]
            per_size = args.max_positions // len(sizes) + 1
            for size in sizes:
                for state in synthetic_states(size, per_size, args.max_branch, rng):
                    if written >= args.max_positions:
                        break
                    emit(state, None)
        else:
            candidates = harvest_replay_tails(args.replay_dir, args.per_game_tail, args.max_branch, rng)
            for game_id, sample in candidates:
                if written >= args.max_positions:
                    break
                emit(rebuild_state(sample), game_id)
    print(json.dumps({
        "event": "oracle_generated",
        "out": str(out_path),
        "written": written,
        "skippedDuplicates": skipped,
        "failed": failed,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
