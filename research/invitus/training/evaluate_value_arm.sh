#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 ARM RUN_ROOT SEED [CHECKPOINT_STEPS...]" >&2
  exit 2
fi

ARM=$1
RUN_ROOT=$2
SEED=$3
shift 3
if [ "$#" -eq 0 ]; then
  STEPS=(000250 000500)
else
  STEPS=("$@")
fi
PY=${PYTHON_BIN:-/root/miniconda3/bin/python}
PHASE_ROOT=${PHASE4C_ROOT:-/root/autodl-tmp/invitus-codex/phase4c}
ORACLE=${EXACT_ORACLE:-/root/autodl-tmp/invitus-codex/exact/oracle-200-final.jsonl}
ORACLE_SHA=1a7d79eee017a93f75af566088b61622007411be505e0db4a610aa36c57d1ddc
PROBE=$PHASE_ROOT/fixed-probe-300.jsonl

printf '%s  %s\n' "$ORACLE_SHA" "$ORACLE" | sha256sum --check --status
if [ ! -s "$PROBE" ]; then
  "$PY" -m eval.fixed_probe --generate --positions "$PROBE" --count 300 --seed 20260914
fi

for STEP in "${STEPS[@]}"; do
  NORMAL="$RUN_ROOT/checkpoints/invitus_${STEP}.pt"
  FINAL="$RUN_ROOT/checkpoints/invitus_${STEP}_final.pt"
  if [ -s "$FINAL" ]; then
    CHECKPOINT=$FINAL
  else
    CHECKPOINT=$NORMAL
  fi
  test -s "$CHECKPOINT"
  "$PY" -m eval.calibration \
    --checkpoint "$CHECKPOINT" --replay-dir "$RUN_ROOT/replay" --max-samples 5000 --seed "$SEED" \
    --out "$PHASE_ROOT/calibration-${ARM}-${STEP}.json"
  "$PY" -m eval.fixed_probe \
    --positions "$PROBE" --checkpoint "$CHECKPOINT" --out "$PHASE_ROOT/fixed-${ARM}-${STEP}.json"
  "$PY" -m eval.exact_agree \
    --oracle "$ORACLE" --checkpoint "$CHECKPOINT" --sims 16 --max-positions 200 --seed "$SEED" \
    --out "$PHASE_ROOT/exact-${ARM}-${STEP}.json"
  "$PY" -m eval.strength_probe \
    --checkpoint "$CHECKPOINT" --data-root "$RUN_ROOT" --specs random,3,maxn \
    --games-per-matchup 30 --sims 16 --threads 8 --seed "$SEED" \
    --out "$PHASE_ROOT/strength-${ARM}-${STEP}.json"
done

"$PY" -m training.audit_training_state --root "$RUN_ROOT" --record-kind experiment
