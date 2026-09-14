# Invitus Phase 4C Value Ablation Report

## Protocol

V4-A, V4-B, and V4-C each started from a fresh random initialization and ran 500 non-formal games. All arms used Small 64x6, 16 MCTS simulations, the repaired root noise and centered multiplayer PUCT utility, target tau 2.0, policy entropy weight 0.05, the same opponent-league contract, 20 self-play workers, and checkpoints at 250 and 500 games. Their fixed seeds were 20260930, 20260931, and 20260932 respectively.

The first V4-A process that stopped at 100 games is excluded. It exposed a first-child PUCT lock caused by comparing positive probability utility for visited nodes with zero for unvisited nodes. The valid V4-A r2 began from a clean namespace after centering selection utility by one third.

Calibration in the first table is replay-based and therefore in-sample. Held-out value evidence comes from the frozen 200-position exact set and, after tactical forensics, fresh strong-opponent matchup traces.

## 500-game value results

| Arm | Representation + loss | Replay Brier | Log loss | ECE | Mean absolute seat residual | Exact value Brier | NN top-1 | MCTS16 | Fixed-probe value mean |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| V2-A control | absolute + CE | 0.145614 | 0.987884 | 0.038479 | 0.052731 | 0.229211 | 93.5% | 94.0% | historical |
| V2-B control | absolute + CE | 0.134935 | 0.926223 | 0.204366 | 0.112001 | — | — | — | historical |
| V4-A | absolute + Brier | 0.161330 | 1.096818 | 0.163182 | 0.061389 | 0.177256 | 93.0% | 95.0% | [0.3310, 0.3297, 0.2675, 0.0718] |
| V4-B | actor-relative + CE | **0.154069** | **1.021507** | 0.056504 | 0.014303 | **0.175905** | **94.5%** | 95.0% | [0.3372, 0.3793, 0.2833, 0.0002] |
| V4-C | actor-relative + Brier | 0.167402 | 1.117738 | **0.043770** | **0.013372** | 0.177128 | 93.0% | 95.0% | [0.3295, 0.3311, 0.3285, 0.0110] |

V4-B and V4-C both remove the extreme absolute-seat overconfidence seen in V2-B. V4-B has the best combined probability score: lower Brier and log loss than the other new arms, nearly the best residual, and the strongest frozen exact policy result. V4-C produces the most symmetric prediction mean and marginally lower residual/ECE, but Brier and log loss are worse. Since real seat asymmetry must be retained rather than forcibly erased, symmetry alone is not a selection criterion.

Brier loss without actor-relative representation did not solve calibration. V4-A is worse than V2-A on replay Brier, ECE, and seat residual, although its exact-set value error is substantially lower than the historical V2-A result. The principal useful intervention is the actor-relative representation; CE remains preferable to Brier at this 500-game budget.

## Policy and runtime health

| Arm | Final 100-state network entropy | Visit entropy | Mean top-1 prior | Collapse sentinel | Inference errors | Bridge fallback |
|---|---:|---:|---:|---|---:|---:|
| V4-A | 3.9036 | 1.9174 | 0.1432 | clear | 0 | 0 |
| V4-B | 3.2834 | 1.9259 | 0.1387 | clear | 0 | 0 |
| V4-C | 3.8948 | 2.1625 | 0.0893 | clear | 0 | 0 |

All three valid arms completed 500/500 with an audit-consistent experiment ledger, replay, progress file, optimizer state, and final checkpoint. No arm triggered the collapse sentinel or reported NaN, illegal moves, inference failures, or opponent-bridge fallbacks.

## Strength observations

Code review found that the original threaded strength harness shared one mutable RNG across games. Although Python serialized individual random draws, thread scheduling made exact reruns schedule-dependent. Those original figures are excluded from ranking.

The superseding run used common seed `20260970`, a precomputed seat/board/game-seed schedule, and one private RNG per game. Every checkpoint was tested for 30 games against each opponent pair:

| Checkpoint | random + random | 3-star + 3-star | MaxN + MaxN |
|---|---:|---:|---:|
| V2-A 2,000 | 30/30 | 0/30 | 0/30 |
| V2-B 2,000 | 29/30 | 0/30 | 0/30 |
| V4-A 250 | 30/30 | 1/30 | 0/30 |
| V4-A 500 | 30/30 | 0/30 | 0/30 |
| V4-B 250 | 30/30 | 1/30 | 0/30 |
| V4-B 500 | 30/30 | **2/30** | 0/30 |
| V4-C 250 | 30/30 | **3/30** | 0/30 |
| V4-C 500 | 30/30 | 0/30 | 0/30 |

At 500 games V4-B is the only arm with nonzero 3-star strength under the authoritative protocol, and it improves from 1/30 to 2/30 between checkpoints. Its 500-game Wilson 95% interval is 1.85%-21.32%. The sample is too small to call this competitive, but it is the clearest non-flat signal among the value arms. Every arm remains 0/30 against MaxN, so value repair alone is insufficient.

## Selection

`BEST_VALUE_CONFIG=actor_relative + cross_entropy`

`V4-A=ELIMINATED_AT_500`

`V4-C=CALIBRATION_RUNNER_UP`

V4-B is selected for extension and independent-seed replication. This is a provisional value selection until 2,000-game replication and fresh matchup calibration finish. It does not authorize an official run.

`VALUE_FIX_REPLICATION=PENDING`

`RECOMMEND_OFFICIAL=NO`
