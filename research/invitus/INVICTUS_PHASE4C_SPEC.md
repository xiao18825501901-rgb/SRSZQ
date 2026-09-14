# Invitus Phase 4C Specification

## Objective

Determine, with bounded and reproducible experiments, whether Invitus can use a healthier value target and a leakage-free tactical curriculum to improve real playing strength. Phase 4C must explain the repeated value-seat overconfidence and the 0-win results against the 3-star and MaxN baselines before any official 100K run is considered.

## Frozen baseline

- Branch: `research/invitus`.
- Historical controls: V2 Replica A/B at 2,000 games and the stopped V3 smoothing-only arm.
- Exact evaluation set: 200 unique positions, SHA-256 `1a7d79eee017a93f75af566088b61622007411be505e0db4a610aa36c57d1ddc`; evaluation only.
- Policy settings held constant: corrected root noise, `target_tau=2.0`, policy entropy weight `0.05`, 16 training simulations, Small network, and the existing league contract unless an experiment explicitly says otherwise.
- Every Phase 4C training run is `run-class=replica`, `formal=false`, starts from fresh random weights, and uses a clean data root.

## Required behavior

1. The value target path is auditable from engine terminal outcome through replay, batching, network output, loss, MCTS leaf conversion, and absolute-vector backup.
2. Terminal values use one invariant representation: `[P(A), P(B), P(C), P(DRAW)]`; terminal outcomes are independent of current actor, board size, and victory-right phase.
3. `absolute_to_relative` and `relative_to_absolute` are exact inverses for every actor and terminal class. Actor-relative network outputs are converted to absolute vectors before MCTS backup.
4. Value loss and representation are configurable for the three arms: absolute+Brier, actor-relative+CE, actor-relative+Brier. Historical absolute+CE V2 is the control.
5. Calibration reports include Brier, log loss, ECE, reliability bins, empirical outcome rates, predicted means, and seat residuals by board size, actor, and early/mid/late stage.
6. Replay auditing recomputes targets from authoritative terminal results for at least 10,000 samples across both V2 replicas and reports zero mismatches before training proceeds.
7. The strength harness proves candidate-seat attribution and terminal winner mapping with deterministic sanity cases, and confirms production opponent parity with zero bridge fallback.
8. Tactical labels come from deterministic engine or bounded-solver proofs. The frozen tactical evaluation set has at least 600 positions, is balanced across 13x13/17x17 and requested categories, has a recorded hash, and has zero canonical overlap with the training set.
9. Tactical samples support policy-only supervision through `value_loss_mask`. Multiple optimal moves share policy probability.
10. T0/T10/T20 use the same initialization, optimizer steps, self-play pool, value configuration, and model; only tactical sampling ratio changes.

## Commands and project structure

- Python tests: `python research/invitus/tests/run_all.py` plus every discovered `research/invitus/tests/*_test.py` script.
- TypeScript parity/tests: use the repository package scripts recorded in `package.json`.
- Bounded training: `python -m training.official --run-class replica ...` from `research/invitus` on the RTX 5090 host.
- Phase 4C implementation stays under `research/invitus/{model,mcts,training,eval,tests}`; reports and manifests stay under `research/invitus/` or the experiment data root.

## Boundaries

- Always: use fresh experiment roots, preserve seeds/configs/hashes, verify formal count remains zero, audit every checkpoint, and stop failed arms at the stated gate.
- Ask first: none for the bounded Phase 4C experiments explicitly authorized by the execution prompt.
- Never: start Official 100K, modify production deployment/services/data, train on either frozen evaluation set, reuse V2/V3 weights as fresh-arm initialization, publish large replay/checkpoint artifacts to Git, or report success from training loss alone.

## Success criteria

- `VALUE_TARGET_RCA=PASS`: zero replay mismatches, terminal/representation/backup tests pass, and the root cause classification is evidence-backed.
- Complete all three 500-game value arms with 250/500 evaluations unless an explicit early-stop condition fires.
- At least one value configuration improves held-out Brier, ECE, and seat residual without policy collapse or catastrophic strength loss, then reproduces across two independent seeds.
- Tactical forensics classifies at least 100 games against each strong baseline with a reproducible detector.
- Tactical eval/train sets pass hash, balance, label, and zero-overlap audits.
- A tactical arm significantly exceeds T0 without harming exact agreement, entropy, or value calibration, then the combined configuration reproduces in two fresh 2,000-game runs.
- A positive progressive strength curve is visible at 250/500/1000/1500/2000; 3-star is not 0/90 in either final replica, and MaxN shows measurable tactical progress.
- Official recommendation remains `NO` until every scientific gate and writable free-space gate (`>=100 GiB`) passes.

## Assumptions

- The user-provided execution prompt is the reviewed and approved research specification.
- Existing V2 artifacts on the current RTX 5090 server remain the authoritative historical controls after consistency checks.
- Draw probability is a distinct fourth value class; any player utility used during selection must be derived from the absolute distribution without mutating that representation.

