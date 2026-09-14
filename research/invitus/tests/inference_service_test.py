from __future__ import annotations

import concurrent.futures
import sys
import threading
import time
import unittest
from pathlib import Path

import numpy as np
import torch

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from engine import srszq
from inference.service import InferenceService, InferenceServiceError
from mcts.nn_mcts import NNMCTS


class CountingModel(torch.nn.Module):
    def __init__(self, fail: bool = False, value_representation: str = "absolute") -> None:
        super().__init__()
        self.fail = fail
        self.value_representation = value_representation
        self.batch_sizes: list[int] = []
        self.lock = threading.Lock()

    def forward(self, inputs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        if self.fail:
            raise RuntimeError("model failure")
        with self.lock:
            self.batch_sizes.append(inputs.shape[0])
        marker = inputs[:, 0, 0, 0].reshape(-1, 1)
        policy = marker.repeat(1, 17 * 17)
        values = torch.stack((marker[:, 0], marker[:, 0] + 1, marker[:, 0] + 2, marker[:, 0] + 3), dim=1)
        return policy, torch.log_softmax(values, dim=1)


class InferenceServiceTest(unittest.TestCase):
    def test_concurrent_requests_are_collected_into_real_batches(self) -> None:
        model = CountingModel()
        service = InferenceService(model, torch.device("cpu"), max_batch_size=8, max_wait_ms=40)
        barrier = threading.Barrier(8)

        def infer(index: int) -> float:
            planes = np.zeros((16, 17, 17), dtype=np.float32)
            planes[0, 0, 0] = index
            barrier.wait()
            policy, _ = service.infer_encoded(planes)
            return float(policy[0])

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                results = list(executor.map(infer, range(8)))
            self.assertEqual(results, [float(index) for index in range(8)])
            self.assertTrue(any(size > 1 for size in model.batch_sizes), model.batch_sizes)
            metrics = service.metrics_snapshot()
            self.assertEqual(metrics["requests"], 8)
            self.assertEqual(metrics["completed"], 8)
            self.assertGreater(metrics["actualBatchMean"], 1.0)
        finally:
            service.close()

    def test_nnmcts_uses_the_shared_service_instead_of_direct_model_calls(self) -> None:
        model = CountingModel()
        service = InferenceService(model, torch.device("cpu"), max_batch_size=4, max_wait_ms=1)
        try:
            search = NNMCTS(
                model,
                torch.device("cpu"),
                sims=2,
                train=False,
                inference_service=service,
            )
            state = srszq.create_state(13)
            search.search(state)
            move, _ = search.best_move(temperature=0.0)
            self.assertIn(move, srszq.legal_moves(state))
            self.assertGreater(service.metrics_snapshot()["completed"], 0)
        finally:
            service.close()

    def test_model_failure_is_fatal_and_unblocks_callers(self) -> None:
        service = InferenceService(
            CountingModel(fail=True),
            torch.device("cpu"),
            max_batch_size=2,
            max_wait_ms=1,
            request_timeout=1.0,
        )
        planes = np.zeros((16, 17, 17), dtype=np.float32)
        try:
            with self.assertRaisesRegex(InferenceServiceError, "model failure"):
                service.infer_encoded(planes)
            started = time.monotonic()
            with self.assertRaises(InferenceServiceError):
                service.infer_encoded(planes)
            self.assertLess(time.monotonic() - started, 0.1)
            self.assertEqual(service.metrics_snapshot()["errors"], 1)
        finally:
            service.close()

    def test_actor_relative_service_output_is_absolute_before_backup(self) -> None:
        model = CountingModel(value_representation="actor_relative")
        service = InferenceService(model, torch.device("cpu"), max_batch_size=2, max_wait_ms=1)
        state = srszq.create_state(13)
        state["turn"] = 1  # B to move
        try:
            search = NNMCTS(model, torch.device("cpu"), sims=1, inference_service=service)
            _, value = search._net_eval(state)
            raw = torch.softmax(torch.tensor([0.0, 1.0, 2.0, 3.0]), dim=0).tolist()
            self.assertEqual(service.value_representation, "actor_relative")
            self.assertAlmostEqual(value[0], raw[2])  # previous actor A
            self.assertAlmostEqual(value[1], raw[0])  # current actor B
            self.assertAlmostEqual(value[2], raw[1])  # next actor C
            self.assertAlmostEqual(value[3], raw[3])
        finally:
            service.close()


if __name__ == "__main__":
    unittest.main()
