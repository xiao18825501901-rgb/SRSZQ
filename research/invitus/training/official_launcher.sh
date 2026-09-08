#!/usr/bin/env bash
# official_launcher.sh — bounded segment runner for Invitus official training.
#
# usage: official_launcher.sh DATA_ROOT SEGMENT_EPISODES [extra official.py args...]
#
# - refuses to start when free space on DATA_ROOT < MIN_FREE_GIB (frozen gate)
# - runs `python3 -m training.official --episodes SEGMENT --resume latest` from /root/SRSZQ/research/invitus
# - retries transient failures up to MAX_RESTARTS with BACKOFF seconds between attempts
# - never restarts when logs/STOP exists (graceful stop intent) or after MAX_RESTARTS
# exit codes: 0=segment complete, 1=segment failed after retries, 2=stopped by STOP file, 3=BLOCKED_BY_STORAGE
set -u

DATA_ROOT="${1:?usage: official_launcher.sh DATA_ROOT SEGMENT_EPISODES [extra args...]}"
SEGMENT="${2:?usage: official_launcher.sh DATA_ROOT SEGMENT_EPISODES [extra args...]}"
shift 2

REPO=/root/SRSZQ/research/invitus
MIN_FREE_GIB=100
MAX_RESTARTS=5
BACKOFF_SECONDS=60
LOG="${DATA_ROOT}/logs/launcher.log"
mkdir -p "${DATA_ROOT}/logs"

log() { echo "[$(date -u +%FT%TZ)] $*" >> "${LOG}"; }

free_gib() {
  df -BG --output=avail "${DATA_ROOT}" | tail -n 1 | tr -dc '0-9'
}

for attempt in $(seq 1 $((MAX_RESTARTS + 1))); do
  FREE=$(free_gib)
  if [ "${FREE}" -lt "${MIN_FREE_GIB}" ]; then
    log "DISK_GATE_FAIL free=${FREE}GiB required=${MIN_FREE_GIB}GiB — BLOCKED_BY_STORAGE, refusing segment attempt ${attempt}"
    echo "BLOCKED_BY_STORAGE free=${FREE}GiB required=${MIN_FREE_GIB}GiB"
    exit 3
  fi
  log "segment attempt ${attempt}/$((MAX_RESTARTS + 1)) start (target ${SEGMENT} episodes, args: $*)"
  (cd "${REPO}" && PYTHONUNBUFFERED=1 python3 -m training.official --episodes "${SEGMENT}" --data-root "${DATA_ROOT}" --resume latest "$@")
  RC=$?
  if [ "${RC}" -eq 0 ]; then
    log "segment attempt ${attempt} completed rc=0"
    echo "SEGMENT_OK"
    exit 0
  fi
  if [ -f "${DATA_ROOT}/logs/STOP" ]; then
    log "STOP file present after rc=${RC} — honoring stop, not restarting"
    echo "STOPPED_BY_STOP_FILE rc=${RC}"
    exit 2
  fi
  if [ "${attempt}" -gt "${MAX_RESTARTS}" ]; then
    log "MAX_RESTARTS reached after rc=${RC} — leaving for manual investigation"
    echo "SEGMENT_FAILED rc=${RC} attempts=${attempt}"
    exit 1
  fi
  log "segment failed rc=${RC} — backoff ${BACKOFF_SECONDS}s before restart $((attempt + 1))"
  sleep "${BACKOFF_SECONDS}"
done
