"""Invitus formal 训练主循环（CPU-friendly）：
self-play 线程池生成 episode（唯一 game_id）→ 样本写 disk replay + ledger（fsync 后 confirmed）
→ 从最近分片采样训练（policy CE[visits] + value CE[outcome] + AdamW L2）→ 周期 checkpoint/resume。
用法：
  python training/train.py --episodes 100000 --sims 16 --cp-every 500 --resume latest
Ctrl+C / 异常 → 优雅 checkpoint。
"""
from __future__ import annotations
import argparse
import copy
import json
import math
import os
import random
import shutil
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, ".")
import torch
from engine import srszq
from model import encode as enc
from model.network import make_model
from mcts.nn_mcts import NNMCTS
from exact.solver import ExactSolver
from training.replay import ReplayBuffer

DATA_ROOT = Path(".").resolve()
LEDGER = str(DATA_ROOT / "logs" / "INVICTUS_TRAINING_LEDGER.jsonl")
PROGRESS = str(DATA_ROOT / "logs" / "progress.json")
CKPT_DIR = str(DATA_ROOT / "checkpoints")
REPLAY_DIR = str(DATA_ROOT / "replay")
STOP_FILE = str(DATA_ROOT / "logs" / "STOP")
CANVAS = 17


def configure_storage(root):
    """Route all mutable training state below one explicit data root."""
    global DATA_ROOT, LEDGER, PROGRESS, CKPT_DIR, REPLAY_DIR, STOP_FILE
    DATA_ROOT = Path(root).expanduser().resolve()
    logs_dir = DATA_ROOT / "logs"
    checkpoints_dir = DATA_ROOT / "checkpoints"
    replay_dir = DATA_ROOT / "replay"
    for directory in (logs_dir, checkpoints_dir, replay_dir):
        directory.mkdir(parents=True, exist_ok=True)
    LEDGER = str(logs_dir / "INVICTUS_TRAINING_LEDGER.jsonl")
    PROGRESS = str(logs_dir / "progress.json")
    CKPT_DIR = str(checkpoints_dir)
    REPLAY_DIR = str(replay_dir)
    STOP_FILE = str(logs_dir / "STOP")
    return {
        "data_root": str(DATA_ROOT),
        "ledger": LEDGER,
        "progress": PROGRESS,
        "checkpoints": CKPT_DIR,
        "replay": REPLAY_DIR,
        "stop": STOP_FILE,
    }


def classify_disk_space(free_bytes: int, minimum_start_gib: float) -> str:
    free_gib = free_bytes / (1024 ** 3)
    if free_gib < 10:
        return "stop"
    if free_gib < 20:
        return "warning"
    if free_gib < minimum_start_gib:
        return "start_blocked"
    return "ok"


def disk_space_snapshot(minimum_start_gib: float = 0) -> dict[str, float | str]:
    usage = shutil.disk_usage(DATA_ROOT)
    return {
        "path": str(DATA_ROOT),
        "totalGiB": round(usage.total / (1024 ** 3), 3),
        "freeGiB": round(usage.free / (1024 ** 3), 3),
        "status": classify_disk_space(usage.free, minimum_start_gib),
    }


def board_mix(rng):
    return 13 if rng.random() < 0.6 else 17


def play_episode(net, device, sims, rng, cp_id, train=True, inference_service=None):
    """一局完整对局：三座均为 Invitus（v1 self-play；league 预留）。返回 (samples, result, meta)。"""
    size = board_mix(rng)
    s = srszq.create_state(size)
    samples = []
    gid = uuid.uuid4().hex
    t0 = time.time()
    guard = 0
    move_no = 0
    mcts_nodes = 0
    while s["status"] == "playing" and guard < size * size + 32:
        actor = srszq.current_player(s)
        legal = srszq.legal_moves(s)
        if not legal:
            srszq._advance_pass_chain(s)
            guard += 1
            continue
        m = NNMCTS(
            net,
            device,
            sims=sims,
            exact=None,
            rng=random.Random(rng.getrandbits(32)),
            train=train,
            inference_service=inference_service,
        )
        m.search(s)
        mcts_nodes += m.root.N
        temp = 1.0 if move_no < 8 else 0.0
        mv, _ = m.best_move(temperature=temp)
        # 训练样本（MCTS visit 分布 target；直接从 root.children 取）
        visits = {}
        for (r, c) in legal:
            visits[(r, c)] = 0.0
        for (r, c), ch in m.root.children.items():
            visits[(r, c)] = float(ch.N)
        samples.append({
            "board": ["".join("." if x is None else x for x in row) for row in s["board"]],
            "turn": s["turn"],
            "size": size,
            "actor": actor,
            "legal": [[r, c] for (r, c) in legal],
            "visits": {f"{r},{c}": v for (r, c), v in visits.items()},
            "outcome": None,
            "game_id": gid,
            "cp": cp_id,
        })
        srszq.apply_move(s, mv[0], mv[1])
        move_no += 1
        guard += 1
    if s["status"] == "playing":
        s["status"] = "draw"
    if s["status"] == "won":
        oc = [0.0, 0.0, 0.0, 0.0]
        oc["ABC".index(s["winner"])] = 1.0
        result = f"{s['winner']}_WIN"
    else:
        oc = [0.0, 0.0, 0.0, 1.0]
        result = "DRAW"
    for smp in samples:
        smp["outcome"] = oc
    meta = {
        "game_id": gid, "boardSize": size, "result": result, "num_samples": len(samples),
        "moves": move_no, "mcts_nodes": mcts_nodes,
        "mcts_sims": sims, "checkpoint": cp_id, "seconds": round(time.time() - t0, 3),
        "inference_metrics": inference_service.metrics_snapshot() if inference_service is not None else {},
    }
    return samples, meta


def write_ledger(rec: dict):
    Path(LEDGER).parent.mkdir(parents=True, exist_ok=True)
    with open(LEDGER, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())


def make_ledger_record(meta: dict, checkpoint_id: str) -> dict:
    league_bucket = meta.get("league_bucket", "selfplay")
    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": "formal",
        "formal": True,
        "game_id": meta["game_id"],
        "completed": True,
        "replay_persisted": True,
        "board_size": meta["boardSize"],
        "seat_assignments": meta.get(
            "seats",
            {"A": ("invitus",), "B": ("invitus",), "C": ("invitus",)},
        ),
        "opponents": f"league:{league_bucket}",
        "checkpoint": checkpoint_id,
        "mcts_sims": meta["mcts_sims"],
        "num_samples": meta["num_samples"],
        "moves": meta.get("moves"),
        "mcts_nodes": meta.get("mcts_nodes"),
        "terminal_result": meta["result"],
        "duration_seconds": meta["seconds"],
        "bridge_metrics": meta.get("bridge_metrics", {}),
        "inference_metrics": meta.get("inference_metrics", {}),
    }


def train_batch(net, device, opt, samples, l2=1e-4, entropy_weight=0.0):
    net.train()
    import numpy as np
    X, P, V, masks = [], [], [], []
    for smp in samples:
        n = smp["size"]
        # 重建 state
        s = srszq.create_state(n)
        for r in range(n):
            row = smp["board"][r]
            for c in range(n):
                ch = row[c]
                s["board"][r][c] = ch if ch != "." else None
        s["turn"] = smp["turn"]
        s["moves"] = smp["turn"]
        planes = enc.encode_state(s)
        X.append(planes)
        legal = [tuple(x) for x in smp["legal"]]
        mask = np.full(289, -np.inf, dtype=np.float32)
        for (r, c) in legal:
            mask[r * 17 + c] = 0.0
        masks.append(mask)
        target = enc.policy_target(legal, {tuple(map(int, k.split(","))): v for k, v in smp["visits"].items()})
        P.append(target)
        V.append(smp["outcome"])
    X = torch.from_numpy(np.asarray(X, dtype=np.float32)).to(device)
    P = torch.from_numpy(np.asarray(P, dtype=np.float32)).to(device)
    V = torch.from_numpy(np.asarray(V, dtype=np.float32)).to(device)
    mask_t = torch.from_numpy(np.asarray(masks, dtype=np.float32)).to(device)
    logits, logv = net(X)
    logp = torch.log_softmax(logits, dim=1)
    policy_loss = -(P * logp).sum(dim=1).mean()
    value_loss = -(V * logv).sum(dim=1).mean()
    entropy = 0.0
    if entropy_weight > 0:
        # 合法步 mask 后 softmax 的策略熵（防 one-hot 坍塌正则项）
        # 注意：非法步 log_softmax = -inf，必须 mask 掉避免 0 * -inf = NaN。
        masked_logits = logits + mask_t
        logpm = torch.log_softmax(masked_logits, dim=1)
        pm = torch.exp(logpm)
        entropy = -(pm * logpm.masked_fill(torch.isneginf(logpm), 0.0)).sum(dim=1).mean()
    l2reg = sum((p ** 2).sum() for p in net.parameters()) * l2
    loss = policy_loss + value_loss + l2reg - entropy_weight * entropy
    opt.zero_grad()
    loss.backward()
    gn = math.sqrt(sum((p.grad ** 2).sum().item() for p in net.parameters() if p.grad is not None))
    torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
    opt.step()
    return float(policy_loss.item()), float(value_loss.item()), float(loss.item()), gn, float(entropy.item())


def save_ckpt(path, net, opt, sched, counter, rng_state, cfg, extra):
    checkpoint_path = Path(path).expanduser().resolve()
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_tmp = checkpoint_path.with_name(checkpoint_path.name + ".tmp")
    with open(checkpoint_tmp, "wb") as f:
        torch.save({
            "model": net.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(),
            "counter": counter, "rng": rng_state, "cfg": cfg, "extra": extra, "net": "Tiny",
        }, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(checkpoint_tmp, checkpoint_path)

    progress_path = Path(PROGRESS)
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    progress_tmp = progress_path.with_name(progress_path.name + ".tmp")
    with open(progress_tmp, "w", encoding="utf-8") as f:
        json.dump(
            {"counter": counter, "path": str(checkpoint_path), **extra},
            f,
            ensure_ascii=False,
            indent=2,
        )
        f.flush()
        os.fsync(f.fileno())
    os.replace(progress_tmp, progress_path)


def load_ckpt(net, opt, sched, path):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    net.load_state_dict(ck["model"])
    opt.load_state_dict(ck["opt"])
    sched.load_state_dict(ck["sched"])
    return ck["counter"], ck.get("rng")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=100000)
    ap.add_argument("--sims", type=int, default=16)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--games-per-wave", type=int, default=8)
    ap.add_argument("--steps-per-wave", type=int, default=8)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--cp-every", type=int, default=500)
    ap.add_argument("--resume", default="")
    ap.add_argument("--channels", type=int, default=32)
    ap.add_argument("--blocks", type=int, default=4)
    ap.add_argument("--league", type=int, default=0)
    ap.add_argument("--history-dir", default="")
    ap.add_argument("--history-limit", type=int, default=8)
    ap.add_argument("--inference-batch", type=int, default=128)
    ap.add_argument("--inference-wait-ms", type=float, default=2.0)
    ap.add_argument("--precision", choices=("fp32", "bf16"), default="fp32")
    ap.add_argument("--compile-model", action="store_true")
    ap.add_argument("--data-root", default=".")
    ap.add_argument("--min-start-free-gib", type=float)
    args = ap.parse_args()
    storage = configure_storage(args.data_root)
    print(json.dumps({"event": "storage_configured", **storage}), flush=True)
    minimum_start_gib = (
        args.min_start_free_gib
        if args.min_start_free_gib is not None
        else (100.0 if args.episodes >= 100_000 else 0.0)
    )
    disk = disk_space_snapshot(minimum_start_gib)
    print(json.dumps({"event": "disk_space", **disk}), flush=True)
    if disk["status"] in {"stop", "start_blocked"}:
        raise RuntimeError(
            f"data disk gate failed: status={disk['status']} freeGiB={disk['freeGiB']} "
            f"requiredGiB={minimum_start_gib}"
        )

    net, device = make_model(args.channels, args.blocks)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=20000, gamma=0.5)
    counter = 0
    rng_state = random.getstate()
    resume_path = ""
    if args.resume:
        p = args.resume if args.resume != "latest" else max(
            (os.path.join(CKPT_DIR, f) for f in os.listdir(CKPT_DIR) if f.endswith(".pt")), key=os.path.getmtime, default="")
        if p and os.path.exists(p):
            resume_path = p
            counter, rng_state = load_ckpt(net, opt, sched, p)
            if rng_state:
                random.setstate(rng_state)
            print(f"RESUMED from {p} at episode {counter}", flush=True)
    rb = ReplayBuffer(base_dir=REPLAY_DIR)
    from inference.service import InferenceService
    inference_service = InferenceService(
        net,
        device,
        max_batch_size=args.inference_batch,
        max_wait_ms=args.inference_wait_ms,
        precision=args.precision,
        compile_model=args.compile_model,
    )
    bridge = None
    historical_networks = {}
    if args.league:
        from training.league import (
            TacticBridge,
            discover_historical_checkpoints,
            load_historical_networks,
            play_league_episode,
        )
        repo_root = Path(__file__).resolve().parents[2]
        historical_paths, historical_errors = discover_historical_checkpoints(
            args.history_dir or CKPT_DIR,
            exclude_path=resume_path or None,
            limit=args.history_limit,
        )
        if historical_errors:
            print(json.dumps({"event": "historical_checkpoint_errors", "errors": historical_errors}), flush=True)
        if not historical_paths:
            raise RuntimeError("opponent league requires at least one loadable historical checkpoint")
        historical_networks = load_historical_networks(historical_paths, device)
        bridge = TacticBridge(repo_root)
        print(f"[league] persistent tactic worker started; historical={len(historical_networks)}", flush=True)
    t_start = time.time()
    wave = 0
    next_ckpt = counter + args.cp_every
    try:
        while counter < args.episodes:
            cp_id = f"invitus_{counter:06d}"
            with ThreadPoolExecutor(max_workers=args.workers) as ex:
                episode_rngs = [random.Random(random.getrandbits(64)) for _ in range(args.games_per_wave)]
                if args.league:
                    futs = [
                        ex.submit(
                            play_league_episode,
                            net,
                            device,
                            args.sims,
                            episode_rng,
                            cp_id,
                            bridge,
                            historical_networks,
                            8,
                            inference_service,
                        )
                        for episode_rng in episode_rngs
                    ]
                else:
                    futs = [
                        ex.submit(play_episode, net, device, args.sims, episode_rng, cp_id, True, inference_service)
                        for episode_rng in episode_rngs
                    ]
                for fut in futs:
                    samples, meta = fut.result()
                    for smp in samples:
                        rb.add(smp)
                    rb.flush()
                    counter += 1
                    write_ledger(make_ledger_record(meta, cp_id))
            # 训练步骤
            shards = rb.shards()[-32:]
            batch_samples = []
            for smp in rb.iter_samples(shards):
                batch_samples.append(smp)
            if batch_samples:
                for _ in range(args.steps_per_wave):
                    idxs = [random.randrange(len(batch_samples)) for _ in range(args.batch)]
                    pl, vl, loss, gn = train_batch(net, device, opt, [batch_samples[i] for i in idxs])
                sched.step()
            wave += 1
            gph = counter / max(1e-6, (time.time() - t_start) / 3600)
            print(f"[wave {wave}] formal={counter}/{args.episodes} gph={gph:.1f} loss={loss:.4f} pl={pl:.4f} vl={vl:.4f} gn={gn:.2f}",
                  flush=True)
            print(json.dumps({"event": "inference_metrics", **inference_service.metrics_snapshot()}), flush=True)
            # 每波保存 latest（限制断电损失）；STOP 文件出现 → 优雅停训
            save_ckpt(os.path.join(CKPT_DIR, "latest.pt"), net, opt, sched, counter, random.getstate(), vars(args),
                      {"games_per_hour": round(gph, 1), "wave": wave})
            disk = disk_space_snapshot()
            if disk["status"] == "warning":
                print(json.dumps({"event": "disk_warning", **disk}), flush=True)
            elif disk["status"] == "stop":
                print(json.dumps({"event": "disk_stop", **disk}), flush=True)
                break
            if os.path.exists(STOP_FILE):
                print("[stop-file] graceful stop requested", flush=True)
                break
            if counter >= next_ckpt:
                save_ckpt(os.path.join(CKPT_DIR, f"invitus_{counter:06d}.pt"), net, opt, sched, counter,
                          random.getstate(), vars(args), {"games_per_hour": round(gph, 1)})
                print(f"[ckpt] saved invitus_{counter:06d}.pt", flush=True)
                next_ckpt = counter + args.cp_every
    except KeyboardInterrupt:
        print("\n[interrupt] graceful checkpoint...", flush=True)
    finally:
        if bridge is not None:
            bridge.close()
        inference_service.close()
    save_ckpt(os.path.join(CKPT_DIR, f"invitus_{counter:06d}_final.pt"), net, opt, sched, counter, random.getstate(), vars(args), {})
    print(f"DONE formal episodes={counter} (target {args.episodes})", flush=True)


if __name__ == "__main__":
    main()
