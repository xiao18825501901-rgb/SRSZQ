"""Held-out tactical accuracy aggregation tests."""
from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eval.tactical_accuracy import aggregate_rows


class TacticalAccuracyTest(unittest.TestCase):
    def test_aggregate_reports_category_and_overall_accuracy(self) -> None:
        rows = [
            {"category": "immediate_win", "correct": True, "targetProbability": 0.8},
            {"category": "immediate_win", "correct": False, "targetProbability": 0.2},
            {"category": "forced_block", "correct": True, "targetProbability": 0.7},
        ]
        result = aggregate_rows(rows)
        self.assertEqual(result["positions"], 3)
        self.assertEqual(result["top1Accuracy"], 2 / 3)
        self.assertEqual(result["byCategory"]["immediate_win"]["top1Accuracy"], 0.5)
        self.assertEqual(result["byCategory"]["forced_block"]["targetProbabilityMean"], 0.7)


if __name__ == "__main__":
    unittest.main()
