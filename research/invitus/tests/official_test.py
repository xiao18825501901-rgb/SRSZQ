from __future__ import annotations

import sys
import unittest
from pathlib import Path

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from training.official import bounded_wave_size


class OfficialBoundaryTest(unittest.TestCase):
    def test_wave_stops_on_telemetry_boundary_after_resume(self) -> None:
        self.assertEqual(bounded_wave_size(250, 500, 20, [300, 500, 5000]), 20)
        self.assertEqual(bounded_wave_size(290, 500, 20, [300, 500, 5000]), 10)

    def test_wave_stops_on_checkpoint_and_target(self) -> None:
        self.assertEqual(bounded_wave_size(480, 500, 32, [500, 1000]), 20)
        self.assertEqual(bounded_wave_size(498, 500, 32, [600]), 2)


if __name__ == "__main__":
    unittest.main()
