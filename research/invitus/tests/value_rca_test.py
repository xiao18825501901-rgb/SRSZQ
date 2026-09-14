"""Unit tests for replay value-target RCA."""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eval.value_target_rca import audit_run


class ValueTargetRcaTest(unittest.TestCase):
    def test_recomputes_targets_from_ledger_and_builds_actor_table(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "logs").mkdir()
            (root / "replay").mkdir()
            ledger = [
                {"game_id": "g-a", "kind": "experiment", "terminal_result": "A_WIN"},
                {"game_id": "g-d", "kind": "experiment", "terminal_result": "DRAW"},
            ]
            (root / "logs" / "INVICTUS_TRAINING_LEDGER.jsonl").write_text(
                "\n".join(json.dumps(row) for row in ledger) + "\n", encoding="utf-8"
            )
            samples = [
                {"game_id": "g-a", "actor": "A", "turn": 3, "size": 13,
                 "outcome": [1, 0, 0, 0]},
                {"game_id": "g-a", "actor": "B", "turn": 4, "size": 13,
                 "outcome": [1, 0, 0, 0]},
                {"game_id": "g-d", "actor": "C", "turn": 80, "size": 17,
                 "outcome": [0, 0, 0, 1]},
            ]
            (root / "replay" / "shard_000001.jsonl").write_text(
                "\n".join(json.dumps(row) for row in samples) + "\n", encoding="utf-8"
            )

            result = audit_run(root, cap=3, seed=7)

            self.assertEqual(result["sampled"], 3)
            self.assertEqual(result["mismatches"], 0)
            self.assertEqual(result["winnerDistribution"], {"A": 2, "B": 0, "C": 0, "DRAW": 1})
            self.assertEqual(result["actorByWinner"]["A"]["A"], 1)
            self.assertEqual(result["actorByWinner"]["B"]["A"], 1)
            self.assertEqual(result["actorByWinner"]["C"]["DRAW"], 1)

    def test_reports_stored_target_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "logs").mkdir()
            (root / "replay").mkdir()
            (root / "logs" / "INVICTUS_TRAINING_LEDGER.jsonl").write_text(
                json.dumps({"game_id": "g", "kind": "experiment", "terminal_result": "B_WIN"}) + "\n",
                encoding="utf-8",
            )
            (root / "replay" / "shard_000001.jsonl").write_text(
                json.dumps({"game_id": "g", "actor": "A", "turn": 0, "size": 13,
                            "outcome": [1, 0, 0, 0]}) + "\n",
                encoding="utf-8",
            )

            result = audit_run(root, cap=1, seed=1)

            self.assertEqual(result["mismatches"], 1)


if __name__ == "__main__":
    unittest.main()
