from __future__ import annotations

import json
import random
import sys
import tempfile
import textwrap
import unittest
from collections import Counter
from pathlib import Path

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from engine import srszq
import torch

from training.league import TacticBridge, discover_historical_checkpoints, sample_composition
from training.train import make_ledger_record


class OpponentLeagueTest(unittest.TestCase):
    def fake_worker(self, body: str) -> list[str]:
        directory = Path(tempfile.mkdtemp())
        worker = directory / "worker.py"
        worker.write_text(
            "import json, sys, time\n"
            "for line in sys.stdin:\n"
            "    req = json.loads(line)\n"
            + textwrap.indent(textwrap.dedent(body).strip() + "\n", "    "),
            encoding="utf-8",
        )
        return [sys.executable, "-u", str(worker)]

    def test_bridge_accepts_matching_legal_response_and_reports_health(self) -> None:
        command = self.fake_worker(
            """
            print(json.dumps({"id": req["id"], "row": 0, "col": 0, "pass": False}), flush=True)
            """
        )
        bridge = TacticBridge(INVICTUS_ROOT.parents[1], timeout=0.5, command=command)
        try:
            state = srszq.create_state(13)
            self.assertEqual(bridge.move(state, "A", "random", 42), (0, 0))
            self.assertEqual(bridge.metrics["successfulResponses"], 1)
            self.assertEqual(bridge.metrics["fallbacks"], 0)
            self.assertTrue(bridge.healthy)
        finally:
            bridge.close()

    def test_bridge_times_out_restarts_and_records_fallback(self) -> None:
        command = self.fake_worker(
            """
            time.sleep(0.2)
            print(json.dumps({"id": req["id"], "row": 0, "col": 0, "pass": False}), flush=True)
            """
        )
        bridge = TacticBridge(INVICTUS_ROOT.parents[1], timeout=0.02, command=command)
        try:
            state = srszq.create_state(13)
            self.assertEqual(bridge.move(state, "A", "random", 42), (0, 0))
            self.assertEqual(bridge.metrics["timeouts"], 1)
            self.assertEqual(bridge.metrics["restarts"], 1)
            self.assertEqual(bridge.metrics["fallbacks"], 1)
            self.assertFalse(bridge.healthy)
        finally:
            bridge.close()

    def test_bridge_rejects_a_response_for_another_request(self) -> None:
        command = self.fake_worker(
            """
            print(json.dumps({"id": "wrong-id", "row": 0, "col": 0, "pass": False}), flush=True)
            """
        )
        bridge = TacticBridge(INVICTUS_ROOT.parents[1], timeout=0.5, command=command)
        try:
            state = srszq.create_state(13)
            bridge.move(state, "A", "random", 42)
            self.assertEqual(bridge.metrics["protocolErrors"], 1)
            self.assertEqual(bridge.metrics["fallbacks"], 1)
            self.assertFalse(bridge.healthy)
        finally:
            bridge.close()

    def test_composition_matches_the_initial_50_20_20_10_contract(self) -> None:
        rng = random.Random(20260908)
        buckets = Counter()
        strong_specs = set()
        diverse_specs = set()
        for _ in range(50_000):
            composition = sample_composition(rng, ["historical.pt"])
            buckets[composition.bucket] += 1
            specs = {agent[1] for agent in composition.seats.values() if agent[0] == "tactic"}
            if composition.bucket == "strong":
                strong_specs.update(specs)
            if composition.bucket == "diverse":
                diverse_specs.update(specs)

        expected = {"selfplay": 0.50, "historical": 0.20, "strong": 0.20, "diverse": 0.10}
        for bucket, probability in expected.items():
            self.assertLess(abs(buckets[bucket] / 50_000 - probability), 0.01)
        self.assertEqual(strong_specs, {"maxn", "3ply", 5})
        self.assertEqual(diverse_specs, {"random", "tactical", "selfish", 1, 2, 3, 4})

    def test_league_refuses_to_silently_drop_the_historical_bucket(self) -> None:
        with self.assertRaisesRegex(ValueError, "historical checkpoint"):
            sample_composition(random.Random(1), [])

    def test_historical_discovery_uses_embedded_counters_and_ignores_corrupt_files(self) -> None:
        checkpoint_dir = Path(tempfile.mkdtemp())
        torch.save(
            {"counter": 2, "net": "Tiny", "cfg": {"channels": 32, "blocks": 4}, "model": {}},
            checkpoint_dir / "invitus_999999.pt",
        )
        torch.save(
            {"counter": 10, "net": "Small", "cfg": {"channels": 64, "blocks": 6}, "model": {}},
            checkpoint_dir / "invitus_000001.pt",
        )
        (checkpoint_dir / "broken.pt").write_bytes(b"broken")

        paths, errors = discover_historical_checkpoints(checkpoint_dir, limit=8)

        self.assertEqual([Path(path).name for path in paths], ["invitus_999999.pt", "invitus_000001.pt"])
        self.assertIn("broken.pt", errors)

    def test_formal_ledger_record_preserves_truthful_league_metadata(self) -> None:
        metadata = {
            "game_id": "game-1",
            "boardSize": 17,
            "seats": {"A": ("invitus",), "B": ("tactic", "maxn"), "C": ("tactic", 5)},
            "league_bucket": "strong",
            "mcts_sims": 32,
            "num_samples": 42,
            "result": "A_WIN",
            "seconds": 1.25,
            "bridge_metrics": {"requests": 10, "fallbacks": 0},
        }

        record = make_ledger_record(metadata, "invitus_000100")

        self.assertTrue(record["formal"])
        self.assertTrue(record["replay_persisted"])
        self.assertEqual(record["seat_assignments"], metadata["seats"])
        self.assertEqual(record["opponents"], "league:strong")
        self.assertEqual(record["bridge_metrics"]["fallbacks"], 0)


if __name__ == "__main__":
    unittest.main()
