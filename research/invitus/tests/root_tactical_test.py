"""Root tactical shield tests using formal three-player victory-right rules."""
from __future__ import annotations

import pathlib
import random
import sys
import unittest

import torch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import srszq
from mcts.nn_mcts import NNMCTS
from mcts.tactical import root_tactical_moves


class WrongPriorNet(torch.nn.Module):
    value_representation = "absolute"

    def forward(self, inputs):
        batch = inputs.shape[0]
        policy = torch.zeros((batch, 289))
        policy[:, -1] = 20.0
        values = torch.zeros((batch, 4))
        return policy, torch.log_softmax(values, dim=1)


class UniformNet(torch.nn.Module):
    value_representation = "absolute"

    def forward(self, inputs):
        return torch.zeros((inputs.shape[0], 289)), torch.log_softmax(torch.zeros((inputs.shape[0], 4)), dim=1)


def state_at(turn: int) -> dict:
    state = srszq.create_state(13)
    state["turn"] = turn
    state["moves"] = turn
    return state


class RootTacticalTest(unittest.TestCase):
    def test_immediate_legal_win_has_priority_over_network_prior(self) -> None:
        state = state_at(21)  # round 8: A has victory right and is actor
        state["board"][0][0:3] = ["A", "A", "A"]
        moves, reason = root_tactical_moves(state)
        self.assertEqual(reason, "immediate_win")
        self.assertEqual(moves, [(0, 3)])

        search = NNMCTS(WrongPriorNet(), torch.device("cpu"), sims=2, rng=random.Random(1))
        search.search(state)
        move, _ = search.best_move(temperature=0.0)
        self.assertEqual(move, (0, 3))
        self.assertEqual(search.root_tactical_reason, "immediate_win")

    def test_forced_block_uses_actual_next_actor_and_victory_right(self) -> None:
        state = state_at(18)  # A moves, then B acts with round-7 victory right
        state["board"][5][0:3] = ["B", "B", "B"]
        moves, reason = root_tactical_moves(state)
        self.assertEqual(reason, "forced_defense")
        self.assertEqual(moves, [(5, 3)])

    def test_noneligible_opponent_four_is_not_a_threat(self) -> None:
        state = state_at(15)  # round 6 victory right is C; B acts next but cannot win
        state["board"][5][0:3] = ["B", "B", "B"]
        moves, reason = root_tactical_moves(state)
        self.assertIsNone(moves)
        self.assertIsNone(reason)

    def test_neutral_values_do_not_lock_search_to_first_visited_child(self) -> None:
        state = srszq.create_state(13)
        search = NNMCTS(UniformNet(), torch.device("cpu"), sims=16, rng=random.Random(7), train=True)
        search.search(state)
        visited = sum(child.N > 0 for child in search.root.children.values())
        self.assertGreaterEqual(visited, 8)


if __name__ == "__main__":
    unittest.main()
