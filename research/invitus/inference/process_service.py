"""Cross-process clients with one parent-owned batched model."""
from __future__ import annotations

import multiprocessing as mp
import queue
import threading
import time
import uuid
from collections import deque
from multiprocessing.connection import Connection
from typing import Any

import numpy as np
import torch


class ProcessInferenceError(RuntimeError):
    pass


class ProcessInferenceClient:
    def __init__(
        self,
        worker_id: int,
        request_queue: Any,
        response_connection: Connection,
        timeout: float,
    ) -> None:
        self.worker_id = worker_id
        self.request_queue = request_queue
        self.response_connection = response_connection
        self.timeout = timeout
        self.sequence = 0

    def infer_encoded(self, planes: np.ndarray) -> tuple[np.ndarray, list[float]]:
        array = np.asarray(planes, dtype=np.float32)
        if array.shape != (16, 17, 17):
            raise ValueError(f"encoded state must have shape (16, 17, 17), got {array.shape}")
        self.sequence += 1
        request_id = f"{self.worker_id}:{self.sequence}:{uuid.uuid4().hex}"
        self.request_queue.put((self.worker_id, request_id, array), timeout=self.timeout)
        if not self.response_connection.poll(self.timeout):
            raise ProcessInferenceError(f"inference response timeout after {self.timeout:.3f}s")
        response_id, policy, value, error = self.response_connection.recv()
        if response_id != request_id:
            raise ProcessInferenceError("inference response id mismatch")
        if error is not None:
            raise ProcessInferenceError(error)
        return np.asarray(policy, dtype=np.float32), list(value)

    def evaluate_state(self, state: dict[str, Any]) -> tuple[np.ndarray, list[float]]:
        from model import encode

        return self.infer_encoded(np.asarray(encode.encode_state(state), dtype=np.float32))

    def metrics_snapshot(self) -> dict[str, str]:
        return {"mode": "process-client"}


class ProcessInferenceBroker:
    def __init__(
        self,
        model: torch.nn.Module,
        device: torch.device,
        worker_count: int,
        max_batch_size: int = 128,
        max_wait_ms: float = 2.0,
        request_timeout: float = 30.0,
        precision: str = "fp32",
        compile_model: bool = False,
        context: Any | None = None,
    ) -> None:
        if worker_count < 1 or max_batch_size < 1:
            raise ValueError("worker_count and max_batch_size must be positive")
        if precision not in {"fp32", "bf16"}:
            raise ValueError("precision must be fp32 or bf16")
        self.device = device
        self.max_batch_size = max_batch_size
        self.max_wait_seconds = max_wait_ms / 1000.0
        self.request_timeout = request_timeout
        self.precision = precision
        self.model = torch.compile(model) if compile_model else model
        self.model.eval()
        self.context = context or mp.get_context("spawn")
        self.request_queue = self.context.Queue(maxsize=max_batch_size * 8)
        self.client_connections: list[Connection] = []
        self.server_connections: list[Connection] = []
        for _ in range(worker_count):
            client_connection, server_connection = self.context.Pipe(duplex=True)
            self.client_connections.append(client_connection)
            self.server_connections.append(server_connection)
        self.stop_token = (None, None, None)
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.fatal_error: BaseException | None = None
        self.counters = {
            "requests": 0,
            "completed": 0,
            "batches": 0,
            "items": 0,
            "errors": 0,
            "maxBatchObserved": 0,
        }
        self.latencies_ms: deque[float] = deque(maxlen=100_000)
        self.inference_ms: deque[float] = deque(maxlen=100_000)
        self.batch_sizes: deque[int] = deque(maxlen=100_000)
        self.thread = threading.Thread(target=self._run, name="invitus-process-inference", daemon=True)
        self.thread.start()

    def client(self, worker_id: int) -> ProcessInferenceClient:
        return ProcessInferenceClient(
            worker_id,
            self.request_queue,
            self.client_connections[worker_id],
            self.request_timeout,
        )

    def _run(self) -> None:
        while not self.stop_event.is_set():
            item = self.request_queue.get()
            if item == self.stop_token:
                return
            batch = [(item, time.monotonic())]
            deadline = time.monotonic() + self.max_wait_seconds
            while len(batch) < self.max_batch_size:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    item = self.request_queue.get(timeout=remaining)
                except queue.Empty:
                    break
                if item == self.stop_token:
                    self.stop_event.set()
                    break
                batch.append((item, time.monotonic()))
            try:
                self._execute(batch)
            except BaseException as error:
                self._fail_fatally(error, batch)
                return

    def _execute(self, batch: list[tuple[tuple[int, str, np.ndarray], float]]) -> None:
        arrays = [item[0][2] for item in batch]
        inputs = torch.from_numpy(np.stack(arrays)).to(
            self.device, non_blocking=self.device.type == "cuda"
        )
        started = time.monotonic()
        self.model.eval()
        with torch.inference_mode(), torch.autocast(
            device_type=self.device.type,
            dtype=torch.bfloat16,
            enabled=self.precision == "bf16",
        ):
            logits, log_values = self.model(inputs)
        if not torch.isfinite(logits).all() or not torch.isfinite(log_values).all():
            raise FloatingPointError("model inference produced NaN or Inf")
        policies = logits.detach().float().cpu().numpy()
        values = torch.exp(log_values.detach().float()).cpu().numpy()
        finished = time.monotonic()
        for index, ((worker_id, request_id, _), enqueued_at) in enumerate(batch):
            self.server_connections[worker_id].send(
                (request_id, policies[index], values[index].tolist(), None)
            )
            self.latencies_ms.append((finished - enqueued_at) * 1000.0)
        with self.lock:
            size = len(batch)
            self.counters["requests"] += size
            self.counters["completed"] += size
            self.counters["batches"] += 1
            self.counters["items"] += size
            self.counters["maxBatchObserved"] = max(self.counters["maxBatchObserved"], size)
            self.batch_sizes.append(size)
            self.inference_ms.append((finished - started) * 1000.0)

    def _fail_fatally(
        self,
        error: BaseException,
        active: list[tuple[tuple[int, str, np.ndarray], float]],
    ) -> None:
        self.fatal_error = error
        with self.lock:
            self.counters["errors"] += 1
        pending = list(active)
        while True:
            try:
                item = self.request_queue.get_nowait()
            except queue.Empty:
                break
            if item != self.stop_token:
                pending.append((item, time.monotonic()))
        for (worker_id, request_id, _), _ in pending:
            self.server_connections[worker_id].send((request_id, None, None, str(error)))

    @staticmethod
    def _percentile(values: list[float], percentile: float) -> float:
        if not values:
            return 0.0
        return float(np.percentile(np.asarray(values, dtype=np.float64), percentile))

    def metrics_snapshot(self) -> dict[str, int | float | str | None]:
        with self.lock:
            counters = dict(self.counters)
            latencies = list(self.latencies_ms)
            inference = list(self.inference_ms)
            batch_sizes = list(self.batch_sizes)
        batches = counters["batches"]
        actual_batch_mean = counters["items"] / batches if batches else 0.0
        return {
            **counters,
            "precision": self.precision,
            "queueDepth": self.request_queue.qsize(),
            "actualBatchMean": round(actual_batch_mean, 3),
            "batchFillPercent": round(actual_batch_mean / self.max_batch_size * 100.0, 3),
            "latencyP50Ms": round(self._percentile(latencies, 50), 3),
            "latencyP95Ms": round(self._percentile(latencies, 95), 3),
            "inferenceP50Ms": round(self._percentile(inference, 50), 3),
            "inferenceP95Ms": round(self._percentile(inference, 95), 3),
            "lastBatchSize": batch_sizes[-1] if batch_sizes else 0,
            "fatalError": str(self.fatal_error) if self.fatal_error else None,
        }

    def close(self) -> None:
        if not self.stop_event.is_set():
            self.stop_event.set()
            try:
                self.request_queue.put_nowait(self.stop_token)
            except queue.Full:
                pass
        self.thread.join(timeout=2.0)
        for connection in self.client_connections + self.server_connections:
            try:
                connection.close()
            except OSError:
                pass
        self.request_queue.close()
