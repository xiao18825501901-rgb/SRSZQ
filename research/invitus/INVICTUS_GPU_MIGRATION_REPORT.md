# INVICTUS GPU MIGRATION REPORT

Status: **VERIFIED ON GPU — 500-game benchmark GREEN; official 100K run BLOCKED_BY_STORAGE**

Generated: 2026-09-08T14:05Z (local) / server 2026-09-08 22:05 CST
Git: `b619ac9` (branch `research/invitus`, HEAD == origin, working tree clean on server and local)
Server: AutoDL `autodl-container-smvv2c85uh-3601d956` (connect.weste.seetacloud.com:39542)
GPU: NVIDIA RTX 6000D, 85,651 MiB VRAM, driver 595.71.05, CUDA 13.2, torch 2.12.1+cu130

---

## 1. What was already established (not redone)

- Persistent Node tactic worker + Opponent League (50/20/20/10 contract) — `feat(invitus): add observable opponent league` (3b7e721)
- CPU historical ledger preserved as evidence only (118 games) — `data(invitus): preserve stopped CPU training ledger` (3126a3e)
- Batched shared inference — `feat(invitus): batch neural inference across workers` (c48dbb0)
- Data-root routing — `feat(invitus): route training state to data root` (cea64a4)
- Guarded benchmark runner — `feat(invitus): add guarded GPU benchmark runner` (86d3e1e)
- Multi-process self-play pool — `perf(invitus): parallelize self-play across processes` (b619ac9)
- Earlier: 12/20/100-game runs, threading-vs-processes scaling, network sizing (Tiny/Small/Medium), FP32-compile vs BF16, sims scaling — all recorded in prior reports; results below are the final confirmation run.

## 2. 500-game benchmark — REAL MEASURED RESULT

Run id: `benchmark-500-small-p20-b128-s16-fp32-compile`
Dir: `/root/autodl-tmp/invitus/benchmarks/benchmark-500-small-p20-b128-s16-fp32-compile/`

| Metric | Value |
|---|---|
| COMPLETED_GAMES | **500 / 500** |
| formal | **false** (all `kind=benchmark`) |
| Network | Small 64ch / 6 blocks |
| Processes / batch cap / sims | 20 / 128 / 16 |
| Precision / torch.compile | FP32 / ON (warmup 300 passes, 1.788s) |
| Elapsed | 717.955 s (~12.0 min) |
| GAMES_PER_HOUR | **2507.1** (performanceGate = GREEN, ≥1500) |
| SAMPLES_PER_HOUR | 184,554 (36,806 samples, 73.6/game) |
| Moves / game | 87.1 mean (43,555 moves) |
| MCTS_NODES_PER_SECOND | 873.9 (627,416 nodes total) |
| GPU_UTIL | mean 5.66%, P50 6.0%, P95 7.0% (underutilized — expected; CPU/MCTS/IPC bound) |
| VRAM_USED | mean 1,023 MiB, max 1,037 MiB |
| GPU_POWER | mean 88.9 W, max 95.0 W (temp mean 39.8°C) |
| CPU_UTIL | mean 6.13%, P95 8.9% |
| RAM_USED | mean 11.1% (of ~1,007 GiB), P95 15.5% |
| ACTUAL_BATCH_MEAN | 7.38 (fill ratio 5.76%; batch cap 128) |
| INFERENCE | 1,128,850 requests, **0 errors**; P50 1.224 ms, P95 3.253 ms |
| TACTIC WORKER | 1,934 requests, 1,934 OK; fallbacks 0, timeouts 0, restarts 0 |
| ILLEGAL MOVES / NaN / OOM | **0 / 0 / 0** |
| CHECKPOINT RESUME | **PASS** (saved → reloaded, counter+rng restored) |
| 13x13 / 17x17 | 294 (58.8%) / 206 (41.2%) |
| League buckets | selfplay 249 (49.8%) / historical 110 (22.0%) / strong 95 (19.0%) / diverse 46 (9.2%) |
| Result distribution | A 161 / B 157 / C 182 (seats randomized per game) |
| Ledger | 500 rows, 500 unique game_ids, 500 completed, 500 replay_persisted, 0 samples=0 |

Note: benchmark ledger rows do not carry per-seat assignment fields; the official ledger writer (`training/train.py::make_ledger_record`) DOES record `seat_assignments`, and the official run will use it.

## 3. GATES

| Gate | Status |
|---|---|
| COMPUTE_GATE (GPH ≥1500, 0 errors, 0 NaN/OOM, clean ledger) | **PASS** |
| OPPONENT_LEAGUE (persistent worker, 50/20/20/10, 0 fallbacks) | **PASS** |
| BATCHED_INFERENCE (shared broker, 0 errors) | **PASS** |
| CHECKPOINT RESUME | **PASS** |
| DISK_GATE (≥100 GiB free on `/root/autodl-tmp`, recommended ≥150 GiB) | **FAIL** — total 50 GiB, free 49.7 GiB |
| RECOMMEND_LONG_RUN | **NO** — BLOCKED_BY_STORAGE |

`/autodl-pub` (7.3 TiB NFS) is NOT an official training data root per frozen spec and remains unused.
System disk: 30 GiB total, ~28 GiB free (also below gate; not used for training data).

## 4. Official-run configuration (frozen by this benchmark)

EARLY_OFFICIAL_CONFIG (0–5,000 formal episodes):

- Network: Small 64ch / 6 blocks, fresh random init (official counter starts at 0)
- Execution: 20 processes (ProcessInferenceBroker + ProcessSelfPlayPool)
- Inference batch cap: 128; Precision FP32; torch.compile ON
- MCTS sims: 16 (0–5k curriculum), board mix 60% 13×13 / 40% 17×17
- League: 50% self / 20% historical / 20% strong / 10% diverse (per-episode randomized seats)
- Ledger: `kind=formal`, `formal=true`, unique game_id, samples>0, seat_assignments, league bucket, checkpoint id, result, timestamps
- Checkpoints: every 500 (small), every 5000 (major); atomic writes; `training_state.json` atomic per wave
- Data root: `/root/autodl-tmp/invitus/official/` (clean namespace; CPU 118 games and GPU benchmarks are NOT counted)

## 5. Storage projections for 100K

- Replay: 137 MiB / 500 games ≈ 0.274 MiB/game → 100,000 games ≈ **27 GiB**
- Checkpoints: 200 small + 20 major + finals ≈ 3–5 GiB
- Metrics / manifests / evaluation artifacts / backup staging ≈ 2–4 GiB
- Total projected ≈ 31–36 GiB usable (fits 50 GiB tightly, but frozen gate requires ≥100 GiB free with ≥150 GiB recommended for headroom, backup staging, and evaluation datasets)
- Disk safety in-run: warning <20 GiB free, hard stop <10 GiB free (already implemented in train.py)

## 6. ETA to 100,000 formal episodes (dynamic curriculum)

Measured throughput anchors: 16 sims ≈ 2,507 GPH (this run); 32 sims ≈ 996 GPH (100-game run); 64 sims ≈ 407 GPH.

| Scenario | Curriculum assumption | ETA | Est. cost @ ¥7.35/h |
|---|---|---|---|
| BEST | 0–5k @16 sims; 5k–20k @24; 20k–100k @32–48 | ~150 h (~6.3 d) | ~¥1,100 |
| EXPECTED | 0–5k @16 (2h); 5k–20k @24–32 (~15h); 20k–50k @32–64 (~50h); 50k–100k @64–96 (~133h) | ~200 h (~8.3 d) | ~¥1,470 |
| CONSERVATIVE | more sims later + evaluation overheads, node failures, restart costs | ~260 h (~10.8 d) | ~¥1,910 |

Sims upgrades at 5k/20k/50k are decided by measured strength (champion gate + exact-agreement probes), never by throughput alone — we will not freeze at 16 sims just to finish faster.

## 7. Current status and next step

```
500 GAME BENCHMARK
==================
STATUS: COMPLETED 500 / 500
GAMES/HOUR: 2507.1  (GREEN)
ILLEGAL MOVES: 0    NaN: 0    OOM: 0
TACTIC FAILURES: 0    INFERENCE ERRORS: 0
CHECKPOINT RESUME: PASS
COMPUTE_GATE: PASS
DISK TOTAL: 50 GiB    DISK FREE: 49.7 GiB
DISK_GATE: FAIL (need >=100 GiB free, recommend >=150 GiB)
RECOMMEND_LONG_RUN: NO
STATUS: BLOCKED_BY_STORAGE
OFFICIAL FORMAL: 0 / 100000
READY: NO
INVICTUS IS NOT TRAINED YET.
```

**Action required from owner:** expand the AutoDL data disk (`/root/autodl-tmp`) to ≥100 GiB usable (recommended 150–200 GiB) via the AutoDL console, then re-run the gate check (`df -h /root/autodl-tmp`). Once free ≥100 GiB, the clean official run launches automatically (no further human authorization needed per owner directive).

## 8. What happens automatically after disk expansion

1. Create clean namespace `/root/autodl-tmp/invitus/official/` (checkpoints/replay/logs/metrics/evaluations/manifests) with OFFICIAL_RUN_ID and frozen config (git SHA b619ac9, Small 64×6, 20 procs, FP32 compile, sims 16, 60/40 boards, league contract).
2. Launch 0–5k via screen/tmux with formal counter = 0; per-500 ledger verification; per-5000 major checkpoint + candidate eval + historical-league admission + backup staging + report update.
3. Champion gate from 5k (candidate vs champion vs 5★ vs maxn, seat-balanced); curriculum sims escalation decided by measured strength.
4. Continue to ≥100,000 formal episodes; then champion selection (80k/85k/90k/95k/100k+), final tournament (5★+5★, maxn+maxn, strongest baseline pair, historical champion; A/B/C balanced; thousands of games), exact oracle (≥2000 solved positions), value calibration (Brier/LogLoss/ECE by board and seat), search scaling (100–3200 sims), regression gates. READY stays NO until every frozen acceptance criterion passes.

## 9. Known gaps to close before official launch (code work, no re-research)

- `training/train.py` still uses the thread executor; the official run will use the multiprocess path (ProcessInferenceBroker + ProcessSelfPlayPool) — needs a new `official` entrypoint reusing benchmark.py's infra but writing formal ledger + per-wave atomic `training_state.json` + 500/5000 checkpoint cadence.
- Add per-wave NaN/illegal-move/disk/bridge anomaly guards to the official loop (benchmark.py already raises on bridge fallback / inference errors / NaN loss — port to official path).
- External backup staging: `EXTERNAL_BACKUP=NOT_CONFIGURED` until owner configures an off-server destination (AutoDL disk is not a backup).
