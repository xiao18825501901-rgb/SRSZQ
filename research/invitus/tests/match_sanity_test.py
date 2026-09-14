"""End-to-end strength-harness winner attribution sanity checks."""
from __future__ import annotations

import pathlib
import random
import sys
import unittest

import torch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import srszq
from eval.champion_gate import build_match_tasks
from eval.match import play_matchup


class WrongPriorNet(torch.nn.Module):
    value_representation = "absolute"

    def forward(self, inputs):
        policy = torch.zeros((inputs.shape[0], 289))
        policy[:, -1] = 20.0
        value = torch.zeros((inputs.shape[0], 4))
        return policy, torch.log_softmax(value, dim=1)


class UnusedBridge:
    def move(self, *args, **kwargs):
        raise AssertionError("opponents must not move after the forced candidate win")


class MatchSanityTest(unittest.TestCase):
    def test_parallel_match_schedule_has_deterministic_per_game_seeds(self) -> None:
        first = build_match_tasks(30, 99, (13, 13, 17))
        second = build_match_tasks(30, 99, (13, 13, 17))
        self.assertEqual(first, second)
        self.assertEqual({seat: sum(task[0] == seat for task in first) for seat in "ABC"}, {"A": 10, "B": 10, "C": 10})
        self.assertEqual(len({task[2] for task in first}), 30)

    def test_forced_candidate_win_is_attributed_to_candidate_seat(self) -> None:
        state = srszq.create_state(13)
        state["turn"] = 21
        state["moves"] = 21
        state["board"][0][0:3] = ["A", "A", "A"]
        result, meta = play_matchup(
            13,
            {"A": ("nn",), "B": ("tactic", "random"), "C": ("tactic", "random")},
            {"A": (WrongPriorNet(), torch.device("cpu"), None, 2)},
            2,
            UnusedBridge(),
            random.Random(1),
            initial_state=state,
            collect_trace=True,
        )
        self.assertEqual(result, "A_WIN")
        self.assertEqual(meta["moves"], 1)
        self.assertEqual(len(meta["trace"]), 1)
        self.assertEqual(meta["trace"][0]["actor"], "A")
        self.assertEqual(meta["trace"][0]["rootTacticalReason"], "immediate_win")
        self.assertEqual(meta["trace"][0]["move"], [0, 3])


if __name__ == "__main__":
    unittest.main()
