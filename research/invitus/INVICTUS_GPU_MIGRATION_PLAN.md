# Implementation Plan: Invitus GPU migration and benchmark gate

## Architecture decisions

- Treat the local ledger/checkpoint/replay mismatch as a data-reconciliation problem before any migration.
- Reuse the production TypeScript tactic implementation through one persistent worker; do not create a second Python tactic implementation.
- Use one GPU inference owner with queued micro-batches; self-play workers do not load separate models.
- Keep local evidence, remote raw data, and Git metadata in separate storage classes.

## Task list

### Phase A: source and state audit

- [x] Confirm branch, fetch remote, inspect dirty worktree, and confirm the CPU trainer is stopped.
- [ ] Add deterministic audit tests for ledger/checkpoint/replay disagreement and corrupt evidence.
- [ ] Implement the audit and atomic `training_state.json` manifest.
- [ ] Run the audit against the real stopped CPU state and record the recovery decision.

Checkpoint: source SHA is known, no user work is overwritten, and the recovery point is evidence-backed.

### Phase B: league and persistent tactic worker

- [ ] Add contract tests for composition ratios, all baseline types, response IDs, timeouts, restart, seed determinism, and legality fallback.
- [ ] Correct the existing uncommitted league/worker implementation and historical checkpoint loading.
- [ ] Integrate truthful seat/opponent metadata into replay and ledger output.
- [ ] Run 500-1,000 local/remote league sampling checks before freezing initial proportions.

Checkpoint: current, historical, strong, weak, and star opponents are all exercised and measured.

### Phase C: remote migration gate

- [ ] Audit `/root/autodl-tmp`, `/root/autodl-fs`, mounts, CPU, RAM, GPU, Python, Node and npm.
- [ ] Stop with `DISK_GATE=FAIL` if free data-disk capacity is below 100 GB.
- [ ] Clone/update `research/invitus` and install only missing lockfile dependencies.
- [ ] Transfer only verified state and small metadata, compare SHA-256, and rerun the audit remotely.

Checkpoint: remote source and verified state match local evidence.

### Phase D: batched GPU inference

- [ ] Add queue/batch/result-routing tests and failure-stop tests.
- [ ] Implement one-model shared inference service with bounded batch wait.
- [ ] Measure FP32 vs BF16 and eager vs `torch.compile` after warm-up.

Checkpoint: CUDA inference batches are real, numerically stable, and observable.

### Phase E: benchmark search

- [ ] Run 10-20 complete non-formal smoke games.
- [ ] Search Tiny/Small/Medium at workers=8, batch=128, sims=16.
- [ ] Search the best models across workers 4/8/12/16/20 and batches 128/256/512.
- [ ] Search sims 16/32/64 without reducing training quality merely to pass throughput.
- [ ] Run a 100-game benchmark with five-second GPU/CPU/RAM samples.
- [ ] Run a 500-game benchmark on the best stable configuration.

Checkpoint: real games/hour, utilization, latency, quality and ETA are measured.

### Phase F: report and handoff

- [ ] Write `INVICTUS_GPU_MIGRATION_REPORT.md` with `READY: NO` and a measured long-run recommendation.
- [ ] If the gate is green, present the exact long-run command, storage paths, stop guards, backup route and estimated cost/time for explicit user authorization.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Ledger is ahead of checkpoint | Inflated formal count | Quarantine the uncheckpointed tail and report raw vs recoverable counts separately |
| Replay rotation removed early games | Incomplete evidence | Record replay episode window and never infer coverage from shard filenames alone |
| Blocking JSONL reads | Hung self-play workers | Real timeout, response-ID validation, process restart, deterministic legal fallback |
| CPU/MCTS/IPC bottleneck | Low GPU utilization | Instrument queue fill, batch sizes, worker idle time, CPU and GPU before tuning |
| Data disk too small | Corruption or interrupted long run | Hard free-space gate plus 20 GB warning and 10 GB graceful stop |
| AutoDL instance loss | Lost training state | 5k checkpoint verification and external backup before long-run authorization |
