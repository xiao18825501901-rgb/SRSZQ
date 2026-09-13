from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from eval.fixed_probe import generate_records


class FixedProbeTest(unittest.TestCase):
    def test_generator_is_deterministic_balanced_and_legal(self) -> None:
        first = generate_records(18, seed=71)
        second = generate_records(18, seed=71)
        self.assertEqual(first, second)
        self.assertEqual(len({record["positionHash"] for record in first}), 18)
        counts = Counter((record["boardSize"], record["stage"], record["actor"]) for record in first)
        self.assertEqual(len(counts), 18)
        self.assertTrue(all(count == 1 for count in counts.values()))
        self.assertTrue(all(record["legalMoves"] for record in first))


if __name__ == "__main__":
    unittest.main()
