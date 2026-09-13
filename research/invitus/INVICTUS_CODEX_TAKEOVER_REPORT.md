# INVICTUS CODEX TAKEOVER REPORT

Updated: 2026-09-14 (Asia/Shanghai)

This is the live handoff ledger for the Codex-owned RTX 5090 run. Historical reports may be cited as evidence, but their old server process status is stale.

## Current dashboard

```text
SERVER: PENDING_READ_ONLY_AUDIT
GPU: EXPECTED NVIDIA RTX 5090; UNVERIFIED
VRAM: UNVERIFIED
PYTORCH_CUDA: UNVERIFIED
DATA ROOT: UNSELECTED
DISK: UNVERIFIED
GIT BRANCH: research/invitus
TAKEOVER BASE SHA: 1aa0a5a96868f9c28409eb28152204d8bed8cbcc
SERVER GIT SHA: NOT_CLONED
TEST SUITE: NOT_RUN_ON_NEW_SERVER
ROOT NOISE FIX: PRESENT_IN_GIT; NEW_SERVER_TEST_PENDING
V2 REPLICA A: HISTORICAL 2000 COMPLETE; NEW_5090_REPLICATION_NOT_STARTED
V2 REPLICA B: HISTORICAL 2000 COMPLETE; NEW_5090_REPLICATION_NOT_STARTED
COLLAPSE STATUS: BROKEN_V1_CONFIRMED; REPAIRED_V2_HISTORICALLY_NO_POLICY_COLLAPSE
VALUE STATUS: MEDIUM_SEAT_BIAS_REMAINS
EXACT PIPELINE: IMPLEMENTED; NEW_5090_RUN_PENDING
SEARCH HEALTH: PENDING
OFFICIAL RUN ID: invitus-small-v2
OFFICIAL RUN: NOT_STARTED
OFFICIAL FORMAL: 0 / 100000+
LATEST CHECKPOINT: none
CHAMPION: none
GPH: UNMEASURED_ON_RTX_5090
ERRORS: none in takeover execution
COST: PROVIDER_BALANCE_UNVERIFIED; LONG_RUN_FORBIDDEN UNTIL CHECKED
ETA: UNAVAILABLE UNTIL BENCHMARK
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

## Next checkpoint

This report will be updated after the RTX 5090 hardware audit, CUDA smoke, real data-disk selection, exact Git clone, regression suite, and first measured benchmark. It must not report `READY=YES` until every criterion in `INVICTUS_ACCEPTANCE_CRITERIA.md` passes.
