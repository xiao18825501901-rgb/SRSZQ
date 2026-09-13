# INVICTUS CODEX TAKEOVER REPORT

Updated: 2026-09-14 (Asia/Shanghai)

This is the live handoff ledger for the Codex-owned RTX 5090 run. Historical reports may be cited as evidence, but their old server process status is stale.

## Current dashboard

```text
SERVER: PASS — autodl-container-875041b2e1-40d2f8f1, Ubuntu 22.04.5
GPU: PASS — NVIDIA GeForce RTX 5090, driver 580.76.05
VRAM: 32607 MiB
PYTORCH_CUDA: PASS — torch 2.12.1+cu130, CUDA available, finite matmul
DATA ROOT: /root/autodl-tmp/invitus-codex
DISK: FAIL_FOR_OFFICIAL — 50.0 GiB total / ~49.6 GiB free; requires >=100 GiB
GIT BRANCH: research/invitus
TAKEOVER BASE SHA: d50128d0f497a99609dfdd6503a32024ea8dcd48
CURRENT GIT SHA: 0de67e48887374d589606c0a9deadf4d969401bd
SERVER GIT SHA: 0de67e48887374d589606c0a9deadf4d969401bd
TEST SUITE: PASS — 11 scripts, plus GPU replica smoke
ROOT NOISE FIX: PASS
V2 REPLICA A: RTX5090 250/2000 PASS — audit consistent, fixed-probe healthy; next gate 500
V2 REPLICA B: HISTORICAL 2000 COMPLETE; NEW_5090_REPLICATION_NOT_STARTED
COLLAPSE STATUS: BROKEN_V1_CONFIRMED; REPAIRED_V2_HISTORICALLY_NO_POLICY_COLLAPSE
VALUE STATUS: MEDIUM_SEAT_BIAS_REMAINS
FIXED PROBES: PASS — 300 deterministic positions, 18 size/stage/actor cells (16–17 each)
EXACT PIPELINE: RUNNING — fresh actor-balanced synthetic 200-position set
SEARCH HEALTH: PENDING
OFFICIAL RUN ID: invitus-small-v2
OFFICIAL RUN: NOT_STARTED
OFFICIAL FORMAL: 0 / 100000+
LATEST CHECKPOINT: none
CHAMPION: none
GPH: 1236.724 best bounded self-play benchmark (20 workers, batch cap 256, 16 sims)
ERRORS: one benchmark-only zero-entropy metric bug found, regression-tested, fixed in 843b955
COST: provider UI reported less than 24 hours; only checkpoint-bounded experiments allowed
ETA: Replica 2K approximately 1.6 h pure self-play; training/evaluation overhead measured separately
EXTERNAL BACKUP: NOT_CONFIGURED
READY: NO
```

## Frozen scientific interpretation

- Broken V1 5K is a negative control and contributes zero games to Official V2.
- Historical V2 A/B supports the root-noise and policy-collapse repair, but does not clear the value-calibration or strength gates.
- The new environment must reproduce correctness before throughput tuning.
- Latest checkpoint and current champion remain separate identities.
- A checkpoint is resumable only when `audit_training_state` reports `STATE_CONSISTENT=true`.
- Official V2 starts from a fresh model and formal 0 unless a later, explicit comparison proves a recovery arm scientifically preferable.

## RTX 5090 bounded benchmark

All rows are `formal=false`; checkpoint reload passed and tactic fallback/inference error counts were zero.

| Workers | Batch cap | Games | GPH | Gate | GPU mean |
|---:|---:|---:|---:|---|---:|
| 8 | 64 | 16 | 475.235 | RED | 3.0% |
| 12 | 128 | 24 | 656.188 | RED | 3.5% |
| 16 | 128 | 32 | 914.604 | YELLOW | 3.8% |
| 20 | 256 | 40 | 1236.724 | YELLOW | 3.4% |

The measured bottleneck is process-side search and environment work, not GPU memory. Replica A therefore uses 20 workers, a 256 inference cap, FP32 compile, and 16 simulations. This is a correctness-validation configuration; no 100K throughput claim is derived from these short runs.

## New guardrails

- Replica runs write `kind=experiment`, `formal=false`; the audited formal counter remains zero.
- Every wave emits policy/training entropy, target and visit entropy, effective support, root/network prior entropy, top-1 probability, action counts, value predictions, outcomes, opening diversity, game length, GPH, and resource samples.
- A rolling 100-game collapse sentinel gracefully stops when network-prior entropy is below 0.25, visit entropy below 0.10, and mean top-1 prior exceeds 0.95.
- A deterministic fixed set contains 300 legal positions spanning 13x13/17x17, A/B/C, and early/mid/late stages. It is evaluation-only and never enters replay.

## Replica A — 250-game gate

```text
RUN_ID: rtx5090-v2-replica-a
SEED: 20260914
EXPERIMENTAL: 250
FORMAL: 0
STATE_CONSISTENT: true
DUPLICATE_GAME_IDS: 0
INVALID_LEDGER_ROWS: 0
GPH: 1184.148 (includes eight train steps per wave)
ROLLING_100_POLICY_ENTROPY: 2.9564
ROLLING_100_VISIT_ENTROPY: 0.9198
ROLLING_100_TOP1_PRIOR: 0.1929
COLLAPSE_SENTINEL: NOT_TRIGGERED
FIXED_300_POLICY_ENTROPY: 2.9113
FIXED_300_TOP1: 0.1984
FIXED_300_VALUE_MEAN: [0.3874, 0.4328, 0.1773, 0.0025]
INFERENCE_ERRORS: 0
TACTIC_FALLBACKS: 0
```

The first gate is healthy relative to Broken V1: policy entropy is far from zero, top-1 is far from 0.999, opening diversity is broad, and the value head has not locked onto one seat. This is an early gate only and does not establish 2,000-game stability or baseline strength.

## Next checkpoint

Continue Replica A through the 500-game checkpoint, re-run the same fixed probes, and execute the first seat-balanced strength probe. Official V2 remains blocked by storage and all scientific gates. This report must not report `READY=YES` until every criterion in `INVICTUS_ACCEPTANCE_CRITERIA.md` passes.
