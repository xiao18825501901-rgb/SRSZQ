# Invitus Phase 4C Tactical Dataset Report

## Frozen identities

| Split | Positions | Unique canonicals | SHA-256 | Seed |
|---|---:|---:|---|---:|
| Evaluation | 600 | 600 | `5919969afe5b16fdb7f5fea361fa6655b694cbac906b81f0fd0a63c4e0084dce` | 20260950 |
| Training | 6,000 | 6,000 | `4ef90b5a6a3a1579d5ff6a4bcf1eac9f3d8aa8c258b34f755f6c0bae05fe138d` | 20260951 |

The server artifacts are:

- `/root/autodl-tmp/invitus-codex/phase4c/tactical-eval-600.jsonl`
- `/root/autodl-tmp/invitus-codex/phase4c/tactical-train-6000.jsonl`

Both byte hashes were recomputed after generation and match their manifests. The canonical intersection between the splits is zero. The evaluation split is frozen and must never enter replay or curriculum batches.

## Balance

Each split is exactly balanced over board size and category. The evaluation set contains 50 records in every `boardSize x category` cell, for 300 positions on 13x13 and 300 on 17x17. The training set contains 500 per cell, for 3,000 positions on each board size.

The six categories are:

1. immediate legal win;
2. forced defense against the actual next actor with victory right;
3. victory-right legality, combining a tempting forbidden four with a distinct required legal defense;
4. double immediate threat, with equal target mass over the two moves that reduce the proved threat count;
5. avoid leaving the next actor a proved immediate win;
6. a unique defense against the actor two plies ahead, after the intervening actor receives a move.

## Label proof and target semantics

Every state records its full board, turn, current actor, victory-right owner, formal legal moves, all labelled optimal moves, the canonical key, and a proof descriptor. Generation rejects records whose labels fail a second programmatic verification pass.

Immediate-win labels are proved by applying every winning action through the formal engine and checking the terminal winner. Those 100 evaluation and 1,000 training positions carry an exact absolute outcome and `valueLossMask=1`.

All remaining positions contain bounded tactical knowledge rather than a proved full-game outcome. They therefore carry no value target and use `valueLossMask=0`. Their policy targets divide probability equally across every action tied under the stated proof. This avoids inventing a win label and avoids selecting an arbitrary one-hot action when multiple moves are equivalent.

The double-threat and two-ply categories are bounded tactical objectives, not claims of game-theoretic optimality. The double-threat label minimizes the formally proved immediate winning cells available to the next eligible actor. The two-ply label occupies the unique winning cell of the actor two plies ahead; because placement is monotone, the intervening opponent cannot create a new line for that threatened actor, and an adversarial reply can leave any unoccupied threat intact.

## Legality and leakage gates

Generated states have the exact per-seat stone counts implied by the recorded turn, contain no already completed four, retain `playing` status, and expose at least one legal move. Canonicalization includes the D4-normalized board, full turn, status, and winner. Tests cover deterministic generation, board/category balance, proof replay, equal optimal-action mass, value masking, manifest byte hashes, and zero train/evaluation overlap.

The datasets are external experiment artifacts and are not committed to Git. Generator, verifier, curriculum adapter, and tests are versioned on `research/invitus`.

## Gate

`TACTICAL_EVAL_PIPELINE=PASS`

`TACTICAL_DATASET_LEAKAGE=0`

The remaining gate is empirical: T0/T10/T20 must measure raw held-out policy accuracy and full match strength without training on the frozen evaluation split.
