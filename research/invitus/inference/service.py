"""Bounded micro-batching service that owns one model and one device."""
from __future__ import annotations

import queue
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import torch

from model import encode


class InferenceServiceError(RuntimeError):
    pass


@dataclass
class _Request:
    planes: np.ndarray
    enqueued_at: float = field(default_factory=time.monotonic)
    event: threading.Event = field(default_factory=threading.Event)
    result: tuple[np.ndarray, list[float]] | None = None
    error: BaseException | None = None


class InferenceService:
    def __init__(
        self,
        model: torch.nn.Module,
        device: torch.device,
        max_batch_size: int = 128,
        max_wait_ms: float = 2.0,
        request_timeout: float = 30.0,
        precision: str = "fp32",
        compile_model: bool = False,
        queue_capacity: int | None = None,
    ) -> None:
        if max_batch_size < 1:
            raise ValueError("max_batch_size must be positive")
        if max_wait_ms < 0:
            raise ValueError("max_wait_ms cannot be negative")
        if precision not in {"fp32", "bf16"}:
            raise ValueError("precision must be fp32 or bf16")
        self.device = device
        self.max_batch_size = max_batch_size
        self.max_wait_seconds = max_wait_ms / 1000.0
        self.request_timeout = request_timeout
        self.precision = precision
        self.value_representation = getattr(model, "value_representation", "absolute")
        self.model = torch.compile(model) if compile_model else model
        self.model.eval()
        self.requests: queue.Queue[_Request | object] = queue.Queue(
            maxsize=queue_capacity or max_batch_size * 8
        )
        self.stop_token = object()
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
        self.worker = threading.Thread(target=self._run, name="invitus-inference", daemon=True)
        self.worker.start()

    def _raise_if_fatal(self) -> None:
        if self.fatal_error is not None:
            raise InferenceServiceError(str(self.fatal_error)) from self.fatal_error

    def infer_encoded(self, planes: np.ndarray) -> tuple[np.ndarray, list[float]]:
        self._raise_if_fatal()
        array = np.asarray(planes, dtype=np.float32)
        if array.shape != (16, 17, 17):
            raise ValueError(f"encoded state must have shape (16, 17, 17), got {array.shape}")
        request = _Request(array)
        with self.lock:
            self.counters["requests"] += 1
        try:
            self.requests.put(request, timeout=self.request_timeout)
        except queue.Full as error:
            raise InferenceServiceError("inference request queue is full") from error
        if not request.event.wait(self.request_timeout):
            error = TimeoutError(f"inference response timeout after {self.request_timeout:.3f}s")
            self.fatal_error = error
            with self.lock:
                self.counters["errors"] += 1
            raise InferenceServiceError(str(error)) from error
        if request.error is not None:
            raise InferenceServiceError(str(request.error)) from request.error
        if request.result is None:
            raise InferenceServiceError("inference request completed without a result")
        return request.result

    def evaluate_state(self, state: dict[str, Any]) -> tuple[np.ndarray, list[float]]:
        return self.infer_encoded(np.asarray(encode.encode_state(state), dtype=np.float32))

    def _run(self) -> None:
        while not self.stop_event.is_set():
            item = self.requests.get()
            if item is self.stop_token:
                return
            assert isinstance(item, _Request)
            batch = [item]
            deadline = time.monotonic() + self.max_wait_seconds
            while len(batch) < self.max_batch_size:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    item = self.requests.get(timeout=remaining)
                except queue.Empty:
                    break
                if item is self.stop_token:
                    self.stop_event.set()
                    break
                assert isinstance(item, _Request)
                batch.append(item)
            try:
                self._execute(batch)
            except BaseException as error:
                self._fail_fatally(error, batch)
                return

    def _execute(self, requests: list[_Request]) -> None:
        self.model.eval()
        inputs = torch.from_numpy(np.stack([request.planes for request in requests])).to(
            self.device,
            non_blocking=self.device.type == "cuda",
        )
        started = time.monotonic()
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
        for index, request in enumerate(requests):
            request.result = policies[index], values[index].tolist()
            request.event.set()
            self.latencies_ms.append((finished - request.enqueued_at) * 1000.0)
        with self.lock:
            size = len(requests)
            self.counters["completed"] += size
            self.counters["batches"] += 1
            self.counters["items"] += size
            self.counters["maxBatchObserved"] = max(self.counters["maxBatchObserved"], size)
            self.batch_sizes.append(size)
            self.inference_ms.append((finished - started) * 1000.0)

    def _fail_fatally(self, error: BaseException, active: list[_Request]) -> None:
        self.fatal_error = error
        with self.lock:
            self.counters["errors"] += 1
        pending = list(active)
        while True:
            try:
                item = self.requests.get_nowait()
            except queue.Empty:
                break
            if isinstance(item, _Request):
                pending.append(item)
        for request in pending:
            request.error = error
            request.event.set()

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
            "queueDepth": self.requests.qsize(),
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
        if self.stop_event.is_set():
            self.worker.join(timeout=1.0)
            return
        self.stop_event.set()
        try:
            self.requests.put_nowait(self.stop_token)
        except queue.Full:
            pass
        self.worker.join(timeout=2.0)
