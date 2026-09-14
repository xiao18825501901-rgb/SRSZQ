"""Stage-conditioned, actor-aware calibration tests."""
from __future__ import annotations

import pathlib
import sys
import unittest

import torch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eval.calibration import calibrate


class RelativeNet(torch.nn.Module):
    value_representation = "actor_relative"

    def forward(self, inputs):
        batch = inputs.shape[0]
        policy = torch.zeros((batch, 289), dtype=torch.float32)
        raw = torch.tensor([0.7, 0.1, 0.1, 0.1], dtype=torch.float32).log()
        return policy, raw.repeat(batch, 1)


def sample(actor: str, winner: int, turn: int, size: int = 13) -> dict:
    board = ["." * size for _ in range(size)]
    outcome = [0.0, 0.0, 0.0, 0.0]
    outcome[winner] = 1.0
    return {"size": size, "board": board, "turn": turn, "actor": actor, "outcome": outcome}


class CalibrationTest(unittest.TestCase):
    def test_converts_relative_output_and_reports_stage_reliability(self) -> None:
        samples = [
            sample("A", 0, 5),
            sample("B", 1, 60),
            sample("C", 2, 130),
        ]
        result = calibrate(RelativeNet(), torch.device("cpu"), samples, batch_size=3)
        self.assertEqual(result["totalSamples"], 3)
        overall = result["overall"]
        self.assertEqual(overall["samples"], 3)
        self.assertEqual(overall["empiricalOutcome"], [0.333333, 0.333333, 0.333333, 0.0])
        self.assertEqual(overall["predictedMean"], [0.3, 0.3, 0.3, 0.1])
        self.assertEqual(len(overall["reliabilityBins"]), 10)
        stages = {row["stage"]: row for row in result["byStage"]}
        self.assertEqual(set(stages), {"early", "mid", "late"})
        self.assertEqual(stages["early"]["samples"], 1)
        self.assertEqual(stages["mid"]["samples"], 1)
        self.assertEqual(stages["late"]["samples"], 1)


if __name__ == "__main__":
    unittest.main()
