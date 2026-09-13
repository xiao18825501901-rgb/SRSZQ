from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import torch

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from training.audit_training_state import audit_training_state


def formal_record(index: int, board_size: int = 13) -> dict:
    return {
        "timestamp": f"2026-09-08T00:00:{index:02d}Z",
        "kind": "formal",
        "game_id": f"game-{index}",
        "completed": True,
        "board_size": board_size,
        "seat_assignments": "invitus-invitus-invitus",
        "num_samples": 3,
        "terminal_result": "A_WIN",
    }


def experiment_record(index: int, board_size: int = 13) -> dict:
    record = formal_record(index, board_size)
    record.update({"kind": "experiment", "formal": False, "experiment": True})
    return record


def write_checkpoint(path: Path, counter: int, optimizer_step: int = 7) -> None:
    torch.save(
        {
            "counter": counter,
            "model": {"weight": torch.tensor([1.0])},
            "opt": {"state": {0: {"step": torch.tensor(optimizer_step)}}, "param_groups": []},
            "sched": {"last_epoch": 4},
            "rng": (3, (1, 2, 3), None),
            "cfg": {"channels": 32, "blocks": 4},
            "net": "Tiny",
        },
        path,
    )


class TrainingStateAuditTest(unittest.TestCase):
    def make_root(self) -> Path:
        root = Path(tempfile.mkdtemp())
        for directory in ("logs", "checkpoints", "replay"):
            (root / directory).mkdir()
        return root

    def write_ledger(self, root: Path, records: list[dict]) -> None:
        payload = "".join(json.dumps(record) + "\n" for record in records)
        (root / "logs" / "INVICTUS_TRAINING_LEDGER.jsonl").write_text(payload, encoding="utf-8")

    def write_replay(self, root: Path, game_ids: list[str]) -> None:
        payload = "".join(
            json.dumps({"game_id": game_id, "size": 13, "actor": "A", "outcome": [1, 0, 0, 0]}) + "\n"
            for game_id in game_ids
        )
        (root / "replay" / "shard_000001.jsonl").write_text(payload, encoding="utf-8")

    def test_marks_ledger_checkpoint_replay_gap_as_inconsistent(self) -> None:
        root = self.make_root()
        self.write_ledger(root, [formal_record(i) for i in range(1, 6)])
        self.write_replay(root, ["game-4", "game-5"])
        write_checkpoint(root / "checkpoints" / "invitus_000003_final.pt", 3)
        (root / "logs" / "progress.json").write_text(
            json.dumps({"counter": 3, "path": "checkpoints/invitus_000003_final.pt"}), encoding="utf-8"
        )

        state = audit_training_state(root, git_sha="abc123", write_manifest=True)

        self.assertEqual(state["ledgerFormalEpisodes"], 5)
        self.assertEqual(state["checkpointEpisodeCount"], 3)
        self.assertEqual(state["replayMinEpisode"], 4)
        self.assertEqual(state["replayMaxEpisode"], 5)
        self.assertEqual(state["formalEpisodes"], 0)
        self.assertFalse(state["stateConsistent"])
        self.assertIn("checkpoint episode 3 is absent from retained replay", state["consistencyErrors"])
        self.assertEqual(json.loads((root / "training_state.json").read_text(encoding="utf-8")), state)

    def test_reports_a_fully_supported_latest_episode(self) -> None:
        root = self.make_root()
        records = [formal_record(i, 13 if i <= 3 else 17) for i in range(1, 6)]
        self.write_ledger(root, records)
        self.write_replay(root, ["game-5"])
        write_checkpoint(root / "checkpoints" / "latest.pt", 5, optimizer_step=11)
        (root / "logs" / "progress.json").write_text(
            json.dumps({"counter": 5, "path": "checkpoints/latest.pt"}), encoding="utf-8"
        )

        state = audit_training_state(root, git_sha="def456", write_manifest=False)

        self.assertEqual(state["formalEpisodes"], 5)
        self.assertEqual(state["latestGameId"], "game-5")
        self.assertEqual(state["optimizerStep"], 11)
        self.assertEqual(state["schedulerStep"], 4)
        self.assertEqual(state["boardCounts"], {"13": 3, "17": 2})
        self.assertEqual(state["seatCounts"], {"A": 5, "B": 5, "C": 5})
        self.assertTrue(state["rngStatePresent"])
        self.assertTrue(state["stateConsistent"])

    def test_ignores_corrupt_checkpoint_and_reports_invalid_ledger_rows(self) -> None:
        root = self.make_root()
        records = [formal_record(1), formal_record(1), {"kind": "benchmark", "game_id": "bench"}]
        self.write_ledger(root, records)
        self.write_replay(root, ["game-1"])
        (root / "checkpoints" / "broken.pt").write_bytes(b"not-a-checkpoint")

        state = audit_training_state(root, git_sha="ghi789", write_manifest=False)

        self.assertEqual(state["ledgerFormalEpisodes"], 1)
        self.assertEqual(state["duplicateGameIds"], 1)
        self.assertEqual(state["invalidLedgerRows"], 0)
        self.assertEqual(state["excludedLedgerRows"], 1)
        self.assertIsNone(state["latestCheckpoint"])
        self.assertIn("broken.pt", state["checkpointErrors"])
        self.assertFalse(state["stateConsistent"])

    def test_audits_experiment_ledger_without_counting_formal_games(self) -> None:
        root = self.make_root()
        self.write_ledger(root, [experiment_record(1), experiment_record(2, 17)])
        self.write_replay(root, ["game-2"])
        write_checkpoint(root / "checkpoints" / "latest.pt", 2)
        (root / "logs" / "progress.json").write_text(
            json.dumps({"counter": 2, "path": "checkpoints/latest.pt"}), encoding="utf-8"
        )

        state = audit_training_state(
            root,
            git_sha="replica123",
            write_manifest=False,
            record_kind="experiment",
        )

        self.assertEqual(state["recordKind"], "experiment")
        self.assertEqual(state["episodeCount"], 2)
        self.assertEqual(state["ledgerEpisodeCount"], 2)
        self.assertEqual(state["formalEpisodes"], 0)
        self.assertEqual(state["ledgerFormalEpisodes"], 0)
        self.assertEqual(state["boardCounts"], {"13": 1, "17": 1})
        self.assertTrue(state["stateConsistent"])


if __name__ == "__main__":
    unittest.main()
