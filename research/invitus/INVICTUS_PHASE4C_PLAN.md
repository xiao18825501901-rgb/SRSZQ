# Invitus Phase 4C Implementation Plan

## Dependency order

Value and evaluation invariants must be proven before training. Value arms depend on the configurable representation/loss path. Tactical curriculum depends on a frozen evaluation set, a disjoint training set, and loss masks. Combined replicas depend on both ablations selecting a winner.

## Tasks

### Phase 1: Restore and audit

- [ ] Record local/server Git SHA, GPU, disk, live processes, artifact roots, and official ledger count.
- [ ] Audit at least 10,000 V2 A/B replay samples against ledger terminal results; report sample-level actor x winner distributions.
- [ ] Add failing terminal, draw-semantics, relative-round-trip, MCTS-backup, and strength-attribution tests; fix only confirmed invariant violations.
- [ ] Run the existing Python and TypeScript engine/opponent parity suites.

Checkpoint: no target mismatch, no evaluation attribution mismatch, no engine parity failure, formal count zero.

### Phase 2: Value configuration and measurement

- [ ] Add configurable absolute/actor-relative value conversion at the network boundary.
- [ ] Add CE/Brier value-loss selection while preserving policy loss and absolute MCTS backup.
- [ ] Extend calibration to stage-conditioned reliability bins and held-out evaluation sources.
- [ ] Add run-manifest/checkpoint compatibility for value representation and value loss.

Checkpoint: focused tests and full Python suite pass; legacy checkpoints load as absolute+CE.

### Phase 3: Value ablation

- [ ] Run V4-A, V4-B, and V4-C from fresh, recorded seeds to 500 games, evaluating 250 and 500.
- [ ] Rank arms by held-out Brier, ECE, seat residual, exact error, entropy, and strength; stop explicit failures.
- [ ] Extend the best one or two arms to 2,000 and replicate the best value fix with a second independent seed.

Checkpoint: select a replicated value configuration or record `VALUE_FIX_NOT_REPLICATED` and stop before tactical training.

### Phase 4: Tactical forensics and datasets

- [ ] Instrument evaluation traces and classify the first provable tactical error in at least 100 games versus each strong baseline.
- [ ] Audit and, if required, repair the runtime immediate-win/forced-defense shield with regression tests.
- [ ] Generate and freeze a balanced 600-position tactical evaluation set with hash manifest.
- [ ] Generate a disjoint 5,000-20,000-position tactical training set and verify zero canonical overlap.

Checkpoint: tactical histogram explains the dominant failures; datasets pass balance, proof, hash, and leakage gates.

### Phase 5: Tactical curriculum

- [ ] Add policy-only/value-masked tactical samples and optimal-action distribution targets.
- [ ] Run fair T0/T10/T20 same-step ablations on the best value configuration.
- [ ] Select the tactical ratio using held-out accuracy, strong-baseline strength, exact agreement, entropy, and calibration.

Checkpoint: select a tactical configuration or record `TACTICAL_CURRICULUM_FAIL`.

### Phase 6: Combined replication and gate

- [ ] Run two fresh 2,000-game replicas of the selected combined configuration.
- [ ] Evaluate the fixed 250/500/1000/1500/2000 strength curve and final 90-game seat-balanced strong probes.
- [ ] Generate all Phase 4C reports, update takeover state/report, freeze an official config only if the science gate passes, and keep Official stopped while disk is below 100 GiB.
- [ ] Run code review, full tests, secret scan, Git audit, checkpoint audit, and push only bounded source/report commits to `research/invitus`.

## Primary risks

| Risk | Mitigation |
|---|---|
| In-sample calibration looks better without generalizing | Use frozen/held-out sets and label every replay metric as in-sample. |
| Relative values corrupt multiplayer backup | Convert once at leaf inference and keep tree storage absolute; assert round trips and actor-specific selection. |
| Tactical leakage inflates accuracy | Canonical hash manifests and zero-overlap audit before training. |
| A harness bug explains the 0-win result | Deterministic forced-win end-to-end attribution tests before GPU experiments. |
| Bounded experiments fill the 50 GiB disk | Separate clean roots, monitor disk every wave, stop below existing safety thresholds, never start Official. |
| Experimental differences are confounded | Freeze all non-arm settings and save resolved configs/seeds in manifests/checkpoints. |

