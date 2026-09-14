"""Programmatic tactical error classification tests."""
from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import srszq
from eval.tactical_forensics import classify_candidate_turn


def trace(state: dict, move: tuple[int, int]) -> dict:
    return {
        "size": state["n"],
        "turn": state["turn"],
        "actor": srszq.current_player(state),
        "agent": "nn",
        "move": list(move),
        "rootTacticalReason": None,
        "board": ["".join("." if cell is None else cell for cell in row) for row in state["board"]],
    }


class TacticalForensicsTest(unittest.TestCase):
    def test_labels_missed_immediate_win(self) -> None:
        state = srszq.create_state(13)
        state["turn"] = state["moves"] = 21
        state["board"][0][0:3] = ["A", "A", "A"]
        self.assertEqual(classify_candidate_turn(trace(state, (12, 12))), "MISSED_IMMEDIATE_WIN")

    def test_labels_missed_unique_required_block(self) -> None:
        state = srszq.create_state(13)
        state["turn"] = state["moves"] = 18
        state["board"][5][0:3] = ["B", "B", "B"]
        self.assertEqual(classify_candidate_turn(trace(state, (12, 12))), "MISSED_REQUIRED_BLOCK")

    def test_labels_unanswered_double_threat(self) -> None:
        state = srszq.create_state(13)
        state["turn"] = state["moves"] = 18
        state["board"][5][0:3] = ["B", "B", "B"]
        state["board"][6][0:3] = ["B", "B", "B"]
        self.assertEqual(classify_candidate_turn(trace(state, (12, 12))), "DOUBLE_THREAT_MISS")

    def test_labels_missed_second_actor_threat(self) -> None:
        state = srszq.create_state(13)
        state["turn"] = state["moves"] = 15  # A, then B, then eligible C
        state["board"][5][0:3] = ["C", "C", "C"]
        self.assertEqual(classify_candidate_turn(trace(state, (12, 12))), "SHALLOW_2PLY_MISS")


if __name__ == "__main__":
    unittest.main()
