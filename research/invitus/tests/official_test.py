from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

import random

import numpy as np
import torch

from training.official import bounded_wave_size, restore_tactical_rng, seed_everything, segment_games_per_hour
from training.train import load_aux_rng_states


class OfficialBoundaryTest(unittest.TestCase):
    def test_wave_stops_on_telemetry_boundary_after_resume(self) -> None:
        self.assertEqual(bounded_wave_size(250, 500, 20, [300, 500, 5000]), 20)
        self.assertEqual(bounded_wave_size(290, 500, 20, [300, 500, 5000]), 10)

    def test_wave_stops_on_checkpoint_and_target(self) -> None:
        self.assertEqual(bounded_wave_size(480, 500, 32, [500, 1000]), 20)
        self.assertEqual(bounded_wave_size(498, 500, 32, [600]), 2)

    def test_resumed_throughput_counts_only_new_games(self) -> None:
        self.assertEqual(segment_games_per_hour(300, 250, 180.0), 1000.0)

    def test_seed_controls_model_and_sampling_randomness(self) -> None:
        seed_everything(123)
        first = (random.random(), float(np.random.random()), torch.rand(3).tolist())
        seed_everything(123)
        second = (random.random(), float(np.random.random()), torch.rand(3).tolist())
        self.assertEqual(first, second)

    def test_tactical_rng_resume_restores_exact_sequence(self) -> None:
        original = random.Random(991)
        original.random()
        state = original.getstate()
        expected = [original.randrange(10_000) for _ in range(10)]
        resumed = random.Random(123)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.pt"
            torch.save({"aux_rng_states": {"tactical": state}}, path)
            saved_states = load_aux_rng_states(path)
        self.assertTrue(restore_tactical_rng(resumed, saved_states, 0.10))
        self.assertEqual([resumed.randrange(10_000) for _ in range(10)], expected)

    def test_tactical_resume_rejects_missing_rng_state(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "missing the tactical RNG state"):
            restore_tactical_rng(random.Random(1), {}, 0.10)
        self.assertFalse(restore_tactical_rng(random.Random(1), {}, 0.0))


if __name__ == "__main__":
    unittest.main()
