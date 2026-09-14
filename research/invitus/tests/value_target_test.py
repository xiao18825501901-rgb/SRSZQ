"""Phase 4C value-representation and terminal-semantics invariants."""
from __future__ import annotations

import pathlib
import math
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import srszq
from exact.solver import ExactSolver
from mcts.mcts import MCTS
from mcts.nn_mcts import NNMCTS
from model.value import absolute_to_relative, actor_utility, relative_to_absolute, selection_utility


OUTCOMES = {
    "A": (1.0, 0.0, 0.0, 0.0),
    "B": (0.0, 1.0, 0.0, 0.0),
    "C": (0.0, 0.0, 1.0, 0.0),
    "DRAW": (0.0, 0.0, 0.0, 1.0),
}


def terminal_state(size: int, outcome: str, turn: int) -> dict:
    state = srszq.create_state(size)
    state["turn"] = turn
    state["moves"] = turn
    if outcome == "DRAW":
        state["status"] = "draw"
    else:
        state["status"] = "won"
        state["winner"] = outcome
    return state


def test_terminal_targets_ignore_actor_and_victory_right() -> None:
    for size in (13, 17):
        for turn in range(0, 30):
            for outcome, expected in OUTCOMES.items():
                state = terminal_state(size, outcome, turn)
                assert srszq.outcome_vector(state) == expected
                assert NNMCTS(None, None).evaluate(state) == expected
                assert ExactSolver().solve(state) == expected
                assert MCTS().evaluate(state) == expected


def test_relative_round_trip_for_every_actor_and_outcome() -> None:
    for actor in "ABC":
        for absolute in OUTCOMES.values():
            relative = absolute_to_relative(absolute, actor)
            restored = relative_to_absolute(relative, actor)
            assert restored == absolute


def test_relative_order_follows_abc_turn_cycle() -> None:
    absolute = (0.1, 0.2, 0.3, 0.4)
    assert absolute_to_relative(absolute, "A") == (0.1, 0.2, 0.3, 0.4)
    assert absolute_to_relative(absolute, "B") == (0.2, 0.3, 0.1, 0.4)
    assert absolute_to_relative(absolute, "C") == (0.3, 0.1, 0.2, 0.4)


def test_draw_has_shared_selection_utility_without_changing_absolute_vector() -> None:
    draw = OUTCOMES["DRAW"]
    for actor in "ABC":
        assert actor_utility(draw, actor) == 1.0 / 3.0
    assert draw == (0.0, 0.0, 0.0, 1.0)


def test_selection_utility_centers_neutral_three_player_expectation() -> None:
    for actor in "ABC":
        assert math.isclose(selection_utility((1 / 3, 1 / 3, 1 / 3, 0), actor), 0.0)
        assert math.isclose(selection_utility(OUTCOMES["DRAW"], actor), 0.0)
        assert math.isclose(selection_utility(OUTCOMES[actor], actor), 2 / 3)


if __name__ == "__main__":
    test_terminal_targets_ignore_actor_and_victory_right()
    test_relative_round_trip_for_every_actor_and_outcome()
    test_relative_order_follows_abc_turn_cycle()
    test_draw_has_shared_selection_utility_without_changing_absolute_vector()
    test_selection_utility_centers_neutral_three_player_expectation()
    print("value_target_test: PASS")
