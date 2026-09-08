from __future__ import annotations

import sys
import unittest
from pathlib import Path

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from training import benchmark


class GpuBenchmarkTest(unittest.TestCase):
    def test_performance_gate_uses_frozen_thresholds(self) -> None:
        self.assertEqual(benchmark.performance_gate(1500), "GREEN")
        self.assertEqual(benchmark.performance_gate(1499.9), "YELLOW")
        self.assertEqual(benchmark.performance_gate(700), "YELLOW")
        self.assertEqual(benchmark.performance_gate(699.9), "RED")

    def test_benchmark_records_cannot_count_as_formal(self) -> None:
        record = benchmark.make_benchmark_record(
            {
                "game_id": "game-1",
                "boardSize": 13,
                "result": "A_WIN",
                "num_samples": 12,
                "moves": 30,
                "mcts_nodes": 320,
                "seconds": 1.5,
                "league_bucket": "strong",
            },
            "run-1",
        )
        self.assertFalse(record["formal"])
        self.assertEqual(record["kind"], "benchmark")
        self.assertTrue(record["completed"])
        self.assertTrue(record["replay_persisted"])


if __name__ == "__main__":
    unittest.main()
