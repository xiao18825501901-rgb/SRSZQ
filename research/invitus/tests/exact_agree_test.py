"""Exact-evaluation value representation tests."""
from __future__ import annotations

import pathlib
import sys
import unittest

import torch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eval.exact_agree import evaluate_checkpoint


class RelativeExactNet(torch.nn.Module):
    value_representation = "actor_relative"

    def forward(self, inputs):
        batch = inputs.shape[0]
        policy = torch.zeros((batch, 289), dtype=torch.float32)
        policy[:, 0] = 10.0
        # B to move; absolute A win maps to relative previous-player class.
        value = torch.tensor([-20.0, -20.0, 20.0, -20.0]).repeat(batch, 1)
        return policy, torch.log_softmax(value, dim=1)


class ExactAgreeTest(unittest.TestCase):
    def test_value_brier_uses_absolute_vector_for_relative_checkpoint(self) -> None:
        record = {
            "canonical": "fixture",
            "boardSize": 13,
            "actor": "B",
            "state": {"size": 13, "board": ["." * 13 for _ in range(13)], "turn": 1},
            "legalMoves": [[row, col] for row in range(13) for col in range(13)],
            "exactBestMoves": [[0, 0]],
            "exactOutcomeVector": [1.0, 0.0, 0.0, 0.0],
        }
        result = evaluate_checkpoint(
            [record], RelativeExactNet(), torch.device("cpu"), sims=1, seed=1, max_positions=1
        )
        self.assertEqual(result["valueBrierMean"], 0.0)


if __name__ == "__main__":
    unittest.main()
