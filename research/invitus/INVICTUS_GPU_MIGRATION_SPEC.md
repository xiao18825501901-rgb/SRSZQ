# Spec: Invitus GPU migration and benchmark gate

## Objective

Move the Phase 1/2 Invitus research pipeline from the stopped Windows CPU run to the rented AutoDL NVIDIA RTX 6000D host, reconcile training evidence, complete opponent league and shared batched GPU inference, select a measured training configuration, and run 10-20 smoke games plus 100-game and 500-game benchmarks.

The phase ends with `INVICTUS_GPU_MIGRATION_REPORT.md`. `READY` remains `NO`. The official 100,000-episode run starts only after the benchmark gate passes and the user explicitly authorizes the long paid run.

## Assumptions

1. `research/invitus` remains the only implementation branch; production `main`, Netlify, PM2, database, Caddy, and DNS are out of scope.
2. The existing AutoDL PyTorch 2.12.1+cu130 installation is retained unless an actual incompatibility is demonstrated.
3. `/root/autodl-tmp/invitus` is the intended data root, subject to a writable-disk check and at least 100 GB free space.
4. The stopped CPU run is evidence to audit. Uncheckpointed ledger/replay tail data is quarantined rather than counted as resumable formal training.
5. `diff_100k.jsonl` is regenerated when needed and is never migrated.

## Tech stack

- Python 3.11 locally and Python 3.12.3 remotely
- PyTorch 2.12.1; CUDA 13.0 runtime on the RTX 6000D host
- TypeScript production game engine and tactics through one persistent Node/tsx JSONL worker
- Git branch `research/invitus`

## Commands

Local audit:

```powershell
C:\Python311\python.exe research\invitus\training\audit_training_state.py --root research\invitus
C:\Python311\python.exe research\invitus\tests\audit_training_state_test.py
C:\Python311\python.exe research\invitus\tests\league_smoke.py
```

Remote environment and storage checks:

```bash
python3 -c 'import torch; print(torch.__version__, torch.cuda.is_available(), torch.version.cuda, torch.cuda.get_device_name(0))'
df -h / /root/autodl-tmp /root/autodl-fs 2>/dev/null || true
findmnt
lsblk
```

Repository verification:

```bash
git checkout research/invitus
git pull --ff-only origin research/invitus
git status --short --branch
```

## Project structure

- `training/`: ledger audit, manifest, replay, trainer, inference service, checkpoint policy
- `tools/`: persistent tactic worker and operational utilities
- `tests/`: deterministic unit, integration, smoke, and resume tests
- `benchmarks/`: small benchmark metadata committed to Git
- `/root/autodl-tmp/invitus/`: remote checkpoints, replay, logs, oracle data, raw benchmarks, backup staging

## Interfaces

The tactic worker uses one JSON object per line. Requests contain `id`, board state, turn, player, seed, and exactly one of `tactic` or `difficulty`. Responses repeat `id` and contain a move or pass plus timing and structured error information. Python validates IDs, response shape, legality, timeout, and process health before accepting a move.

The inference service owns one GPU model. Self-play workers submit encoded states to a bounded queue. A collector forms batches up to the configured maximum or latency deadline, runs one inference call, and routes policy/value results back to the originating request.

## Testing strategy

- Training-state audit: temporary ledgers, replay shards, valid/corrupt checkpoints, duplicates, missing evidence, manifest atomicity.
- Tactic worker: five pure tactics and five star profiles, deterministic seed, invalid response fallback, timeout and restart.
- Inference: batch formation, result routing, bounded wait, FP32/BF16 deviation, NaN/Inf and OOM stop conditions.
- Smoke: 10-20 complete non-formal games with checkpoint/resume, league, replay, ledger and CUDA inference.
- Performance: warm-up followed by staged model/worker/batch/simulation search, then 100 and 500 complete games with system metrics.

## Boundaries

- Always: preserve uncommitted work before editing; use atomic state files; checksum migrated files; keep formal/smoke/benchmark/evaluation ledgers separate; stop on corruption, illegal moves, NaN/Inf, OOM, GPU reset, or low disk.
- Ask first: start the paid 100,000-episode long run; add external backup credentials; change the frozen acceptance criteria.
- Never: count pilot/smoke/benchmark/evaluation as formal; migrate `diff_100k.jsonl`; store large artifacts in Git or `/autodl-pub`; expose credentials; touch production systems.

## Success criteria

1. Local audit reports raw ledger count, replay window, checkpoint internals, maximum defensible recovery point, and `STATE_CONSISTENT` without trusting filenames.
2. Remote data disk is writable and has at least 100 GB free; otherwise the phase stops with `DISK_GATE=FAIL`.
3. Local and remote verified state checksums match and the remote audit reproduces the local conclusion.
4. Opponent league includes current, historical, five pure tactics, and 1-5 star profiles with measured composition.
5. Persistent tactic worker and shared GPU batched inference pass functional and failure tests.
6. FP32/BF16 and eager/compile measurements select a stable configuration based on throughput and numerical deviation.
7. Smoke, 100-game, and 500-game runs finish with no illegal moves, crash, NaN, OOM, ledger corruption, replay corruption, or checkpoint corruption.
8. The 500-game result reports real games/hour and ETA. Long-run recommendation is YES only at at least 1,500 games/hour, at least 60% GPU utilization, clean data, and meaningful search/network settings.

## Open questions

- The AutoDL SSH host, port, and authentication route are not present in the repository or supplied prompt and must be resolved from the user's existing secure connection details.
- The external checkpoint backup target must be confirmed before an official long run.
