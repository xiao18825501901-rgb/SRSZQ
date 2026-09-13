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
VALIDATED SOURCE SHA: 45311cea3b3c4d348f42ab490830d270b8a283ca
SERVER SOURCE SHA: 45311cea3b3c4d348f42ab490830d270b8a283ca
TEST SUITE: PASS — 11 discovered scripts, plus GPU replica smoke
ROOT NOISE FIX: PASS
V2 REPLICA A: RTX5090 2000/2000 COMPLETE — audit consistent, no policy collapse; value/strength gates fail
V2 REPLICA B: RTX5090 2000/2000 COMPLETE — audit consistent, no policy collapse; severe A-seat value bias and strength gates fail
COLLAPSE STATUS: PASS — BOTH_NEW_REPLICAS_NO_POLICY_COLLAPSE_AT_2000
VALUE STATUS: FAIL — SEAT_PREDICTOR_BIAS_REPRODUCED, strongest in Replica B
FIXED PROBES: PASS — 300 deterministic positions, 18 size/stage/actor cells (16–17 each)
EXACT PIPELINE: PASS — 200 unique exact-solved states, exact six-cell quota, validated manifest
SEARCH HEALTH: PASS — raw top-1 93.5%, top-5 99%; MCTS16/24/32 all 94%, no degradation
V3 SMOOTHING DIAGNOSTIC: STOPPED_AT_500 — balanced random results but value bias and 0/30 strong baselines remain
OFFICIAL RUN ID: invitus-small-v2
OFFICIAL RUN: NOT_STARTED
OFFICIAL FORMAL: 0 / 100000+
LATEST EXPERIMENT CHECKPOINTS: Replica A/B invitus_002000_final.pt; V3 diagnostic invitus_000500_final.pt
OFFICIAL LATEST CHECKPOINT: none
CHAMPION: none
GPH: 1236.724 best bounded self-play benchmark (20 workers, batch cap 256, 16 sims)
ERRORS: zero-entropy metric fixed in 843b955; resumed GPH fixed in ba50def; incomplete exact quota fixed in 45311ce
COST: provider UI reported less than 24 hours; only checkpoint-bounded experiments allowed
ETA: V2 A/B 2K and bounded V3 diagnostic complete; official ETA unavailable until storage and scientific gates pass
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

## RTX 5090 replica gates

Replica A uses seed `20260914`; Replica B uses seed `20260915`. Every listed checkpoint passed the experiment-ledger audit with formal count zero, no duplicate game IDs, and no invalid ledger rows. Throughput includes eight train steps per wave.

| Replica | Gate | GPH | Rolling policy entropy | Rolling visit entropy | Rolling top-1 | Fixed-300 entropy | Fixed-300 top-1 | Fixed-300 value mean | Sentinel |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| A | 250 | 1184.148 | 2.9564 | 0.9198 | 0.1929 | 2.9113 | 0.1984 | [0.3874, 0.4328, 0.1773, 0.0025] | clear |
| A | 500 | 1117.747 | 1.8656 | 0.9477 | 0.3915 | 2.1211 | 0.3889 | [0.4586, 0.1739, 0.3660, 0.0015] | clear |
| A | 750 | 1061.569 | 1.6777 | 0.8849 | 0.4300 | 2.4017 | 0.3066 | [0.3686, 0.5090, 0.1182, 0.0042] | clear |
| A | 1000 | 1074.500 | 1.6115 | 0.8287 | 0.4601 | 2.1152 | 0.3817 | [0.5261, 0.2692, 0.2011, 0.0036] | clear |
| A | 1250 | 1047.300 | 1.2980 | 0.7212 | 0.5409 | 2.0816 | 0.3905 | [0.4389, 0.2074, 0.3385, 0.0152] | clear |
| A | 1500 | 1116.100 | 1.3795 | 0.7431 | 0.5216 | 1.7293 | 0.4656 | [0.3071, 0.3617, 0.3081, 0.0231] | clear |
| A | 1750 | 978.400 | 1.3520 | 0.7109 | 0.5361 | 1.6280 | 0.4882 | [0.3715, 0.5175, 0.1070, 0.0040] | clear |
| A | 2000 | 910.700 | 1.3224 | 0.6623 | 0.5571 | 1.6205 | 0.4936 | [0.3643, 0.4495, 0.1544, 0.0317] | clear |
| B | 250 | 1052.534 | 2.6503 | 0.9619 | 0.2564 | 2.9874 | 0.1925 | [0.2365, 0.6759, 0.0825, 0.0050] | clear |
| B | 500 | 963.463 | 2.0452 | 0.8695 | 0.3727 | 2.8676 | 0.2291 | [0.4033, 0.3691, 0.2229, 0.0048] | clear |
| B | 750 | 888.700 | 1.8776 | 0.8505 | 0.3991 | 2.3566 | 0.3185 | [0.3442, 0.4735, 0.1744, 0.0079] | clear |
| B | 1000 | 1053.300 | 1.4919 | 0.7620 | 0.4870 | 2.0526 | 0.3851 | [0.6112, 0.1992, 0.1888, 0.0007] | clear |
| B | 1250 | 1436.600 | 1.2683 | 0.7295 | 0.5402 | 2.2812 | 0.3473 | [0.4338, 0.2522, 0.2957, 0.0184] | clear |
| B | 1500 | 1463.200 | 1.1876 | 0.6946 | 0.5686 | 2.2759 | 0.3563 | [0.6464, 0.1616, 0.1906, 0.0014] | clear |
| B | 1750 | 1861.800 | 1.0064 | 0.6152 | 0.6225 | 2.2402 | 0.3706 | [0.6646, 0.1650, 0.1683, 0.0021] | clear |
| B | 2000 | 1907.200 | 1.2570 | 0.6594 | 0.5692 | 2.2204 | 0.3844 | [0.7664, 0.1253, 0.1078, 0.0005] | clear |

Both fresh replicas remain healthy relative to Broken V1: policy entropy is far from zero, top-1 is far from 0.999, and the collapse sentinel has never triggered. The value predictions still move materially between seats and checkpoints, so calibration remains unresolved.

## 2,000-game stability verdict

The final experiment audits report 2,000 unique, completed, replay-persisted games and zero invalid rows for each replica. Formal count remains zero. Board coverage is A: 1,172 on 13x13 and 828 on 17x17; B: 1,104 on 13x13 and 896 on 17x17.

Across the final 400 games, Replica A's network-prior entropy slope was `-0.0140` per 100 games and Replica B's was `+0.0819`; neither shows runaway collapse. Their final-100 visit-entropy means were `0.6623` and `0.6594`, and their final-100 top-1 prior means were `0.5571` and `0.5692`. Nine-ply opening diversity remained broad at 327 and 370 unique sequences in the final 400 games.

Value behavior does not pass. Replica A's final-400 value mean was `[0.4161, 0.4256, 0.1504, 0.0079]`; Replica B's was `[0.6620, 0.1675, 0.1668, 0.0036]`. Replica B's self-play outcomes were also seat-skewed at A/B/C `800/574/626`, while Replica A was balanced at `672/677/649`. The root-noise and entropy repair therefore fixes the policy-collapse failure but does not produce an acceptable V2 training configuration.

## Strength probes

Each matchup contains 30 evaluation-only games with ten games in each candidate seat.

| Replica | Opponents | Wins | Seat wins A/B/C | Seat-adjusted win rate |
|---|---|---:|---|---:|
| A | random + random | 14/30 | 4 / 4 / 6 | 0.4667 |
| A | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| A | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |
| B | random + random | 14/30 | 4 / 5 / 5 | 0.4667 |
| B | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| B | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |
| A at 1,000 | random + random | 13/30 | 4 / 5 / 4 | 0.4333 |
| A at 1,000 | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| A at 1,000 | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |
| B at 1,000 | random + random | 19/30 | 7 / 5 / 7 | 0.6333 |
| B at 1,000 | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| B at 1,000 | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |
| A at 1,500 | random + random | 16/30 | 8 / 6 / 2 | 0.5333 |
| A at 1,500 | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| A at 1,500 | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |
| B at 1,500 | random + random | 16/30 | 6 / 7 / 3 | 0.5333 |
| B at 1,500 | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| B at 1,500 | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |
| B at 2,000 | random + random | 14/30 | 6 / 4 / 4 | 0.4667 |
| B at 2,000 | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| B at 2,000 | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |
| A at 2,000 | random + random | 16/30 | 7 / 4 / 5 | 0.5333 |
| A at 2,000 | 3-star + 3-star | 0/30 | 0 / 0 / 0 | 0.0000 |
| A at 2,000 | MaxN + MaxN | 0/30 | 0 / 0 / 0 | 0.0000 |

The two independent 500-game checkpoints reproduce the same result: no policy collapse, roughly chance-level performance in three-player games against two random agents, and no wins against either stronger baseline. Replica A at 1,000 games did not improve that pattern, while Replica B at 1,000 improved against the random pair with a Wilson 95% lower bound of 0.4551. Replica A at 1,500 reached a random-pair lower bound of 0.3614, but its seat split was uneven at 8/6/2. Neither replica has won against the stronger baselines. These results remain experimental trend evidence and do not clear the formal strength gate.

The realized 2,000-game league mix was A: 1,023 self-play, 394 historical, 414 strong, and 169 diverse games; B: 1,048 self-play, 352 historical, 472 strong, and 128 diverse games. Tactic-bridge fallback count remained zero. The strength failure therefore cannot be explained by an accidental all-self-play run.

## Exact oracle and search health

The first single-seed generator run returned successfully with only 187/200 solved positions because solver-budget failures were not replaced. Commit `45311ce` adds exact per-cell quotas, replacement sampling, an explicit incomplete-result failure, and regression coverage. The final evaluation set deterministically combines valid solved records from seeds `20260916` and `20260914`, prefers the repaired run, and records both source hashes in a manifest.

```text
POSITIONS: 200
UNIQUE_CANONICAL: 200
INVALID_INPUT_ROWS: 0
DUPLICATE_INPUT_ROWS: 0
13x13 A/B/C: 34 / 34 / 33
17x17 A/B/C: 33 / 33 / 33
SHA256: 1a7d79eee017a93f75af566088b61622007411be505e0db4a610aa36c57d1ddc
```

Replica A at 2,000 games was evaluated on that frozen set. Raw network top-1 agreement with an exact-best action was `0.935`, top-5 agreement was `0.990`, and value Brier mean was `0.229211`. MCTS agreement was `0.940` at 16, 24, and 32 simulations. Search improves slightly over raw top-1 and does not degrade as simulations increase, so the bounded search-health gate passes. The unchanged result across budgets also shows that higher inference search alone is not the current strength bottleneck.

## Bounded V3 value-smoothing diagnostic

A fresh same-seed diagnostic arm changed only `value_smooth` from `0.0` to `0.10` and stopped at 500 experimental games. Its 250-game fixed-probe value mean improved to `[0.2674, 0.3932, 0.2656, 0.0738]`, but at 500 games regressed to `[0.6393, 0.1594, 0.1754, 0.0259]`. The 500-game strength probe scored 16/30 against two random agents with a balanced 5/6/5 seat split, but remained 0/30 against both 3-star and MaxN pairs. Label smoothing alone is therefore insufficient and this arm was stopped rather than extended.

## Next checkpoint

Treat V2 as a failed configuration because of reproducible value-seat bias and zero wins against the stronger baselines. The first V3 label-smoothing-only arm also failed; the next change must address value-target symmetry/calibration and measured tactical learning rather than merely increase smoothing or inference search. Official training also remains blocked by the 50 GiB storage volume. This report must not report `READY=YES` until every criterion in `INVICTUS_ACCEPTANCE_CRITERIA.md` passes.
