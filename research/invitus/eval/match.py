"""Evaluation matchup game runner (no training samples, never counted as formal)."""
from __future__ import annotations

import copy
import random
import time
from typing import Any

from engine import srszq
from mcts.nn_mcts import NNMCTS


def play_matchup(
    state_size: int,
    seats: dict[str, tuple[str, ...]],
    nn_agents: dict[str, tuple[Any, Any, Any, int]],
    sims: int,
    bridge: Any,
    rng: random.Random,
    initial_state: dict[str, Any] | None = None,
    collect_trace: bool = False,
) -> tuple[str, dict[str, Any]]:
    """Play one complete SRSZQ game with fixed seat assignments.

    seats: {seat: agent}; agent is ("nn",) or ("tactic", spec).
    nn_agents: {seat: (net, device, inference_service, sims_override)}
    """
    started = time.monotonic()
    state = copy.deepcopy(initial_state) if initial_state is not None else srszq.create_state(state_size)
    if int(state["n"]) != state_size:
        raise ValueError("initial state board size does not match state_size")
    guard = 0
    move_no = 0
    nodes = 0
    trace: list[dict[str, Any]] = []
    while state["status"] == "playing" and guard < state_size * state_size + 32:
        seat = srszq.current_player(state)
        legal = srszq.legal_moves(state)
        if not legal:
            srszq._advance_pass_chain(state)
            guard += 1
            continue
        agent = seats[seat]
        root_tactical_reason = None
        if agent[0] == "nn":
            net, device, inference_service, sims_override = nn_agents[seat]
            search = NNMCTS(
                net,
                device,
                sims=sims_override or sims,
                exact=None,
                rng=random.Random(rng.getrandbits(32)),
                train=False,
                inference_service=inference_service,
            )
            search.search(state)
            root_tactical_reason = search.root_tactical_reason
            nodes += search.root.N
            move, _ = search.best_move(temperature=0.0)
        else:
            move = bridge.move(state, seat, agent[1], rng.getrandbits(31))
            if move is None:
                srszq._advance_pass_chain(state)
                guard += 1
                continue
        if collect_trace:
            trace.append({
                "size": state_size,
                "turn": int(state["turn"]),
                "actor": seat,
                "agent": str(agent[0]),
                "move": [int(move[0]), int(move[1])],
                "rootTacticalReason": root_tactical_reason,
                "board": ["".join("." if cell is None else cell for cell in row) for row in state["board"]],
            })
        rejected = srszq.apply_move(state, move[0], move[1])
        if rejected.startswith("rejected"):
            raise RuntimeError(f"evaluation produced illegal move {move}: {rejected}")
        move_no += 1
        guard += 1
    if state["status"] == "playing":
        state["status"] = "draw"
    if state["status"] == "won":
        result = f"{state['winner']}_WIN"
    else:
        result = "DRAW"
    meta = {
        "moves": move_no,
        "mcts_nodes": nodes,
        "seconds": round(time.monotonic() - started, 3),
    }
    if collect_trace:
        meta["trace"] = trace
    return result, meta
