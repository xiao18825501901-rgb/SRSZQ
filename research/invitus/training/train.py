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

LEDGER = "logs/INVICTUS_TRAINING_LEDGER.jsonl"
PROGRESS = "logs/progress.json"
CKPT_DIR = "checkpoints"
CANVAS = 17


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
        "mcts_sims": sims, "checkpoint": cp_id, "seconds": round(time.time() - t0, 3),
        "inference_metrics": inference_service.metrics_snapshot() if inference_service is not None else {},
    }
    return samples, meta


def write_ledger(rec: dict):
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
        "terminal_result": meta["result"],
        "duration_seconds": meta["seconds"],
        "bridge_metrics": meta.get("bridge_metrics", {}),
        "inference_metrics": meta.get("inference_metrics", {}),
    }


def train_batch(net, device, opt, samples, l2=1e-4):
    net.train()
    X, P, V = [], [], []
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
        target = enc.policy_target(legal, {tuple(map(int, k.split(","))): v for k, v in smp["visits"].items()})
        P.append(target)
        V.append(smp["outcome"])
    import numpy as np
    X = torch.from_numpy(np.asarray(X, dtype=np.float32)).to(device)
    P = torch.from_numpy(np.asarray(P, dtype=np.float32)).to(device)
    V = torch.from_numpy(np.asarray(V, dtype=np.float32)).to(device)
    logits, logv = net(X)
    logp = torch.log_softmax(logits, dim=1)
    policy_loss = -(P * logp).sum(dim=1).mean()
    value_loss = -(V * logv).sum(dim=1).mean()
    l2reg = sum((p ** 2).sum() for p in net.parameters()) * l2
    loss = policy_loss + value_loss + l2reg
    opt.zero_grad()
    loss.backward()
    gn = math.sqrt(sum((p.grad ** 2).sum().item() for p in net.parameters() if p.grad is not None))
    torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
    opt.step()
    return float(policy_loss.item()), float(value_loss.item()), float(loss.item()), gn


def save_ckpt(path, net, opt, sched, counter, rng_state, cfg, extra):
    os.makedirs(CKPT_DIR, exist_ok=True)
    torch.save({
        "model": net.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(),
        "counter": counter, "rng": rng_state, "cfg": cfg, "extra": extra, "net": "Tiny",
    }, path)
    with open(PROGRESS, "w", encoding="utf-8") as f:
        json.dump({"counter": counter, "path": path, **extra}, f, ensure_ascii=False, indent=2)


def load_ckpt(net, opt, sched, path):
    ck = torch.load(path, map_location="cpu")
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
    ap.add_argument("--history-dir", default=CKPT_DIR)
    ap.add_argument("--history-limit", type=int, default=8)
    ap.add_argument("--inference-batch", type=int, default=128)
    ap.add_argument("--inference-wait-ms", type=float, default=2.0)
    ap.add_argument("--precision", choices=("fp32", "bf16"), default="fp32")
    ap.add_argument("--compile-model", action="store_true")
    args = ap.parse_args()

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
    rb = ReplayBuffer()
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
            args.history_dir,
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
            if os.path.exists("logs/STOP"):
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
