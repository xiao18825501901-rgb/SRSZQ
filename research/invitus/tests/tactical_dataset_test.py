"""Frozen tactical dataset generation and leakage gates."""
from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eval.tactical_dataset import CATEGORIES, STAGES, generate_records, verify_record, write_dataset


class TacticalDatasetTest(unittest.TestCase):
    def test_generator_is_deterministic_balanced_and_proved(self) -> None:
        first = generate_records(24, seed=101)
        second = generate_records(24, seed=101)
        self.assertEqual(first, second)
        self.assertEqual(len({row["canonical"] for row in first}), 24)
        counts = Counter((row["boardSize"], row["category"], row["stage"]) for row in first)
        self.assertEqual(
            set(counts),
            {(size, category, stage) for size in (13, 17) for category in CATEGORIES for stage in STAGES},
        )
        self.assertEqual(set(counts.values()), {1})
        self.assertEqual(Counter(row["actor"] for row in first), {"A": 8, "B": 8, "C": 8})
        self.assertTrue(all(verify_record(row) == [] for row in first))

    def test_train_split_excludes_frozen_eval_canonicals(self) -> None:
        evaluation = generate_records(24, seed=202)
        excluded = {row["canonical"] for row in evaluation}
        training = generate_records(48, seed=303, excluded_canonicals=excluded)
        self.assertFalse(excluded & {row["canonical"] for row in training})

    def test_policy_targets_share_mass_and_unknown_values_are_masked(self) -> None:
        rows = generate_records(24, seed=404)
        for row in rows:
            self.assertAlmostEqual(sum(row["policyTarget"].values()), 1.0)
            probabilities = list(row["policyTarget"].values())
            self.assertEqual(len(set(round(value, 12) for value in probabilities)), 1)
            if row["category"] == "immediate_win":
                self.assertEqual(row["valueLossMask"], 1)
                self.assertIsNotNone(row["outcome"])
            else:
                self.assertEqual(row["valueLossMask"], 0)
                self.assertIsNone(row["outcome"])

    def test_manifest_hash_matches_written_bytes(self) -> None:
        rows = generate_records(24, seed=505)
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "eval.jsonl"
            manifest = write_dataset(rows, output, split="eval", seed=505)
            self.assertEqual(manifest["schemaVersion"], 2)
            self.assertEqual(manifest["positions"], 24)
            self.assertEqual(manifest["sha256"], __import__("hashlib").sha256(output.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
