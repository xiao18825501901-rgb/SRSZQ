#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=${SRSZQ_REPO:-/var/www/SRSZQ}
backup_root=${SRSZQ_BACKUP_ROOT:-/var/backups/srszq}
nginx_target=/etc/nginx/sites-available/api.srszq.com
nginx_backup="$backup_root/nginx/api.srszq.com-$(date -u +%Y%m%dT%H%M%SZ).conf"

test "$(id -u)" -eq 0
test -f "$repo/ops/nginx/api.srszq.com.conf"
test -f "$repo/ops/systemd/srszq-backup.service"

install -d -m 700 "$(dirname "$nginx_backup")"
if test -f "$nginx_target"; then
  cp --preserve=mode,ownership,timestamps "$nginx_target" "$nginx_backup"
fi

install -m 644 "$repo/ops/nginx/api.srszq.com.conf" "$nginx_target"
install -d -m 750 -o root -g adm /var/log/srszq
rm -f /etc/nginx/sites-enabled/default
ln -sfn "$nginx_target" /etc/nginx/sites-enabled/api.srszq.com
nginx -t
systemctl unmask nginx
systemctl enable --now nginx

install -d -m 700 "$backup_root/daily"
install -m 644 "$repo/ops/systemd/srszq-backup.service" /etc/systemd/system/srszq-backup.service
install -m 644 "$repo/ops/systemd/srszq-backup.timer" /etc/systemd/system/srszq-backup.timer
install -m 644 "$repo/ops/logrotate/srszq-pm2" /etc/logrotate.d/srszq-pm2
install -m 644 "$repo/ops/logrotate/srszq-nginx" /etc/logrotate.d/srszq-nginx
systemctl daemon-reload
systemctl enable --now srszq-backup.timer
logrotate --debug /etc/logrotate.d/srszq-pm2 >/dev/null
logrotate --debug /etc/logrotate.d/srszq-nginx >/dev/null
find "$repo/data" -maxdepth 1 -type f -name 'srszq.sqlite*' -exec chmod 600 {} +

echo "HK OPS INSTALL PASS: Nginx backup=$nginx_backup"
