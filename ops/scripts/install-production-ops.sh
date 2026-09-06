#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=${SRSZQ_REPO:-/var/www/SRSZQ}
backup_root=${SRSZQ_BACKUP_ROOT:-/var/backups/srszq}
nginx_target=/etc/nginx/sites-available/srszq-api
nginx_backup="$backup_root/nginx/srszq-api-$(date -u +%Y%m%dT%H%M%SZ).conf"

test "$(id -u)" -eq 0
test -f "$repo/ops/nginx/srszq-ip-fallback.conf"

install -d -m 700 "$(dirname "$nginx_backup")"
if test -f "$nginx_target"; then
  cp --preserve=mode,ownership,timestamps "$nginx_target" "$nginx_backup"
fi

install -m 644 "$repo/ops/nginx/srszq-ip-fallback.conf" "$nginx_target"
if ! nginx -t; then
  if test -f "$nginx_backup"; then cp "$nginx_backup" "$nginx_target"; fi
  nginx -t
  echo 'Nginx validation failed; the previous configuration was restored.' >&2
  exit 1
fi
systemctl reload nginx

install -m 644 "$repo/ops/systemd/srszq-backup.service" /etc/systemd/system/srszq-backup.service
install -m 644 "$repo/ops/systemd/srszq-backup.timer" /etc/systemd/system/srszq-backup.timer
install -m 644 "$repo/ops/logrotate/srszq-pm2" /etc/logrotate.d/srszq-pm2
systemctl daemon-reload
systemctl enable --now srszq-backup.timer
logrotate --debug /etc/logrotate.d/srszq-pm2 >/dev/null
find "$repo/data" -maxdepth 1 -type f -name 'srszq.sqlite*' -exec chmod 600 {} +
pm2 save
systemctl enable --now pm2-root

echo "OPS INSTALL PASS: Nginx backup=$nginx_backup"
