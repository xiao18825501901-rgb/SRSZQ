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
        )
        self.assertEqual(result, "A_WIN")
        self.assertEqual(meta["moves"], 1)


if __name__ == "__main__":
    unittest.main()
