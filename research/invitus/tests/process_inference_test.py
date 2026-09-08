from __future__ import annotations

import multiprocessing as mp
import sys
import unittest
from pathlib import Path

import numpy as np
import torch

INVICTUS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INVICTUS_ROOT))

from inference.process_service import ProcessInferenceBroker


class DummyNet(torch.nn.Module):
    def forward(self, inputs):
        batch = inputs.shape[0]
        logits = torch.zeros((batch, 289), device=inputs.device)
        values = torch.log_softmax(torch.ones((batch, 4), device=inputs.device), dim=1)
        return logits, values


def client_process(client, ready, results):
    ready.wait(10)
    policy, value = client.infer_encoded(np.zeros((16, 17, 17), dtype=np.float32))
    results.put((policy.shape, len(value)))


class ProcessInferenceTest(unittest.TestCase):
    def test_process_clients_share_one_batched_model(self) -> None:
        context = mp.get_context("spawn")
        broker = ProcessInferenceBroker(
            DummyNet(), torch.device("cpu"), worker_count=4, max_batch_size=8,
            max_wait_ms=20, context=context,
        )
        ready = context.Event()
        results = context.Queue()
        processes = [
            context.Process(target=client_process, args=(broker.client(index), ready, results))
            for index in range(4)
        ]
        for process in processes:
            process.start()
        ready.set()
        outputs = [results.get(timeout=20) for _ in processes]
        for process in processes:
            process.join(timeout=20)
            self.assertEqual(process.exitcode, 0)
        metrics = broker.metrics_snapshot()
        broker.close()

        self.assertEqual(outputs, [((289,), 4)] * 4)
        self.assertEqual(metrics["completed"], 4)
        self.assertGreaterEqual(metrics["maxBatchObserved"], 2)


if __name__ == "__main__":
    unittest.main()
