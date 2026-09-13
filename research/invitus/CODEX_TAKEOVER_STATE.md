# CODEX TAKEOVER STATE

Generated: 2026-09-14 (Asia/Shanghai)

## Authority boundary

- Execution owner: Codex.
- Previous DSH tasks and any claimed live background jobs are cancelled.
- The previous GPU server is shut down and will not be queried or treated as live state.
- Source of truth: GitHub `research/invitus`, this Windows repository, committed reports/tests, and checkpoint metadata that passes an explicit consistency audit.
- Production `main`, Netlify, PM2, Caddy, DNS, and the production database are outside this workstream.

## Git takeover baseline

```text
REPOSITORY: xiao18825501901-rgb/SRSZQ
BRANCH: research/invitus
BASE_GIT_SHA: 1aa0a5a96868f9c28409eb28152204d8bed8cbcc
TAKEOVER_CHECKPOINT_SHA: d50128d0f497a99609dfdd6503a32024ea8dcd48
CURRENT_VALIDATED_SHA: 0de67e48887374d589606c0a9deadf4d969401bd
BASE_HEAD_EQUALS_ORIGIN: true
TRACKED_MODIFICATIONS: 0
LOCAL_AHEAD_BEHIND: 0 / 0
```

The pre-takeover audit found no uncommitted Invitus source code. Existing untracked files were deliberately excluded:

| Class | Paths | Decision |
|---|---|---|
| Unrelated W10 work | `docs/SRSZQ_W10_SPEC.md`, `results/w10/` | Preserve locally; do not mix into Invitus |
| Historical local result artifacts | `results/benchmark-2026-09-07T20-00-25-191Z.json`, `results/selfplay-*.json` | Preserve locally; not source code |
| Transfer artifact | `invitus-src.bundle` | Preserve locally; do not commit large/generated bundle |

## Broken V1 identity

```text
RUN: Invitus Small V1, 5000 formal games
IDENTITY: FAILED_EXPERIMENT_V1 / NEGATIVE_CONTROL_V1
CHAMPION_GATE: 0 win / 0 draw / 900 loss
POLICY_ENTROPY: approximately 0.013
VISIT_ENTROPY: approximately 0
TOP1_PRIOR: approximately 0.999
CURRENT_CHAMPION: none
COUNTS_TOWARD_OFFICIAL_V2: false
```

Committed reports, ledger summaries, failure analysis, and the recorded 5K checksum remain historical evidence. The actual 5K checkpoint is not present in Git or the audited local artifact set and is therefore `ARTIFACT_UNAVAILABLE` for recovery experiments. This does not block a fresh restart.

The small local CPU-era artifacts (`invitus_000020*`, `invitus_000024_final.pt`, replay 55–118) remain historical evidence only. Their committed audit says `STATE_CONSISTENT=false`; they are not valid resume inputs.

## Repairs already in Git

- Root Dirichlet prior uses `(1-epsilon) * network_prior + epsilon * dirichlet_noise`.
- Entropy regularization and non-finite loss guards are implemented.
- Policy target temperature softens sparse visit targets.
- Collapse regression tests cover root noise, target normalization, legal masks, finite entropy loss, vector backup, actor mapping, and inference consistency.
- Deterministic actor-balanced synthetic exact-oracle generation is implemented.
- Strength probe and value-label smoothing options are implemented.
- Fresh and warm-start modes are distinct, allowing a controlled recovery-vs-restart experiment only when a validated old checkpoint exists.

## Historical repaired evidence

Two committed 2,000-game V2 replicas avoided policy collapse, but both showed meaningful value-seat overconfidence and remained 0/30 against 3-star and MaxN baselines. Their evidence is reusable as historical experimental data, while all statements that an old server job is still running are stale.

```text
V2_REPLICA_A_POLICY_COLLAPSE: NO
V2_REPLICA_B_POLICY_COLLAPSE: NO
VALUE_SEAT_BIAS: MEDIUM
HISTORICAL_REPLICATION_VERDICT: POLICY_REPAIR_PASS, FULL_MODEL_GATE_NOT_PASS
SEARCH_HEALTH: REQUIRES_FRESH_EXACT_EVALUATION
READY: NO
```

## New server

```text
SSH_ENDPOINT: connect.westc.seetacloud.com:12836
GPU: NVIDIA GeForce RTX 5090, 32607 MiB
SERVER_AUDIT: PASS
CUDA_GATE: PASS (PyTorch 2.12.1+cu130)
DATA_ROOT: /root/autodl-tmp/invitus-codex (writable XFS data volume)
DISK_GATE: FAIL_FOR_OFFICIAL (50 GiB total; requires at least 100 GiB free)
PUBLIC_DATA_MOUNT: /autodl-pub/data is read-only and is not a training target
```

No password, token, private key, or secret is stored in this document.

## Execution plan

1. Push the takeover checkpoint to `origin/research/invitus`.
2. Authenticate to the new server without storing credentials and run a read-only hardware/CUDA/storage audit.
3. Establish the real large writable data root and create isolated experiment namespaces.
4. Clone the exact branch SHA, run the full regression suite, and validate the tactic bridge.
5. Measure RTX 5090 throughput with bounded benchmarks before selecting process and batch settings.
6. Re-run clean V2 Replica A and B with fixed seeds, fixed probes, collapse sentinel, exact probes, and strength probes.
7. Prefer a fresh repaired official run from formal 0. A recovery arm is optional and only permitted if a validated Broken V1 checkpoint becomes available.
8. Start `invitus-small-v2` only after every frozen preflight gate passes.

## Current status

```text
OFFICIAL_RUN_ID: invitus-small-v2
OFFICIAL_RUN: NOT_STARTED
OFFICIAL_FORMAL: 0 / 100000+
LATEST_CHECKPOINT: none
CURRENT_CHAMPION: none
EXTERNAL_BACKUP: NOT_CONFIGURED
READY: NO
```
