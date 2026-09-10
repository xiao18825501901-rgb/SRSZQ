"""End-to-end GPU benchmark runner. Benchmark data is never formal training data."""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import statistics
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import torch

from engine import srszq
from inference.process_service import ProcessInferenceBroker
from inference.service import InferenceService
from model import encode
from model.network import InvitusNet, make_model
from training import train
from training.league import (
    TacticBridge,
    discover_historical_checkpoints,
    load_historical_networks,
    play_league_episode,
)
from training.replay import ReplayBuffer
from training.process_selfplay import ProcessSelfPlayPool


NETWORKS = {
    "tiny": (32, 4),
    "small": (64, 6),
    "medium": (96, 8),
}


def performance_gate(games_per_hour: float) -> str:
    if games_per_hour >= 1500:
        return "GREEN"
    if games_per_hour >= 700:
        return "YELLOW"
    return "RED"


def make_benchmark_record(meta: dict[str, Any], run_id: str, kind: str = "benchmark") -> dict[str, Any]:
    if kind not in {"benchmark", "smoke"}:
        raise ValueError("benchmark record kind must be benchmark or smoke")
    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": kind,
        "formal": False,
        "run_id": run_id,
        "game_id": meta["game_id"],
        "completed": True,
        "replay_persisted": True,
        "board_size": meta["boardSize"],
        "terminal_result": meta["result"],
        "num_samples": meta["num_samples"],
        "moves": meta.get("moves", 0),
        "mcts_nodes": meta.get("mcts_nodes", 0),
        "duration_seconds": meta["seconds"],
        "league_bucket": meta["league_bucket"],
    }


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


class ResourceSampler:
    """Sample GPU plus optional CPU/RAM utilization into a raw CSV file."""

    def __init__(self, path: Path, interval_seconds: float = 5.0) -> None:
        self.path = path
        self.interval_seconds = interval_seconds
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name="invitus-resource-sampler", daemon=True)
        self.samples: list[dict[str, float]] = []

    def start(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=max(2.0, self.interval_seconds + 1.0))

    def _sample(self) -> dict[str, float]:
        command = [
            "nvidia-smi",
            "--query-gpu=utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=5, check=True)
        gpu_util, memory_used, memory_total, power, temperature = [
            float(value.strip()) for value in result.stdout.strip().split(",")[:5]
        ]
        cpu_util = ram_util = float("nan")
        try:
            import psutil

            cpu_util = float(psutil.cpu_percent(interval=None))
            ram_util = float(psutil.virtual_memory().percent)
        except ImportError:
            pass
        return {
            "timestamp": time.time(),
            "gpuUtilPercent": gpu_util,
            "memoryUsedMiB": memory_used,
            "memoryTotalMiB": memory_total,
            "powerW": power,
            "temperatureC": temperature,
            "cpuUtilPercent": cpu_util,
            "ramUtilPercent": ram_util,
        }

    def _run(self) -> None:
        fieldnames = [
            "timestamp",
            "gpuUtilPercent",
            "memoryUsedMiB",
            "memoryTotalMiB",
            "powerW",
            "temperatureC",
            "cpuUtilPercent",
            "ramUtilPercent",
        ]
        with open(self.path, "w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=fieldnames)
            writer.writeheader()
            stream.flush()
            while not self.stop_event.is_set():
                try:
                    sample = self._sample()
                    self.samples.append(sample)
                    writer.writerow(sample)
                    stream.flush()
                except (OSError, ValueError, subprocess.SubprocessError):
                    pass
                self.stop_event.wait(self.interval_seconds)

    def summary(self) -> dict[str, float | int | None]:
        def mean(key: str) -> float | None:
            values = [sample[key] for sample in self.samples if np.isfinite(sample[key])]
            return round(statistics.fmean(values), 3) if values else None

        return {
            "sampleCount": len(self.samples),
            "gpuUtilMeanPercent": mean("gpuUtilPercent"),
            "vramUsedMeanMiB": mean("memoryUsedMiB"),
            "vramUsedMaxMiB": round(max((s["memoryUsedMiB"] for s in self.samples), default=0.0), 3),
            "powerMeanW": mean("powerW"),
            "temperatureMeanC": mean("temperatureC"),
            "cpuUtilMeanPercent": mean("cpuUtilPercent"),
            "ramUtilMeanPercent": mean("ramUtilPercent"),
        }


def warmup(service: InferenceService, passes: int, workers: int) -> float:
    state = srszq.create_state(17)
    planes = np.asarray(encode.encode_state(state), dtype=np.float32)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(service.infer_encoded, planes) for _ in range(passes)]
        for future in futures:
            future.result()
    if service.device.type == "cuda":
        torch.cuda.synchronize(service.device)
    return time.monotonic() - started


def warmup_process_broker(
    broker: ProcessInferenceBroker, passes: int, workers: int
) -> float:
    state = srszq.create_state(17)
    planes = np.asarray(encode.encode_state(state), dtype=np.float32)
    clients = [broker.client(index) for index in range(workers)]
    counts = [passes // workers + (1 if index < passes % workers else 0) for index in range(workers)]

    def run_client(index: int) -> None:
        for _ in range(counts[index]):
            clients[index].infer_encoded(planes)

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(run_client, index) for index in range(workers) if counts[index]]
        for future in futures:
            future.result()
    if broker.device.type == "cuda":
        torch.cuda.synchronize(broker.device)
    return time.monotonic() - started


def run(args: argparse.Namespace) -> dict[str, Any]:
    if not torch.cuda.is_available() and not args.allow_cpu:
        raise RuntimeError("GPU benchmark requires torch.cuda.is_available()=True")
    channels, blocks = NETWORKS[args.network]
    data_root = Path(args.data_root).expanduser().resolve()
    disk = train.configure_storage(data_root)
    disk_snapshot = train.disk_space_snapshot(args.min_free_gib)
    if disk_snapshot["status"] in {"stop", "start_blocked"}:
        raise RuntimeError(f"benchmark data disk gate failed: {disk_snapshot}")
    run_id = args.run_id or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    run_root = data_root / "benchmarks" / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    ledger_path = run_root / "ledger.jsonl"
    replay = ReplayBuffer(run_root / "replay", max_shards=max(64, args.games * 2))

    net, device = make_model(channels, blocks)
    optimizer = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=20_000, gamma=0.5)
    history_dir = Path(args.history_dir).expanduser().resolve() if args.history_dir else Path(disk["checkpoints"])
    history_paths, history_errors = discover_historical_checkpoints(history_dir, limit=args.history_limit)
    if history_errors:
        print(json.dumps({"event": "historical_checkpoint_errors", "errors": history_errors}), flush=True)
    if not history_paths:
        raise RuntimeError(f"no valid historical checkpoints found in {history_dir}")

    repo_root = Path(__file__).resolve().parents[3]
    service: InferenceService | ProcessInferenceBroker
    process_pool: ProcessSelfPlayPool | None = None
    bridge: TacticBridge | None = None
    historical_networks: dict[str, Any] = {}
    if args.execution == "processes":
        service = ProcessInferenceBroker(
            net,
            device,
            worker_count=args.workers,
            max_batch_size=args.batch,
            max_wait_ms=args.inference_wait_ms,
            precision=args.precision,
            compile_model=args.compile_model,
        )
        compile_and_warmup_seconds = warmup_process_broker(
            service, args.warmup_passes, args.workers
        )
        process_pool = ProcessSelfPlayPool(
            service, args.workers, history_paths, repo_root
        )
    else:
        service = InferenceService(
            net,
            device,
            max_batch_size=args.batch,
            max_wait_ms=args.inference_wait_ms,
            precision=args.precision,
            compile_model=args.compile_model,
        )
        compile_and_warmup_seconds = warmup(service, args.warmup_passes, args.workers)
        historical_networks = load_historical_networks(history_paths, device)
        bridge = TacticBridge(repo_root)
    bridge_metrics = {
        "requests": 0,
        "successfulResponses": 0,
        "fallbacks": 0,
        "timeouts": 0,
        "protocolErrors": 0,
        "processErrors": 0,
        "restarts": 0,
    }
    sampler = ResourceSampler(run_root / "gpu_metrics.csv", args.sample_interval)
    sampler.start()
    rng = random.Random(args.seed)
    started = time.monotonic()
    completed = total_samples = total_moves = total_nodes = 0
    try:
        while completed < args.games:
            wave_games = min(args.games_per_wave, args.games - completed)
            seeds = [rng.getrandbits(64) for _ in range(wave_games)]
            if process_pool is not None:
                jobs = [
                    (completed + index, seed, args.sims, run_id)
                    for index, seed in enumerate(seeds)
                ]
                episode_results = process_pool.play(jobs)
            else:
                assert bridge is not None
                with ThreadPoolExecutor(max_workers=args.workers) as executor:
                    futures = [
                        executor.submit(
                            play_league_episode,
                            net,
                            device,
                            args.sims,
                            random.Random(seed),
                            run_id,
                            bridge,
                            historical_networks,
                            8,
                            service,
                        )
                        for seed in seeds
                    ]
                    episode_results = [future.result() for future in futures]
            wave_samples: list[dict[str, Any]] = []
            for samples, meta in episode_results:
                if not samples:
                    raise RuntimeError(f"benchmark game {meta['game_id']} produced no training samples")
                for sample in samples:
                    replay.add(sample)
                replay.flush()
                append_jsonl(
                    ledger_path,
                    make_benchmark_record(meta, run_id, "smoke" if args.stage == "smoke" else "benchmark"),
                )
                for key, value in meta.get("bridge_metrics", {}).items():
                    bridge_metrics[key] += value
                wave_samples.extend(samples)
                completed += 1
                total_samples += len(samples)
                total_moves += int(meta.get("moves", 0))
                total_nodes += int(meta.get("mcts_nodes", 0))
            if wave_samples and args.train_steps_per_wave:
                for _ in range(args.train_steps_per_wave):
                    selected = [rng.choice(wave_samples) for _ in range(args.train_batch)]
                    policy_loss, value_loss, loss, gradient_norm, policy_entropy = train.train_batch(
                        net, device, optimizer, selected
                    )
                    if not all(np.isfinite(value) for value in (policy_loss, value_loss, loss, gradient_norm)):
                        raise FloatingPointError("benchmark training produced NaN or Inf")
                scheduler.step()
            if bridge_metrics["fallbacks"] or service.metrics_snapshot()["errors"]:
                raise RuntimeError(
                    f"benchmark dependency failure: bridge={bridge_metrics} inference={service.metrics_snapshot()}"
                )
            print(json.dumps({"event": "benchmark_progress", "completed": completed, "target": args.games}), flush=True)
    finally:
        elapsed = time.monotonic() - started
        sampler.stop()
        if process_pool is not None:
            process_pool.close()
        if bridge is not None:
            bridge.close()
        service_metrics = service.metrics_snapshot()
        service.close()

    checkpoint_path = run_root / "checkpoints" / "benchmark_final.pt"
    train.configure_storage(run_root)
    config = {
        "network": args.network,
        "channels": channels,
        "blocks": blocks,
        "workers": args.workers,
        "execution": args.execution,
        "batch": args.batch,
        "sims": args.sims,
        "precision": args.precision,
        "compile": args.compile_model,
        "stage": args.stage,
    }
    train.save_ckpt(
        checkpoint_path,
        net,
        optimizer,
        scheduler,
        completed,
        rng.getstate(),
        config,
        {"benchmark": True, "formal": False, "run_id": run_id},
    )
    verify_net = InvitusNet(channels, blocks).to(device)
    verify_optimizer = torch.optim.AdamW(verify_net.parameters(), lr=2e-3, weight_decay=1e-4)
    verify_scheduler = torch.optim.lr_scheduler.StepLR(verify_optimizer, step_size=20_000, gamma=0.5)
    restored_count, restored_rng = train.load_ckpt(
        verify_net, verify_optimizer, verify_scheduler, checkpoint_path
    )
    if restored_count != completed or restored_rng is None:
        raise RuntimeError("benchmark checkpoint resume verification failed")

    games_per_hour = completed / max(elapsed, 1e-9) * 3600
    result = {
        "runId": run_id,
        "stage": args.stage,
        "formal": False,
        "network": args.network,
        "channels": channels,
        "blocks": blocks,
        "workers": args.workers,
        "inferenceBatch": args.batch,
        "sims": args.sims,
        "precision": args.precision,
        "compile": args.compile_model,
        "warmupPasses": args.warmup_passes,
        "compileAndWarmupSeconds": round(compile_and_warmup_seconds, 3),
        "games": completed,
        "samples": total_samples,
        "moves": total_moves,
        "mctsNodes": total_nodes,
        "elapsedSeconds": round(elapsed, 3),
        "gamesPerHour": round(games_per_hour, 3),
        "samplesPerHour": round(total_samples / max(elapsed, 1e-9) * 3600, 3),
        "movesPerSecond": round(total_moves / max(elapsed, 1e-9), 3),
        "mctsNodesPerSecond": round(total_nodes / max(elapsed, 1e-9), 3),
        "performanceGate": performance_gate(games_per_hour),
        "disk": disk_snapshot,
        "inference": service_metrics,
        "bridge": bridge_metrics,
        "resources": sampler.summary(),
        "historicalCheckpoints": history_paths,
        "checkpointResumeVerified": True,
    }
    summary_tmp = run_root / "summary.json.tmp"
    summary_path = run_root / "summary.json"
    with open(summary_tmp, "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(summary_tmp, summary_path)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--games", type=int, required=True)
    parser.add_argument("--stage", choices=("smoke", "100", "500", "search"), required=True)
    parser.add_argument("--network", choices=tuple(NETWORKS), default="small")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--execution", choices=("processes", "threads"), default="processes")
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--sims", type=int, default=16)
    parser.add_argument("--precision", choices=("fp32", "bf16"), default="fp32")
    parser.add_argument("--compile-model", action="store_true")
    parser.add_argument("--warmup-passes", type=int, default=100)
    parser.add_argument("--inference-wait-ms", type=float, default=2.0)
    parser.add_argument("--games-per-wave", type=int, default=8)
    parser.add_argument("--train-steps-per-wave", type=int, default=1)
    parser.add_argument("--train-batch", type=int, default=128)
    parser.add_argument("--sample-interval", type=float, default=5.0)
    parser.add_argument("--history-dir", default="")
    parser.add_argument("--history-limit", type=int, default=8)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--min-free-gib", type=float, default=100.0)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--allow-cpu", action="store_true")
    args = parser.parse_args()
    if args.games < 1 or args.workers < 1 or args.batch < 1 or args.warmup_passes < 1:
        parser.error("games, workers, batch, and warmup-passes must be positive")
    return args


if __name__ == "__main__":
    print(json.dumps(run(parse_args()), ensure_ascii=False, indent=2))
