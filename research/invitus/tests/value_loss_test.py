"""Phase 4C configurable value-target/loss tests."""
from __future__ import annotations

import pathlib
import sys
import unittest

import torch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from model.network import InvitusNet
from training.train import compute_value_loss, prepare_value_targets


class ValueLossTest(unittest.TestCase):
    def test_actor_relative_batch_targets_follow_each_sample_actor(self) -> None:
        samples = [
            {"actor": "A", "outcome": [1, 0, 0, 0]},
            {"actor": "B", "outcome": [1, 0, 0, 0]},
            {"actor": "C", "outcome": [0, 1, 0, 0]},
        ]
        targets, masks = prepare_value_targets(samples, "actor_relative", value_smooth=0.0)
        self.assertEqual(targets.tolist(), [[1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 1, 0]])
        self.assertEqual(masks.tolist(), [1, 1, 1])

    def test_policy_only_samples_mask_value_loss(self) -> None:
        targets, masks = prepare_value_targets(
            [{"actor": "A", "outcome": None, "value_loss_mask": 0}],
            "absolute",
            value_smooth=0.0,
        )
        self.assertEqual(targets.tolist(), [[0, 0, 0, 0]])
        self.assertEqual(masks.tolist(), [0])
        log_values = torch.log_softmax(torch.tensor([[2.0, 1.0, 0.0, -1.0]]), dim=1)
        self.assertEqual(float(compute_value_loss(log_values, targets, masks, "ce")), 0.0)

    def test_ce_and_brier_use_probability_distribution(self) -> None:
        probabilities = torch.tensor([[0.7, 0.1, 0.1, 0.1]], dtype=torch.float32)
        log_values = probabilities.log()
        targets = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
        masks = torch.tensor([1.0])
        ce = compute_value_loss(log_values, targets, masks, "ce")
        brier = compute_value_loss(log_values, targets, masks, "brier")
        self.assertAlmostEqual(float(ce), -torch.log(torch.tensor(0.7)).item(), places=6)
        self.assertAlmostEqual(float(brier), (0.09 + 0.01 + 0.01 + 0.01) / 4, places=6)

    def test_network_records_value_representation_without_changing_shape(self) -> None:
        network = InvitusNet(channels=4, blocks=1, value_representation="actor_relative")
        _, log_values = network(torch.zeros((2, 16, 17, 17)))
        self.assertEqual(network.value_representation, "actor_relative")
        self.assertEqual(tuple(log_values.shape), (2, 4))


if __name__ == "__main__":
    unittest.main()
