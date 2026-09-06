#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/var/lock/srszq-backup.lock
flock -n 9 || exit 0
exec node /var/www/SRSZQ/scripts/backup-production-db.mjs
