from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from training.diagnostics import CollapseSentinel, summarize_games, target_metrics


def metadata(policy_entropy: float, visit_entropy: float, top1: float) -> dict:
    return {
        "moves": 12,
        "result": "A_WIN",
        "openingMoves": [f"0,{index}" for index in range(9)],
        "searchDiagnostics": {
            "invitusMoveCount": 4,
            "networkPriorEntropy": policy_entropy,
            "rootPriorEntropy": policy_entropy + 0.1,
            "visitEntropy": visit_entropy,
            "maxPolicyProbability": top1,
            "visitedActionCount": 8,
            "legalActionCount": 80,
            "valuePrediction": [0.4, 0.3, 0.2, 0.1],
        },
    }


class DiagnosticsTest(unittest.TestCase):
    def test_target_metrics_apply_temperature(self) -> None:
        sample = {"visits": {"0,0": 9.0, "0,1": 1.0}}
        metrics = target_metrics([sample], tau=2.0)
        expected = -(0.75 * math.log(0.75) + 0.25 * math.log(0.25))
        self.assertAlmostEqual(metrics["targetEntropy"], expected)
        self.assertAlmostEqual(metrics["effectiveTargetSupport"], math.exp(expected))

    def test_summarizes_search_opening_value_and_outcome(self) -> None:
        summary = summarize_games([metadata(1.2, 0.8, 0.4), metadata(1.0, 0.6, 0.5)])
        self.assertAlmostEqual(summary["networkPriorEntropy"], 1.1)
        self.assertAlmostEqual(summary["visitEntropy"], 0.7)
        self.assertEqual(summary["outcomes"], {"A_WIN": 2})
        self.assertEqual(summary["opening9"]["unique"], 1)
        self.assertEqual(summary["valuePrediction"], [0.4, 0.3, 0.2, 0.1])

    def test_sentinel_requires_full_collapsed_window(self) -> None:
        sentinel = CollapseSentinel(window=100)
        for _ in range(99):
            self.assertFalse(sentinel.observe(metadata(0.1, 0.05, 0.99)))
        self.assertTrue(sentinel.observe(metadata(0.1, 0.05, 0.99)))
        self.assertTrue(sentinel.snapshot["triggered"])

    def test_sentinel_does_not_trigger_on_healthy_window(self) -> None:
        sentinel = CollapseSentinel(window=100)
        for _ in range(100):
            sentinel.observe(metadata(0.8, 0.4, 0.6))
        self.assertFalse(sentinel.triggered)


if __name__ == "__main__":
    unittest.main()
