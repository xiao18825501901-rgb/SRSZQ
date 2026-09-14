"""Provable root tactics under the formal three-player SRSZQ rules."""
from __future__ import annotations

import copy

from engine import srszq


def immediate_winning_moves(state: dict) -> list[tuple[int, int]]:
    """Return every legal move that ends the game for the current actor."""
    if state["status"] != "playing" or not srszq.current_is_eligible(state):
        return []
    actor = srszq.current_player(state)
    wins: list[tuple[int, int]] = []
    for move in srszq.legal_moves(state):
        child = copy.deepcopy(state)
        result = srszq.apply_move(child, move[0], move[1])
        if result == "ok" and child["status"] == "won" and child["winner"] == actor:
            wins.append(move)
    return wins


def _next_actor_state_before_move(state: dict) -> dict:
    """Advance the turn identity without placing a stone.

    A current stone can only remove an opponent winning point in this placement
    game; it cannot create a new same-colour line for that opponent.  This lets
    the shield find threat cells once instead of searching every root child.
    """
    future = copy.deepcopy(state)
    future["turn"] += 1
    future["moves"] += 1
    srszq._advance_pass_chain(future)
    return future


def root_tactical_moves(state: dict) -> tuple[list[tuple[int, int]] | None, str | None]:
    """Return a proved root action subset, or ``(None, None)`` for normal MCTS."""
    own_wins = immediate_winning_moves(state)
    if own_wins:
        return sorted(own_wins), "immediate_win"

    future = _next_actor_state_before_move(state)
    if future["status"] != "playing":
        return None, None
    threats = immediate_winning_moves(future)
    if len(threats) != 1:
        return None, None
    block = threats[0]
    if block not in srszq.legal_moves(state):
        return None, None

    # Prove the candidate against the actual post-move actor/rights/pass state.
    child = copy.deepcopy(state)
    result = srszq.apply_move(child, block[0], block[1])
    if result != "ok" or immediate_winning_moves(child):
        return None, None
    return [block], "forced_defense"

