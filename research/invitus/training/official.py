"""Official Invitus formal training loop (GPU multiprocess).

The ONLY entrypoint that writes kind=formal records for the official run.
Benchmark/smoke/historical CPU data never mixes into this namespace; the
official counter starts at 0 in a clean data root.

Key properties:
- 20-process self-play pool + shared batched GPU inference (ProcessInferenceBroker)
- Opponent League 50/20/20/10 contract, seats randomized per game
- formal=true ledger with unique game_id, seat_assignments, league bucket,
  checkpoint id, result, timestamps, bridge + inference metrics
- atomic checkpoints every --cp-every (500), major every --major-every (5000)
- per-wave atomic training_state.json + authoritative audit every 500 games
- anomaly guards: NaN/Inf loss, illegal moves, inference errors, tactic
  fallbacks, disk <20GiB warning / <10GiB stop, logs/STOP graceful stop
- resume only at an audit-consistent point (ledger == checkpoint counter)

Usage (on the AutoDL GPU host):
  python -m training.official --episodes 5000 --sims 16 --workers 20 \
    --data-root /root/autodl-tmp/invitus/official \
    --history-dir /root/autodl-tmp/invitus/backup_staging/history/checkpoints
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import time
from pathlib import Path
from typing import Any

import torch
import numpy as np

from inference.process_service import ProcessInferenceBroker
from model.network import make_model
from training import train
from training.audit_training_state import (
    _atomic_json,
    _detect_git_sha,
    _optimizer_step,
    audit_training_state,
)
from training.benchmark import NETWORKS, ResourceSampler, append_jsonl, warmup_process_broker
from training.diagnostics import CollapseSentinel, summarize_games, target_metrics
from training.league import discover_historical_checkpoints
from training.process_selfplay import ProcessSelfPlayPool
from training.replay import ReplayBuffer

REPO_ROOT = Path(__file__).resolve().parents[3]
LEAGUE_CONTRACT = {"selfplay": 0.50, "historical": 0.20, "strong": 0.20, "diverse": 0.10}
BOARD_MIX = {"13": 0.60, "17": 0.40}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_light_state(
    data_root: Path,
    counter: int,
    latest_checkpoint: str,
    latest_game_id: str | None,
    optimizer,
    scheduler,
    board_counts: dict[str, int],
    seat_counts: dict[str, int],
    replay_chunks: int,
    git_sha: str,
    channels: int,
    blocks: int,
    sims: int,
    run_id: str,
    run_class: str,
) -> None:
    """Atomic per-wave training_state.json (authoritative audit rebuilds it every 500)."""
    _atomic_json(
        data_root / "training_state.json",
        {
            "recordKind": "formal" if run_class == "official" else "experiment",
            "episodeCount": counter,
            "formalEpisodes": counter if run_class == "official" else 0,
            "experimentalEpisodes": counter if run_class == "replica" else 0,
            "latestCheckpoint": latest_checkpoint,
            "latestGameId": latest_game_id,
            "optimizerStep": _optimizer_step({"opt": optimizer.state_dict()}),
            "schedulerStep": int(getattr(scheduler, "last_epoch", 0)),
            "boardCounts": board_counts,
            "seatCounts": seat_counts,
            "replayChunks": replay_chunks,
            "gitSha": git_sha,
            "modelConfig": {"name": "InvitusNet", "channels": channels, "blocks": blocks},
            "leagueConfig": LEAGUE_CONTRACT,
            "sims": sims,
            "rngStatePresent": True,
            "runId": run_id,
            "official": run_class == "official",
            "runClass": run_class,
        },
    )


def write_run_manifest(data_root: Path, args: argparse.Namespace, git_sha: str, run_id: str) -> None:
    manifest = {
        "officialRunId": run_id,
        "runClass": args.run_class,
        "official": args.run_class == "official",
        "recordKind": "formal" if args.run_class == "official" else "experiment",
        "gitSha": git_sha,
        "network": args.network,
        "channels": NETWORKS[args.network][0],
        "blocks": NETWORKS[args.network][1],
        "workers": args.workers,
        "inferenceBatch": args.batch,
        "sims": args.sims,
        "precision": args.precision,
        "compileModel": args.compile_model,
        "warmupPasses": args.warmup_passes,
        "gamesPerWave": args.games_per_wave,
        "trainStepsPerWave": args.steps_per_wave,
        "trainBatch": args.train_batch,
        "cpEvery": args.cp_every,
        "majorEvery": args.major_every,
        "boardMix": BOARD_MIX,
        "leagueContract": LEAGUE_CONTRACT,
        "historyDir": args.history_dir,
        "seed": args.seed,
        "targetEpisodes": args.episodes,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (data_root / "manifests").mkdir(parents=True, exist_ok=True)
    _atomic_json(data_root / "manifests" / "run.json", manifest)


def stage_major_backup(data_root: Path, checkpoint_path: Path, counter: int) -> str:
    backup_dir = data_root / "backups" / "major"
    backup_dir.mkdir(parents=True, exist_ok=True)
    staged = backup_dir / checkpoint_path.name
    with open(checkpoint_path, "rb") as src, open(staged, "wb") as dst:
        dst.write(src.read())
    record = {
        "counter": counter,
        "checkpoint": checkpoint_path.name,
        "sha256": _sha256(staged),
        "stagedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    manifest_path = backup_dir / "manifest.jsonl"
    with open(manifest_path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return str(staged)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--episodes", type=int, default=100000)
    parser.add_argument("--run-class", choices=("official", "replica"), default="official")
    parser.add_argument("--sims", type=int, default=16)
    parser.add_argument("--network", choices=tuple(NETWORKS), default="small")
    parser.add_argument("--channels", type=int, default=None, help="checkpoint cfg record only")
    parser.add_argument("--blocks", type=int, default=None, help="checkpoint cfg record only")
    parser.add_argument("--workers", type=int, default=20)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--precision", choices=("fp32", "bf16"), default="fp32")
    parser.add_argument("--compile-model", action="store_true")
    parser.add_argument("--warmup-passes", type=int, default=300)
    parser.add_argument("--inference-wait-ms", type=float, default=2.0)
    parser.add_argument("--games-per-wave", type=int, default=8)
    parser.add_argument("--steps-per-wave", type=int, default=8)
    parser.add_argument("--train-batch", type=int, default=128)
    parser.add_argument("--entropy-weight", type=float, default=0.05, help="policy entropy regularization weight")
    parser.add_argument("--target-tau", type=float, default=1.0, help="soften visit targets: visits^(1/tau); >1 prevents one-hot targets")
    parser.add_argument("--value-smooth", type=float, default=0.0, help="value label smoothing 0..1")
    parser.add_argument("--sample-interval", type=float, default=5.0)
    parser.add_argument("--cp-every", type=int, default=500)
    parser.add_argument("--major-every", type=int, default=5000)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--history-dir", default="")
    parser.add_argument("--history-limit", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--resume", default="")
    parser.add_argument("--warm-start", default="", help="load model weights ONLY from an external checkpoint (fresh optimizer/counter/ledger; 与 --resume 互斥)")
    parser.add_argument("--min-free-gib", type=float, default=100.0)
    args = parser.parse_args()
    if args.games_per_wave < 1 or args.workers < 1 or args.batch < 1:
        parser.error("games-per-wave, workers, and batch must be positive")
    return args


def main() -> int:
    args = parse_args()
    run_id = args.run_id or time.strftime(f"invitus-{args.run_class}-%Y%m%d-%H%M", time.gmtime())
    record_kind = "formal" if args.run_class == "official" else "experiment"
    storage = train.configure_storage(args.data_root)
    print(json.dumps({"event": "storage_configured", "runId": run_id, **storage}), flush=True)

    # Disk gate: official long runs require the frozen minimum free space.
    disk = train.disk_space_snapshot(args.min_free_gib)
    print(json.dumps({"event": "disk_space", **disk}), flush=True)
    if disk["status"] in {"stop", "start_blocked"}:
        raise RuntimeError(
            f"official data disk gate failed: status={disk['status']} freeGiB={disk['freeGiB']} "
            f"requiredGiB={args.min_free_gib}"
        )

    if not torch.cuda.is_available():
        raise RuntimeError("official training requires torch.cuda.is_available()=True")
    channels, blocks = NETWORKS[args.network]
    if args.channels is not None:
        channels = args.channels
    if args.blocks is not None:
        blocks = args.blocks
    # Persist the resolved ints so saved checkpoint cfg stays historical-league compatible.
    args.channels = channels
    args.blocks = blocks
    net, device = make_model(channels, blocks)
    optimizer = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=20_000, gamma=0.5)

    git_sha = _detect_git_sha(REPO_ROOT)
    counter = 0
    resume_path = ""
    if args.resume:
        resume_path = (
            args.resume
            if args.resume != "latest"
            else max(
                (str(p) for p in Path(train.CKPT_DIR).glob("*.pt") if "_major" not in p.name and "_final" not in p.name),
                key=lambda p: os.path.getmtime(p),
                default="",
            )
        )
        if not resume_path or not os.path.exists(resume_path):
            ledger_path = Path(train.LEDGER)
            if ledger_path.exists() and ledger_path.stat().st_size > 0:
                raise RuntimeError(
                    f"resume checkpoint not found ({args.resume}) but official ledger is non-empty; "
                    "manual reconciliation required"
                )
            print(json.dumps({"event": "fresh_start", "resume": args.resume, "counter": 0}), flush=True)
            resume_path = ""
        else:
            counter, rng_state = train.load_ckpt(net, optimizer, scheduler, resume_path)
            if rng_state:
                random.setstate(rng_state)
            # Resume gate: the on-disk state must already be audit-consistent.
            state = audit_training_state(Path(train.DATA_ROOT), git_sha=git_sha, record_kind=record_kind)
            if not state["stateConsistent"] or state["episodeCount"] != counter:
                raise RuntimeError(
                    f"resume refused: checkpoint counter {counter} != consistent {record_kind} {state['episodeCount']} "
                    f"or inconsistent state {state['consistencyErrors']}"
                )
            print(json.dumps({"event": "resumed", "checkpoint": resume_path, "counter": counter}), flush=True)
    else:
        if Path(train.LEDGER).exists() and Path(train.LEDGER).stat().st_size > 0:
            raise RuntimeError("refusing fresh start over a non-empty official ledger; use a clean data root")

    if args.warm_start:
        # Recovery 臂：只继承外部 checkpoint 的模型权重（实验用途，formal 场景不用于 official）
        if args.run_class != "replica":
            raise RuntimeError("warm-start is restricted to replica experiments")
        if not os.path.exists(args.warm_start):
            raise RuntimeError(f"warm-start checkpoint not found: {args.warm_start}")
        warm = torch.load(args.warm_start, map_location="cpu", weights_only=False)
        net.load_state_dict(warm["model"])
        optimizer = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
        scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=20_000, gamma=0.5)
        counter = 0
        print(json.dumps({"event": "warm_start", "checkpoint": args.warm_start, "counter": counter}), flush=True)

    history_paths: list[str] = []
    history_errors: dict[str, str] = {}
    history_dir = args.history_dir or os.path.join(train.CKPT_DIR, "..", "history")
    if Path(history_dir).exists():
        history_paths, history_errors = discover_historical_checkpoints(
            history_dir, exclude_path=resume_path or None, limit=args.history_limit
        )
    if history_errors:
        print(json.dumps({"event": "historical_checkpoint_errors", "errors": history_errors}), flush=True)
    if not history_paths:
        raise RuntimeError(f"opponent league requires at least one historical checkpoint in {history_dir}")

    # Official league pool = external history + official checkpoints (majors and
    # numbered snapshots). latest.pt/_final.pt/current resume path are excluded;
    # the pool ACCUMULATES across major-pool restarts inside one process.
    def _is_league_candidate(path: str) -> bool:
        name = os.path.basename(path)
        return not name.startswith("latest") and "_final" not in name

    official_history: list[str] = []
    if Path(train.CKPT_DIR).exists():
        discovered, _ = discover_historical_checkpoints(train.CKPT_DIR, limit=max(8, args.history_limit * 2))
        official_history = [
            p for p in discovered
            if _is_league_candidate(p) and (not resume_path or os.path.abspath(p) != os.path.abspath(resume_path))
        ]
    league_paths = list(dict.fromkeys(history_paths + official_history))
    print(json.dumps({"event": "league_pool", "size": len(league_paths)}), flush=True)

    write_run_manifest(Path(train.DATA_ROOT), args, git_sha, run_id)
    replay = ReplayBuffer(train.REPLAY_DIR, max_shards=128, max_samples_per_shard=512)

    broker: ProcessInferenceBroker | None = None
    pool: ProcessSelfPlayPool | None = None
    sampler: ResourceSampler | None = None
    broker = ProcessInferenceBroker(
        net,
        device,
        worker_count=args.workers,
        max_batch_size=args.batch,
        max_wait_ms=args.inference_wait_ms,
        precision=args.precision,
        compile_model=args.compile_model,
    )
    compile_and_warmup_seconds = warmup_process_broker(broker, args.warmup_passes, args.workers)
    pool = ProcessSelfPlayPool(broker, args.workers, league_paths, REPO_ROOT)
    sampler = ResourceSampler(Path(train.DATA_ROOT) / "metrics" / "resources.csv", args.sample_interval)
    sampler.start()

    bridge_totals = {"requests": 0, "successfulResponses": 0, "fallbacks": 0, "timeouts": 0,
                     "protocolErrors": 0, "processErrors": 0, "restarts": 0}
    board_counts = {"13": 0, "17": 0}
    seat_counts = {"A": 0, "B": 0, "C": 0}
    rng = random.Random(args.seed)
    t_start = time.monotonic()
    total_samples = total_moves = total_nodes = 0
    last_game_id: str | None = None
    wave = 0
    next_ckpt = counter + args.cp_every
    next_major = counter + args.major_every
    next_metrics = counter + 100
    metrics_metadata: list[dict[str, Any]] = []
    metrics_samples: list[dict[str, Any]] = []
    sentinel = CollapseSentinel(window=100)
    if counter and Path(train.LEDGER).exists():
        previous_records = [
            json.loads(line)
            for line in Path(train.LEDGER).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        for record in previous_records[-99:]:
            if record.get("kind") == record_kind:
                sentinel.observe({"searchDiagnostics": record.get("search_diagnostics", {})})
    collapse_stop = False
    policy_loss = value_loss = loss = gradient_norm = policy_entropy = 0.0
    last_inference_metrics: dict[str, Any] = {}
    try:
        while counter < args.episodes:
            cp_id = f"invitus_{counter:06d}"
            wave_games = min(args.games_per_wave, args.episodes - counter)
            seeds = [rng.getrandbits(64) for _ in range(wave_games)]
            jobs = [(counter + index, seed, args.sims, cp_id) for index, seed in enumerate(seeds)]
            episode_results = pool.play(jobs)
            wave_samples: list[dict[str, Any]] = []
            wave_metadata: list[dict[str, Any]] = []
            for samples, meta in episode_results:
                if not samples:
                    raise RuntimeError(f"official game {meta.get('game_id')} produced no training samples")
                for sample in samples:
                    replay.add(sample)
                replay.flush()
                counter += 1
                total_samples += len(samples)
                total_moves += int(meta.get("moves", 0))
                total_nodes += int(meta.get("mcts_nodes", 0))
                record = train.make_ledger_record(meta, cp_id)
                if record_kind == "experiment":
                    record.update({"kind": "experiment", "formal": False, "experiment": True})
                train.write_ledger(record)
                last_game_id = meta["game_id"]
                board_counts[str(meta["boardSize"])] = board_counts.get(str(meta["boardSize"]), 0) + 1
                for seat in "ABC":
                    agent = meta.get("seats", {}).get(seat)
                    if isinstance(agent, (list, tuple)):
                        agent = agent[0] if agent else None
                    if agent == "invitus":
                        seat_counts[seat] += 1
                for key, value in meta.get("bridge_metrics", {}).items():
                    bridge_totals[key] = bridge_totals.get(key, 0) + value
                wave_samples.extend(samples)
                wave_metadata.append(meta)
                metrics_metadata.append(meta)
                metrics_samples.extend(samples)
                collapse_stop = sentinel.observe(meta) or collapse_stop

            shards = replay.shards()[-32:]
            batch_samples = [sample for sample in replay.iter_samples(shards)]
            if batch_samples:
                for _ in range(args.steps_per_wave):
                    idxs = [random.randrange(len(batch_samples)) for _ in range(args.train_batch)]
                    policy_loss, value_loss, loss, gradient_norm, policy_entropy = train.train_batch(
                        net, device, optimizer, [batch_samples[i] for i in idxs],
                        entropy_weight=args.entropy_weight, target_tau=args.target_tau,
                        value_smooth=args.value_smooth,
                    )
                    if not all(np.isfinite(v) for v in (policy_loss, value_loss, loss, gradient_norm, policy_entropy)):
                        raise FloatingPointError(
                            f"official training produced NaN/Inf: pl={policy_loss} vl={value_loss} "
                            f"loss={loss} gn={gradient_norm} entropy={policy_entropy}"
                        )
                scheduler.step()

            inference_metrics = broker.metrics_snapshot()
            last_inference_metrics = inference_metrics
            if inference_metrics.get("errors"):
                raise RuntimeError(f"official inference errors: {inference_metrics}")
            if bridge_totals.get("fallbacks", 0) > 0:
                raise RuntimeError(f"tactic bridge fallbacks detected: {bridge_totals}")

            wave += 1
            gph = counter / max(1e-6, (time.monotonic() - t_start) / 3600)
            wave_search = summarize_games(wave_metadata)
            wave_targets = target_metrics(wave_samples, args.target_tau)
            print(
                json.dumps({
                    "event": "wave",
                    "wave": wave,
                    "formal": counter if args.run_class == "official" else 0,
                    "experimental": counter if args.run_class == "replica" else 0,
                    "target": args.episodes,
                    "gamesPerHour": round(gph, 1),
                    "loss": round(loss, 4),
                    "policyLoss": round(policy_loss, 4),
                    "valueLoss": round(value_loss, 4),
                    "policyEntropy": round(policy_entropy, 4),
                    "targetEntropy": round(wave_targets["targetEntropy"], 4),
                    "effectiveTargetSupport": round(wave_targets["effectiveTargetSupport"], 3),
                    "networkPriorEntropy": round(wave_search["networkPriorEntropy"], 4),
                    "rootPriorEntropy": round(wave_search["rootPriorEntropy"], 4),
                    "visitEntropy": round(wave_search["visitEntropy"], 4),
                    "maxPolicyProbability": round(wave_search["maxPolicyProbability"], 4),
                    "visitedActionCount": round(wave_search["visitedActionCount"], 2),
                    "legalActionCount": round(wave_search["legalActionCount"], 2),
                    "collapseSentinel": sentinel.snapshot,
                    "gradientNorm": round(gradient_norm, 3),
                    "inferenceErrors": inference_metrics.get("errors", 0),
                    "bridgeFallbacks": bridge_totals.get("fallbacks", 0),
                }),
                flush=True,
            )

            train.save_ckpt(
                os.path.join(train.CKPT_DIR, "latest.pt"),
                net, optimizer, scheduler, counter, random.getstate(), vars(args),
                {"games_per_hour": round(gph, 1), "wave": wave, "run_id": run_id},
            )
            write_light_state(
                Path(train.DATA_ROOT), counter, "checkpoints/latest.pt", last_game_id,
                optimizer, scheduler, board_counts, seat_counts, len(replay.shards()),
                git_sha, channels, blocks, args.sims, run_id,
                args.run_class,
            )

            if counter >= next_metrics:
                hundred = summarize_games(metrics_metadata)
                hundred.update(target_metrics(metrics_samples, args.target_tau))
                hundred.update(
                    {
                        "event": "metrics_100",
                        "episode": counter,
                        "runId": run_id,
                        "runClass": args.run_class,
                        "policyLoss": policy_loss,
                        "valueLoss": value_loss,
                        "totalLoss": loss,
                        "gradNorm": gradient_norm,
                        "policyEntropy": policy_entropy,
                        "gamesPerHour": gph,
                        "resources": sampler.summary() if sampler is not None else {},
                        "collapseSentinel": sentinel.snapshot,
                    }
                )
                append_jsonl(Path(train.DATA_ROOT) / "metrics" / "training_metrics.jsonl", hundred)
                print(json.dumps(hundred, ensure_ascii=False), flush=True)
                metrics_metadata.clear()
                metrics_samples.clear()
                next_metrics = counter + 100

            if collapse_stop:
                print(
                    json.dumps(
                        {"event": "collapse_sentinel_triggered", "episode": counter, **sentinel.snapshot}
                    ),
                    flush=True,
                )
                break

            disk = train.disk_space_snapshot()
            if disk["status"] == "warning":
                print(json.dumps({"event": "disk_warning", **disk}), flush=True)
            elif disk["status"] == "stop":
                print(json.dumps({"event": "disk_stop", **disk}), flush=True)
                break
            if os.path.exists(train.STOP_FILE):
                print(json.dumps({"event": "stop_file", "formal": counter}), flush=True)
                break

            if counter >= next_ckpt:
                checkpoint_path = os.path.join(train.CKPT_DIR, f"invitus_{counter:06d}.pt")
                train.save_ckpt(
                    checkpoint_path, net, optimizer, scheduler, counter,
                    random.getstate(), vars(args), {"games_per_hour": round(gph, 1), "run_id": run_id},
                )
                state = audit_training_state(
                    Path(train.DATA_ROOT), git_sha=git_sha, record_kind=record_kind
                )
                print(
                    json.dumps({
                        "event": "checkpoint_audit",
                        "checkpoint": f"invitus_{counter:06d}.pt",
                        "episodeCount": state["episodeCount"],
                        "recordKind": record_kind,
                        "stateConsistent": state["stateConsistent"],
                        "consistencyErrors": state["consistencyErrors"],
                    }),
                    flush=True,
                )
                if not state["stateConsistent"] or state["episodeCount"] != counter:
                    raise RuntimeError(f"per-500 audit failed: {state['consistencyErrors']}")
                next_ckpt = counter + args.cp_every

            if counter >= next_major:
                major_path = Path(train.CKPT_DIR) / f"invitus_{counter:06d}_major.pt"
                train.save_ckpt(
                    str(major_path), net, optimizer, scheduler, counter,
                    random.getstate(), vars(args), {"games_per_hour": round(gph, 1), "major": True, "run_id": run_id},
                )
                staged = stage_major_backup(Path(train.DATA_ROOT), major_path, counter)
                print(json.dumps({"event": "major_checkpoint", "counter": counter, "staged": staged}), flush=True)
                # Major checkpoints join the historical league; restart pool with the accumulated list.
                league_paths = list(dict.fromkeys(league_paths + [str(major_path)]))
                pool.close()
                pool = ProcessSelfPlayPool(broker, args.workers, league_paths, REPO_ROOT)
                print(json.dumps({"event": "league_refresh", "historical": len(league_paths)}), flush=True)
                next_major = counter + args.major_every
    except KeyboardInterrupt:
        print(json.dumps({"event": "interrupt", "formal": counter}), flush=True)
    finally:
        if sampler is not None:
            sampler.stop()
        if pool is not None:
            pool.close()
        if broker is not None:
            broker.close()

    final_path = os.path.join(train.CKPT_DIR, f"invitus_{counter:06d}_final.pt")
    train.save_ckpt(final_path, net, optimizer, scheduler, counter, random.getstate(), vars(args), {"run_id": run_id})
    # Segment finals that land on a major boundary (5000/10000/...) also get a
    # major checkpoint + backup staging (the in-loop major branch cannot fire
    # for the segment-final wave because the loop exits at counter == episodes).
    if counter > 0 and counter % args.major_every == 0:
        major_path = Path(train.CKPT_DIR) / f"invitus_{counter:06d}_major.pt"
        train.save_ckpt(
            str(major_path), net, optimizer, scheduler, counter,
            random.getstate(), vars(args), {"games_per_hour": round(counter / max(1e-9, time.monotonic() - t_start) * 3600, 1),
                                            "major": True, "run_id": run_id},
        )
        staged = stage_major_backup(Path(train.DATA_ROOT), major_path, counter)
        print(json.dumps({"event": "segment_final_major", "counter": counter, "staged": staged}), flush=True)
    state = audit_training_state(Path(train.DATA_ROOT), git_sha=git_sha, record_kind=record_kind)
    elapsed = time.monotonic() - t_start
    summary = {
        "runId": run_id,
        "official": args.run_class == "official",
        "runClass": args.run_class,
        "recordKind": record_kind,
        "formal": counter if args.run_class == "official" else 0,
        "experimental": counter if args.run_class == "replica" else 0,
        "target": args.episodes,
        "stateConsistent": state["stateConsistent"],
        "network": args.network,
        "channels": channels,
        "blocks": blocks,
        "workers": args.workers,
        "inferenceBatch": args.batch,
        "sims": args.sims,
        "precision": args.precision,
        "compile": args.compile_model,
        "compileAndWarmupSeconds": round(compile_and_warmup_seconds, 3),
        "samples": total_samples,
        "moves": total_moves,
        "mctsNodes": total_nodes,
        "elapsedSeconds": round(elapsed, 3),
        "gamesPerHour": round(counter / max(1e-9, elapsed) * 3600, 3),
        "boardCounts": board_counts,
        "seatCounts": seat_counts,
        "bridge": bridge_totals,
        "resources": sampler.summary() if sampler is not None else {},
        "inference": last_inference_metrics,
        "checkpointResumeVerified": state["stateConsistent"],
        "collapseSentinel": sentinel.snapshot,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (Path(train.DATA_ROOT) / "manifests").mkdir(parents=True, exist_ok=True)
    _atomic_json(Path(train.DATA_ROOT) / "manifests" / f"summary-{run_id}.json", summary)
    print(json.dumps({"event": "done", **summary}, ensure_ascii=False, indent=2))
    print(f"{'FORMAL' if args.run_class == 'official' else 'EXPERIMENT'} {counter}/{args.episodes}")
    print(f"LATEST CHECKPOINT: {final_path}")
    print(f"STATE_CONSISTENT={str(state['stateConsistent']).lower()}")
    print("READY=NO")
    if counter < args.episodes:
        print("INVICTUS IS NOT TRAINED YET.")
    return 0 if state["stateConsistent"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
