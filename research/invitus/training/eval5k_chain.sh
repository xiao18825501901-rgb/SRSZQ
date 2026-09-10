#!/usr/bin/env bash
# 5K milestone evaluation chain (sequential; evaluation games are formal=false)
set -u
cd /root/SRSZQ/research/invitus
ROOT=/root/autodl-tmp/invitus/official
EVAL=$ROOT/evaluations
mkdir -p $EVAL
MAJOR=$ROOT/checkpoints/invitus_005000_major.pt
P=/root/miniconda3/bin/python
run(){ echo "=== $* @ $(date -u +%FT%TZ) ==="; "$@"; echo "rc=$?"; }

run $P -m eval.champion_gate --candidate $MAJOR --data-root $ROOT --games-per-matchup 300 --sims 16 --threads 8 --promote
run $P -m eval.search_scaling --checkpoint $MAJOR --data-root $ROOT --sims-levels 16,24,32 --games-per-matchup 300 --threads 8 --out $EVAL/search_scaling_5k.json
run $P -m eval.exact_oracle --replay-dir $ROOT/replay --out $EVAL/oracle_5k.jsonl --max-positions 200 --per-game-tail 4
run $P -m eval.exact_agree --oracle $EVAL/oracle_5k.jsonl --checkpoint $MAJOR --out $EVAL/agree_5k_s16.json --sims 16
run $P -m eval.exact_agree --oracle $EVAL/oracle_5k.jsonl --checkpoint $MAJOR --out $EVAL/agree_5k_s24.json --sims 24
run $P -m eval.exact_agree --oracle $EVAL/oracle_5k.jsonl --checkpoint $MAJOR --out $EVAL/agree_5k_s32.json --sims 32
run $P -m eval.diversity_probe --checkpoint $MAJOR --data-root $ROOT --games 120 --sims 16 --threads 8 --out $EVAL/diversity_5k.json
run $P -m eval.calibration --checkpoint $MAJOR --replay-dir $ROOT/replay --out $EVAL/calibration_5k.json --max-samples 5000
echo "EVAL_CHAIN_DONE $(date -u +%FT%TZ)"
