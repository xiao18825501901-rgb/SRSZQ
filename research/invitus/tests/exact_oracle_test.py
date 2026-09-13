from __future__ import annotations

import random
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from eval.exact_oracle import _balanced_cell_targets, _fill_synthetic_cell


class ExactOracleGenerationTest(unittest.TestCase):
    def test_balanced_targets_sum_exactly_to_requested_count(self) -> None:
        targets = _balanced_cell_targets(200, [13, 17], ["A", "B", "C"])
        counts = [target for _, _, target in targets]
        self.assertEqual(sum(counts), 200)
        self.assertEqual(len(counts), 6)
        self.assertLessEqual(max(counts) - min(counts), 1)

    def test_solver_failures_are_replaced_with_new_candidates(self) -> None:
        batches = [[{"id": 1}, {"id": 2}, {"id": 3}, {"id": 4}], [{"id": 5}, {"id": 6}]]
        accepted_ids: list[int] = []

        def emit(state: dict, _game_id: None) -> bool:
            if state["id"] in (1, 2):
                return False
            accepted_ids.append(state["id"])
            return True

        with patch("eval.exact_oracle.synthetic_states", side_effect=batches) as generate:
            accepted = _fill_synthetic_cell(13, "A", 4, 8, random.Random(1), emit)

        self.assertEqual(accepted, 4)
        self.assertEqual(accepted_ids, [3, 4, 5, 6])
        self.assertEqual(generate.call_count, 2)


if __name__ == "__main__":
    unittest.main()
