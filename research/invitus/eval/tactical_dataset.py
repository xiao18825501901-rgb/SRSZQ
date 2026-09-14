"""Generate reproducible, proof-labelled tactical train/evaluation positions.

The generator builds reachable non-terminal boards with exact per-seat stone
counts for the recorded turn.  Labels come from formal immediate-win checks or
an exhaustive bounded two-ply threat proof.  Only immediate terminal wins carry
a value target; every other record is policy-only.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
from collections import Counter
from functools import cache
from pathlib import Path
from typing import Any

from engine import srszq
from exact.solver import canonical_key
from mcts.tactical import immediate_winning_moves, root_tactical_moves

CATEGORIES = (
    "immediate_win",
    "forced_block",
    "victory_right_legality",
    "double_threat",
    "avoid_helping_opponent",
    "two_ply_tactical",
)
STAGES = ("early", "mid")


def _stage_bounds(size: int, stage: str) -> tuple[int, int]:
    if stage == "early":
        return 15, max(30, int(size * size * 0.22))
    if stage == "mid":
        return int(size * size * 0.35), int(size * size * 0.55)
    raise ValueError(stage)


@cache
def _eligible_turns(actor: str, eligible_offset: int, size: int, stage: str) -> tuple[int, ...]:
    low, high = _stage_bounds(size, stage)
    candidates: list[int] = []
    for turn in range(low, high + 1):
        state = srszq.create_state(size)
        state["turn"] = state["moves"] = turn
        if srszq.current_player(state) != actor:
            continue
        future = copy.deepcopy(state)
        future["turn"] += eligible_offset
        future["moves"] += eligible_offset
        if srszq.current_is_eligible(future):
            candidates.append(turn)
    return tuple(candidates)


def _turn_for(actor: str, eligible_offset: int, size: int, stage: str, rng: random.Random) -> int:
    """Choose a turn where actor acts and the actor `offset` plies later is eligible."""
    candidates = _eligible_turns(actor, eligible_offset, size, stage)
    if not candidates:
        raise AssertionError((actor, eligible_offset, size, stage))
    return rng.choice(candidates)


def _seat_counts(turn: int) -> dict[str, int]:
    base, remainder = divmod(turn, 3)
    return {player: base + (index < remainder) for index, player in enumerate(srszq.PLAYERS)}


def _line(size: int, rng: random.Random, double_ended: bool) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    orientation = rng.randrange(4)
    if double_ended:
        if orientation == 0:
            row, col = rng.randrange(size), rng.randrange(size - 4)
            cells = [(row, col + i) for i in range(5)]
        elif orientation == 1:
            row, col = rng.randrange(size - 4), rng.randrange(size)
            cells = [(row + i, col) for i in range(5)]
        elif orientation == 2:
            row, col = rng.randrange(size - 4), rng.randrange(size - 4)
            cells = [(row + i, col + i) for i in range(5)]
        else:
            row, col = rng.randrange(size - 4), rng.randrange(4, size)
            cells = [(row + i, col - i) for i in range(5)]
        return cells[1:4], [cells[0], cells[4]]
    if orientation == 0:
        row = rng.randrange(size)
        cells = [(row, i) for i in range(4)]
    elif orientation == 1:
        col = rng.randrange(size)
        cells = [(i, col) for i in range(4)]
    elif orientation == 2:
        col = rng.randrange(size - 3)
        cells = [(i, col + i) for i in range(4)]
    else:
        col = rng.randrange(3, size)
        cells = [(i, col - i) for i in range(4)]
    if rng.random() < 0.5:
        cells.reverse()
    return cells[:3], [cells[3]]


def _place_triple(
    state: dict[str, Any], player: str, rng: random.Random, reserved: set[tuple[int, int]], double: bool = False
) -> list[tuple[int, int]] | None:
    stones, targets = _line(state["n"], rng, double)
    if any(state["board"][row][col] is not None or (row, col) in reserved for row, col in stones + targets):
        return None
    for row, col in stones:
        state["board"][row][col] = player
    reserved.update(targets)
    return targets


def _fill_counts(state: dict[str, Any], rng: random.Random, reserved: set[tuple[int, int]]) -> bool:
    target = _seat_counts(state["turn"])
    present = Counter(cell for row in state["board"] for cell in row if cell is not None)
    for player in srszq.PLAYERS:
        needed = target[player] - present[player]
        if needed < 0:
            return False
        candidates = [
            (row, col)
            for row in range(state["n"])
            for col in range(state["n"])
            if state["board"][row][col] is None and (row, col) not in reserved
        ]
        rng.shuffle(candidates)
        for _ in range(needed):
            placed = False
            while candidates:
                row, col = candidates.pop()
                state["board"][row][col] = player
                if not srszq.creates_four_through(state["board"], row, col, player):
                    placed = True
                    break
                state["board"][row][col] = None
            if not placed:
                return False
    return True


def _advance_empty(state: dict[str, Any], plies: int) -> dict[str, Any]:
    future = copy.deepcopy(state)
    future["turn"] += plies
    future["moves"] += plies
    srszq._advance_pass_chain(future)
    return future


def _safe_against_next_actor(state: dict[str, Any]) -> list[tuple[int, int]]:
    moves, reason = root_tactical_moves(state)
    return list(moves or []) if reason == "forced_defense" else []


def two_ply_safe_moves(state: dict[str, Any]) -> list[tuple[int, int]]:
    """Block a unique win belonging to the actor two plies ahead.

    Placement is monotone: an intervening opponent stone cannot create a line
    for the threatened actor.  When that actor has exactly one winning cell in
    the two-ply turn/rights state, occupying that cell now is the only move that
    prevents an adversarial intervening actor from leaving the win available.
    """
    threats = immediate_winning_moves(_advance_empty(state, 2))
    if len(threats) != 1:
        return []
    return [move for move in threats if move in srszq.legal_moves(state)]


def _rebuild(record: dict[str, Any]) -> dict[str, Any]:
    state_record = record["state"]
    state = srszq.create_state(int(state_record["size"]))
    state["board"] = [[None if cell == "." else cell for cell in row] for row in state_record["board"]]
    state["turn"] = state["moves"] = int(state_record["turn"])
    return state


def _make_record(size: int, category: str, stage: str, actor: str, rng: random.Random) -> dict[str, Any] | None:
    offset = 0 if category == "immediate_win" else (2 if category == "two_ply_tactical" else 1)
    turn = _turn_for(actor, offset, size, stage, rng)
    state = srszq.create_state(size)
    state["turn"] = state["moves"] = turn
    reserved: set[tuple[int, int]] = set()
    target_cells: list[tuple[int, int]] = []

    if category == "immediate_win":
        placed = _place_triple(state, actor, rng, reserved)
        if placed is None:
            return None
        target_cells = placed
    elif category in {"forced_block", "avoid_helping_opponent"}:
        future = _advance_empty(state, 1)
        placed = _place_triple(state, srszq.current_player(future), rng, reserved)
        if placed is None:
            return None
        target_cells = placed
    elif category == "victory_right_legality":
        placed = _place_triple(state, actor, rng, reserved)
        if placed is None:
            return None
        future = _advance_empty(state, 1)
        threat = _place_triple(state, srszq.current_player(future), rng, reserved)
        if threat is None:
            return None
        target_cells = threat
    elif category == "double_threat":
        future = _advance_empty(state, 1)
        placed = _place_triple(state, srszq.current_player(future), rng, reserved, double=True)
        if placed is None:
            return None
        target_cells = placed
    elif category == "two_ply_tactical":
        future = _advance_empty(state, 2)
        placed = _place_triple(state, srszq.current_player(future), rng, reserved)
        if placed is None:
            return None
        target_cells = placed
    else:
        raise ValueError(category)

    if not _fill_counts(state, rng, reserved):
        return None
    if state["status"] != "playing" or srszq.current_player(state) != actor:
        return None

    if category == "immediate_win":
        optimal = immediate_winning_moves(state)
        if not optimal:
            return None
        outcome = [1.0 if player == actor else 0.0 for player in srszq.PLAYERS] + [0.0]
        value_mask = 1
        proof = {"kind": "terminal_immediate_win", "winningMoves": [list(move) for move in optimal]}
    elif category in {"forced_block", "victory_right_legality"}:
        optimal, reason = root_tactical_moves(state)
        if reason != "forced_defense" or optimal is None:
            return None
        if category == "victory_right_legality" and not srszq.forbidden_moves(state):
            return None
        outcome, value_mask = None, 0
        proof = {
            "kind": "formal_unique_next_actor_defense",
            "threatCells": [list(move) for move in target_cells],
            "forbiddenMoves": [list(move) for move in srszq.forbidden_moves(state)],
        }
    elif category == "avoid_helping_opponent":
        optimal = _safe_against_next_actor(state)
        if set(optimal) != set(target_cells):
            return None
        outcome, value_mask = None, 0
        proof = {"kind": "exhaustive_next_actor_survival", "safeMoves": [list(move) for move in optimal]}
    elif category == "double_threat":
        future = _advance_empty(state, 1)
        threats = immediate_winning_moves(future)
        if set(threats) != set(target_cells) or len(threats) != 2:
            return None
        optimal = [move for move in srszq.legal_moves(state) if move in set(threats)]
        if len(optimal) != 2:
            return None
        for move in optimal:
            child = copy.deepcopy(state)
            srszq.apply_move(child, *move)
            if len(immediate_winning_moves(child)) != 1:
                return None
        outcome, value_mask = None, 0
        proof = {"kind": "bounded_minimum_immediate_threats", "threatCells": [list(move) for move in threats]}
    else:
        optimal = two_ply_safe_moves(state)
        if set(optimal) != set(target_cells):
            return None
        outcome, value_mask = None, 0
        proof = {"kind": "exhaustive_two_ply_survival", "safeMoves": [list(move) for move in optimal]}

    canonical = canonical_key(state)
    probability = 1.0 / len(optimal)
    policy = {f"{row},{col}": probability for row, col in sorted(optimal)}
    return {
        "canonical": canonical,
        "positionHash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "category": category,
        "stage": stage,
        "state": {
            "board": ["".join("." if cell is None else cell for cell in row) for row in state["board"]],
            "turn": state["turn"],
            "size": size,
        },
        "boardSize": size,
        "actor": actor,
        "round": srszq.round_of(state),
        "eligible": srszq.eligible_of(state),
        "legalMoves": [list(move) for move in srszq.legal_moves(state)],
        "optimalMoves": [list(move) for move in sorted(optimal)],
        "policyTarget": policy,
        "outcome": outcome,
        "valueLossMask": value_mask,
        "proof": proof,
    }


def verify_record(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    state = _rebuild(record)
    try:
        stage_low, stage_high = _stage_bounds(state["n"], str(record.get("stage")))
        if not stage_low <= state["turn"] <= stage_high:
            errors.append("turn outside declared stage")
    except ValueError:
        errors.append("invalid stage")
    if canonical_key(state) != record.get("canonical"):
        errors.append("canonical mismatch")
    legal = set(srszq.legal_moves(state))
    optimal = {tuple(move) for move in record.get("optimalMoves", [])}
    if not optimal or not optimal <= legal:
        errors.append("optimal moves are empty or illegal")
    policy = record.get("policyTarget", {})
    if set(policy) != {f"{row},{col}" for row, col in optimal}:
        errors.append("policy target keys mismatch")
    if abs(sum(float(value) for value in policy.values()) - 1.0) > 1e-9:
        errors.append("policy target mass mismatch")
    category = record.get("category")
    if category == "immediate_win" and optimal != set(immediate_winning_moves(state)):
        errors.append("immediate win proof mismatch")
    elif category in {"forced_block", "victory_right_legality"}:
        moves, reason = root_tactical_moves(state)
        if reason != "forced_defense" or optimal != set(moves or []):
            errors.append("forced defense proof mismatch")
        if category == "victory_right_legality" and not srszq.forbidden_moves(state):
            errors.append("victory-right example has no forbidden four")
    elif category == "avoid_helping_opponent" and optimal != set(_safe_against_next_actor(state)):
        errors.append("next-actor survival proof mismatch")
    elif category == "double_threat":
        threats = set(immediate_winning_moves(_advance_empty(state, 1)))
        if len(threats) != 2 or optimal != threats:
            errors.append("double-threat proof mismatch")
    elif category == "two_ply_tactical" and optimal != set(two_ply_safe_moves(state)):
        errors.append("two-ply proof mismatch")
    if category == "immediate_win":
        if record.get("valueLossMask") != 1 or record.get("outcome") is None:
            errors.append("terminal value target missing")
    elif record.get("valueLossMask") != 0 or record.get("outcome") is not None:
        errors.append("heuristic value target must be masked")
    return errors


def generate_records(
    count: int,
    seed: int,
    excluded_canonicals: set[str] | None = None,
    max_attempts_per_cell: int = 2000,
) -> list[dict[str, Any]]:
    cells = [(size, category, stage) for size in (13, 17) for category in CATEGORIES for stage in STAGES]
    if count < len(cells) or count % len(cells):
        raise ValueError(f"count must be a multiple of {len(cells)}")
    target = count // len(cells)
    excluded = set(excluded_canonicals or ())
    seen = set(excluded)
    rng = random.Random(seed)
    records: list[dict[str, Any]] = []
    for size, category, stage in cells:
        accepted = 0
        attempts = 0
        while accepted < target and attempts < max_attempts_per_cell:
            attempts += 1
            actor = srszq.PLAYERS[accepted % 3]
            record = _make_record(size, category, stage, actor, rng)
            if record is None or record["canonical"] in seen or verify_record(record):
                continue
            seen.add(record["canonical"])
            records.append(record)
            accepted += 1
        if accepted != target:
            raise RuntimeError(
                f"generated {accepted}/{target} for {size}:{category}:{stage} after {attempts} attempts"
            )
    return records


def write_dataset(records: list[dict[str, Any]], output: Path, split: str, seed: int) -> dict[str, Any]:
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records).encode("utf-8")
    output.write_bytes(payload)
    counts = Counter(f"{row['boardSize']}:{row['category']}:{row['stage']}" for row in records)
    manifest = {
        "schemaVersion": 2,
        "split": split,
        "seed": seed,
        "positions": len(records),
        "uniqueCanonicals": len({row["canonical"] for row in records}),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "counts": dict(sorted(counts.items())),
        "valueMasked": sum(row["valueLossMask"] == 0 for row in records),
        "valueExact": sum(row["valueLossMask"] == 1 for row in records),
    }
    manifest_path = output.with_suffix(output.suffix + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval-out", required=True)
    parser.add_argument("--train-out", required=True)
    parser.add_argument("--eval-count", type=int, default=600)
    parser.add_argument("--train-count", type=int, default=6000)
    parser.add_argument("--eval-seed", type=int, default=20260950)
    parser.add_argument("--train-seed", type=int, default=20260951)
    args = parser.parse_args()
    evaluation = generate_records(args.eval_count, args.eval_seed)
    frozen = {row["canonical"] for row in evaluation}
    training = generate_records(args.train_count, args.train_seed, excluded_canonicals=frozen)
    train_canonicals = {row["canonical"] for row in training}
    overlap = frozen & train_canonicals
    if overlap:
        raise RuntimeError(f"tactical train/eval leakage: {len(overlap)} canonical positions")
    eval_manifest = write_dataset(evaluation, Path(args.eval_out), "eval", args.eval_seed)
    train_manifest = write_dataset(training, Path(args.train_out), "train", args.train_seed)
    result = {"eval": eval_manifest, "train": train_manifest, "canonicalOverlap": len(overlap)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
