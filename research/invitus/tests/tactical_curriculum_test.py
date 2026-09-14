"""Masked tactical curriculum construction tests."""
from __future__ import annotations

import pathlib
import sys
import hashlib
import json
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from training.tactical_curriculum import curriculum_batch_counts, tactical_record_to_sample, verify_dataset_file


class TacticalCurriculumTest(unittest.TestCase):
    def test_ratio_controls_only_batch_composition(self) -> None:
        self.assertEqual(curriculum_batch_counts(128, 0.0), (128, 0))
        self.assertEqual(curriculum_batch_counts(128, 0.10), (115, 13))
        self.assertEqual(curriculum_batch_counts(128, 0.20), (102, 26))

    def test_policy_only_record_preserves_equal_optimal_mass_and_masks_value(self) -> None:
        record = {
            "canonical": "example",
            "positionHash": "abc123",
            "category": "double_threat",
            "state": {"board": ["...", "...", "..."], "turn": 4, "size": 3},
            "actor": "B",
            "legalMoves": [[0, 0], [0, 1], [0, 2]],
            "policyTarget": {"0,0": 0.5, "0,2": 0.5},
            "outcome": None,
            "valueLossMask": 0,
        }
        sample = tactical_record_to_sample(record)
        self.assertEqual(sample["visits"], {"0,0": 0.5, "0,2": 0.5})
        self.assertIsNone(sample["outcome"])
        self.assertEqual(sample["value_loss_mask"], 0)
        self.assertEqual(sample["tactical_category"], "double_threat")

    def test_dataset_manifest_must_match_bytes_and_split(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "train.jsonl"
            path.write_text('{"canonical":"x"}\n', encoding="utf-8")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            path.with_suffix(".jsonl.manifest.json").write_text(
                json.dumps({"split": "train", "sha256": digest}), encoding="utf-8"
            )
            self.assertEqual(verify_dataset_file(path, "train")["sha256"], digest)
            with self.assertRaises(RuntimeError):
                verify_dataset_file(path, "eval")


if __name__ == "__main__":
    unittest.main()
