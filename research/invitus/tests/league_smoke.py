"""Local integration smoke for the real TypeScript tactic worker and league."""
from __future__ import annotations

import os
import random
import sys
from collections import Counter

sys.path.insert(0, ".")

from engine import srszq
from model.network import make_model
from training.league import TacticBridge, play_league_episode, sample_composition


def test_bridge_legal() -> None:
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    with TacticBridge(repo_root, timeout=3.0) as bridge:
        for specification in ["random", "tactical", "selfish", "3ply", "maxn", 1, 2, 3, 4, 5]:
            state = srszq.create_state(13)
            for _ in range(4):
                legal = srszq.legal_moves(state)
                if not legal:
                    break
                row, col = random.Random(1).choice(legal)
                srszq.apply_move(state, row, col)
            player = srszq.current_player(state)
            move = bridge.move(state, player, specification, 42)
            assert move in srszq.legal_moves(state), f"{specification} returned illegal move {move}"
        assert bridge.healthy, bridge.last_error
        assert bridge.metrics["successfulResponses"] == 10, bridge.metrics
        assert bridge.metrics["fallbacks"] == 0, (bridge.metrics, list(bridge.stderr_tail))
        print("PASS bridge: real worker handled 5 tactics and 5 difficulties", bridge.metrics, flush=True)


def test_composition() -> None:
    rng = random.Random(3)
    counts = Counter(sample_composition(rng, ["historical.pt"]).bucket for _ in range(10_000))
    ratios = {bucket: round(count / 10_000, 4) for bucket, count in sorted(counts.items())}
    assert set(ratios) == {"selfplay", "historical", "strong", "diverse"}, ratios
    print("PASS composition:", ratios, flush=True)


def test_league_game() -> None:
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    network, device = make_model(32, 4)
    historical = {"historical-smoke.pt": make_model(32, 4)[0]}
    with TacticBridge(repo_root, timeout=3.0) as bridge:
        samples, metadata = play_league_episode(
            network,
            device,
            4,
            random.Random(5),
            "invitus_smoke",
            bridge,
            historical,
            8,
        )
        assert metadata["game_id"]
        assert metadata["num_samples"] > 0
        assert all(sample["outcome"] is not None for sample in samples)
        assert metadata["bridge_metrics"]["fallbacks"] == 0, metadata
        print(
            "PASS league game:",
            metadata["result"],
            "samples",
            metadata["num_samples"],
            "bucket",
            metadata["league_bucket"],
            flush=True,
        )


if __name__ == "__main__":
    test_bridge_legal()
    test_composition()
    test_league_game()
    print("LEAGUE SMOKE: ALL PASS", flush=True)
