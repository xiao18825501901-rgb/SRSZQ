"""Persistent process workers for CPU-bound self-play with shared GPU inference."""
from __future__ import annotations

import multiprocessing as mp
import random
import traceback
from pathlib import Path
from typing import Any

import torch

from inference.process_service import ProcessInferenceBroker, ProcessInferenceClient


def _worker_main(
    worker_id: int,
    job_queue: Any,
    result_queue: Any,
    inference_client: ProcessInferenceClient,
    historical_paths: list[str],
    repo_root: str,
) -> None:
    from training.league import TacticBridge, load_historical_networks, play_league_episode

    torch.set_num_threads(1)
    device = torch.device("cpu")
    historical_networks = load_historical_networks(historical_paths, device)
    bridge = TacticBridge(Path(repo_root))
    try:
        while True:
            job = job_queue.get()
            if job is None:
                return
            job_id, seed, sims, checkpoint_id = job
            try:
                samples, metadata = play_league_episode(
                    None,
                    device,
                    sims,
                    random.Random(seed),
                    checkpoint_id,
                    bridge,
                    historical_networks,
                    8,
                    inference_client,
                )
                result_queue.put((job_id, samples, metadata, None))
            except BaseException as error:
                result_queue.put(
                    (job_id, None, None, f"{type(error).__name__}: {error}\n{traceback.format_exc()}")
                )
    finally:
        bridge.close()


class ProcessSelfPlayPool:
    def __init__(
        self,
        broker: ProcessInferenceBroker,
        worker_count: int,
        historical_paths: list[str],
        repo_root: str | Path,
        context: Any | None = None,
    ) -> None:
        self.context = context or broker.context
        self.worker_count = worker_count
        self.job_queue = self.context.Queue(maxsize=worker_count * 2)
        self.result_queue = self.context.Queue(maxsize=worker_count * 2)
        self.processes = [
            self.context.Process(
                target=_worker_main,
                name=f"invitus-selfplay-{worker_id}",
                args=(
                    worker_id,
                    self.job_queue,
                    self.result_queue,
                    broker.client(worker_id),
                    historical_paths,
                    str(Path(repo_root).resolve()),
                ),
            )
            for worker_id in range(worker_count)
        ]
        for process in self.processes:
            process.start()

    def play(
        self,
        jobs: list[tuple[int, int, int, str]],
        timeout_seconds: float = 1800,
    ) -> list[tuple[list[dict[str, Any]], dict[str, Any]]]:
        for job in jobs:
            self.job_queue.put(job, timeout=30)
        results: dict[int, tuple[list[dict[str, Any]], dict[str, Any]]] = {}
        for _ in jobs:
            job_id, samples, metadata, error = self.result_queue.get(timeout=timeout_seconds)
            if error is not None:
                raise RuntimeError(f"self-play worker failed for job {job_id}: {error}")
            results[job_id] = samples, metadata
        return [results[job[0]] for job in jobs]

    def close(self) -> None:
        for _ in self.processes:
            self.job_queue.put(None)
        for process in self.processes:
            process.join(timeout=10)
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
        self.job_queue.close()
        self.result_queue.close()
