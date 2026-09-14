# Invitus Value Target RCA Report

Updated: 2026-09-14 (Asia/Shanghai)

## Verdict

```text
VALUE_TARGET_RCA: PASS
REPLAY_TARGET_MISMATCH: 0 / 10000
BAD_STORED_LABELS: NOT FOUND
VALUE_SEMANTICS_DEFECT: FOUND_AND_FIXED
PRIMARY_CALIBRATION_MECHANISM: RECENT-REPLAY SAMPLE IMBALANCE + NETWORK OVERCONFIDENCE
REAL_SEAT_ADVANTAGE: POSSIBLE AND PRESERVED
OFFICIAL_STARTED: NO
```

The stored replay outcome is not the source of the repeated seat bias. A deterministic reservoir audit sampled 5,000 records from each RTX 5090 V2 replica and recomputed every target from the authoritative per-game ledger result. All 10,000 stored targets matched. The stronger Replica B bias is visible in both its recent replay labels and its predicted probabilities, but the model amplifies that imbalance substantially.

## Source and evidence

- Phase 4C implementation source: `research/invitus` at `19e8dfd2b9580d349a6cbd966b9c44bec9fa52b6` when the bounded value arms started.
- Audit artifact: `/root/autodl-tmp/invitus-codex/phase4c/value-target-audit.json`.
- Calibration artifacts: `/root/autodl-tmp/invitus-codex/phase4c/calibration-v2-a.json` and `calibration-v2-b.json`.
- Frozen exact set remains evaluation only, 200 unique positions, SHA-256 `1a7d79eee017a93f75af566088b61622007411be505e0db4a610aa36c57d1ddc`.

## End-to-end target path

1. The Python engine emits one absolute terminal vector through `engine.srszq.outcome_vector`: A/B/C wins map to their one-hot class and draw maps to `[0,0,0,1]`.
2. Self-play and league code copy that same absolute vector to every sample from the completed game.
3. Replay JSONL stores the vector with `game_id`; the ledger stores the matching `terminal_result` after replay persistence.
4. The batch builder keeps absolute targets for `absolute` mode or maps them to `[current,next,previous,DRAW]` for `actor_relative` mode.
5. The network emits four log-softmax classes. CE uses the target class distribution; Brier uses mean squared error on the softmax probability vector. Policy-only samples are explicitly masked out of value loss.
6. Actor-relative inference is converted back to `[A,B,C,DRAW]` immediately at the MCTS leaf boundary.
7. MCTS and exact solver store and back up only the absolute vector. Selection derives the acting player's utility as `P(actor)+P(DRAW)/3` without changing the stored vector.

## Terminal invariants

Automated tests cover both board sizes, all three current actors, turns before and after victory rights begin, and every A/B/C/DRAW terminal class. Relative-to-absolute round trips cover all actors and terminal classes. The 18 discovered Python test scripts passed after the repair.

One real semantic defect was found: MCTS and Exact Solver previously represented a terminal draw as `[1/3,1/3,1/3,0]`, while training, architecture documents, and calibration used `[0,0,0,1]`. This mixed outcome probability with player utility. Commit `6a1aa92` restores a single absolute representation and derives shared draw utility only during action selection. Frozen exact best-move semantics remain equivalent because a proved draw still gives each actor utility `1/3`.

## Replay target audit

| Replica | Requested | Sampled | Available recent replay samples | Ledger games | Missing ledger | Malformed | Mismatch |
|---|---:|---:|---:|---:|---:|---:|---:|
| V2 A | 5,000 | 5,000 | 12,014 | 2,000 | 0 | 0 | 0 |
| V2 B | 5,000 | 5,000 | 6,247 | 2,000 | 0 | 0 | 0 |

The replay buffer retains the most recent 128 shards, so this is an audit of the samples available to the final training window rather than every historical sample. That limitation is useful for RCA: the final model is trained from this recent window.

### Sample-level winner labels

| Replica | A | B | C | DRAW |
|---|---:|---:|---:|---:|
| V2 A | 2,344 (46.88%) | 2,288 (45.76%) | 290 (5.80%) | 78 (1.56%) |
| V2 B | 3,009 (60.18%) | 1,145 (22.90%) | 846 (16.92%) | 0 |

### Current actor x eventual winner

Replica A:

| Actor | A | B | C | DRAW |
|---|---:|---:|---:|---:|
| A | 740 | 760 | 108 | 27 |
| B | 773 | 705 | 146 | 25 |
| C | 831 | 823 | 36 | 26 |

Replica B:

| Actor | A | B | C | DRAW |
|---|---:|---:|---:|---:|
| A | 947 | 298 | 328 | 0 |
| B | 1,013 | 410 | 350 | 0 |
| C | 1,049 | 437 | 168 | 0 |

The target does not depend incorrectly on current actor. The imbalance comes from how many samples each completed result contributes to the retained window: long games contribute more training rows, and only recent shards remain active.

## Stage-conditioned calibration

These baseline metrics use replay data and are therefore in-sample diagnostics. They are not the held-out acceptance score.

| Replica | Brier | Log loss | ECE | Predicted mean A/B/C/D | Empirical A/B/C/D | Mean abs residual |
|---|---:|---:|---:|---|---|---:|
| V2 A | 0.145614 | 0.987884 | 0.038479 | .360/.463/.147/.029 | .455/.474/.056/.015 | 0.052731 |
| V2 B | 0.134935 | 0.926223 | 0.204366 | .819/.100/.080/.001 | .596/.235/.169/.000 | 0.112001 |

Replica B's lower Brier does not mean healthier calibration: its retained labels are majority A, and its network further raises mean P(A) from empirical `0.596` to `0.819`. Its top-label ECE is five times Replica A's.

| Replica B stage | Samples | Predicted P(A) | Empirical A outcome | ECE |
|---|---:|---:|---:|---:|
| Early | 3,633 | 0.828 | 0.637 | 0.173 |
| Mid | 1,286 | 0.796 | 0.489 | 0.313 |
| Late | 81 | 0.812 | 0.444 | 0.367 |

The overconfidence grows as empirical A outcomes fall in mid/late samples. This rules out an explanation based only on a genuine global first-seat advantage.

## Root-cause classification

| Candidate cause | Finding |
|---|---|
| A. Wrong stored target | Rejected: 0/10,000 mismatch. |
| B. Sample class imbalance | Confirmed: retained Replica B samples are 60.18% A-labelled; result length and recent-shard retention weight samples. |
| C. Real seat prior | Plausible: the game is asymmetric; no balancing constraint is imposed. |
| D. Network overconfidence | Confirmed: Replica B predicts P(A)=0.819 against empirical 0.596, with ECE 0.204. |
| E. Combination | Best explanation: B + possible C + D, plus the repaired draw-semantic inconsistency in search. |

No experiment will force A/B/C equality. Phase 4C compares losses and actor-relative representation to reduce excess confidence while preserving any measured seat advantage.

## Independent evaluation sanity

- Python and production TypeScript engines matched on current actor, round, victory right, legal moves, forbidden cells, terminal fields, and probe application for 100,000 generated legal states: 0 mismatch.
- Production opponent tactics passed 24 focused legality, tactical, and probability-mixer tests.
- A constructed candidate-seat immediate-win state passed the complete evaluation path and was recorded as the candidate's win.
- The V2 strength rerun after adding a formal-rules root tactical shield changed Replica A from 16/30 to 29/30 against random and from 0/30 to 1/30 against 3-star; MaxN remained 0/30. Replica B moved from 14/30 to 26/30 against random but remained 0/30 against both strong baselines. This proves that a missing runtime tactical layer was material, while deeper tactical/value learning is still required.

## Next gate

V4-A absolute+Brier, V4-B actor-relative+CE, and V4-C actor-relative+Brier are running as fresh, bounded 500-game replicas with identical policy, league, optimizer-step, network, search, and root-shield settings. Selection will use calibration, exact agreement, entropy, and strong-baseline performance together. Official remains stopped and the 50 GiB disk still fails the official storage gate.
