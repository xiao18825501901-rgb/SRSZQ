from __future__ import annotations

import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

import torch

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from training import train


class TrainingStorageTest(unittest.TestCase):
    def test_disk_space_policy_has_start_warning_and_stop_gates(self) -> None:
        gib = 1024 ** 3
        self.assertEqual(train.classify_disk_space(150 * gib, 100), "ok")
        self.assertEqual(train.classify_disk_space(50 * gib, 100), "start_blocked")
        self.assertEqual(train.classify_disk_space(15 * gib, 0), "warning")
        self.assertEqual(train.classify_disk_space(9 * gib, 0), "stop")

    def test_configure_storage_routes_all_large_state_under_data_root(self) -> None:
        root = Path(tempfile.mkdtemp()) / "invitus-data"

        paths = train.configure_storage(root)

        self.assertEqual(Path(paths["ledger"]), root / "logs" / "INVICTUS_TRAINING_LEDGER.jsonl")
        self.assertEqual(Path(paths["progress"]), root / "logs" / "progress.json")
        self.assertEqual(Path(paths["checkpoints"]), root / "checkpoints")
        self.assertEqual(Path(paths["replay"]), root / "replay")
        self.assertEqual(Path(paths["stop"]), root / "logs" / "STOP")
        for name in ("logs", "checkpoints", "replay"):
            self.assertTrue((root / name).is_dir())

    def test_checkpoint_and_progress_are_atomically_persisted_and_loadable(self) -> None:
        root = Path(tempfile.mkdtemp()) / "invitus-data"
        train.configure_storage(root)
        network = torch.nn.Linear(2, 2)
        optimizer = torch.optim.AdamW(network.parameters())
        scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=2)
        loss = network(torch.ones((1, 2))).sum()
        loss.backward()
        optimizer.step()
        checkpoint = root / "checkpoints" / "latest.pt"

        train.save_ckpt(
            str(checkpoint),
            network,
            optimizer,
            scheduler,
            8,
            random.getstate(),
            {"channels": 32, "blocks": 4},
            {"wave": 1},
        )

        stored = torch.load(checkpoint, map_location="cpu", weights_only=False)
        progress = json.loads((root / "logs" / "progress.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["counter"], 8)
        self.assertEqual(progress["counter"], 8)
        self.assertEqual(Path(progress["path"]), checkpoint)
        self.assertEqual(list(root.rglob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
