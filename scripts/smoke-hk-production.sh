#!/usr/bin/env bash
set -euo pipefail

expected_ip=${SRSZQ_EXPECTED_IP:-8.210.58.22}
api_host=${SRSZQ_API_HOST:-api.srszq.com}
repo=${SRSZQ_REPO:-/var/www/SRSZQ}
database=${SRSZQ_DB_PATH:-$repo/data/srszq.sqlite}
backup_root=${SRSZQ_BACKUP_ROOT:-/var/backups/srszq/daily}

test "$(getent ahostsv4 "$api_host" | awk 'NR==1 {print $1}')" = "$expected_ip"
echo "DNS PASS: $api_host -> $expected_ip"

curl -fsS --max-time 10 "https://$api_host/api/ranking?limit=1" >/dev/null
echo 'HTTPS/API PASS'

echo | openssl s_client -servername "$api_host" -connect "$api_host:443" 2>/dev/null \
  | openssl x509 -noout -checkend 604800 >/dev/null
echo 'CERTIFICATE PASS: valid for more than seven days'

cd "$repo"
SRSZQ_API_URL="https://$api_host" node scripts/smoke-production.mjs

node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const host = process.env.SRSZQ_API_HOST ?? 'api.srszq.com';
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`wss://${host}/ws`, { handshakeTimeout: 10000 });
  const timer = setTimeout(() => { ws.terminate(); reject(Error('WSS timeout')); }, 12000);
  ws.on('error', (error) => { clearTimeout(timer); reject(error); });
  ws.on('message', (raw) => {
    try {
      assert.equal(JSON.parse(String(raw)).error, 'unauthorized');
      clearTimeout(timer); ws.close(); resolve();
    } catch (error) { clearTimeout(timer); ws.terminate(); reject(error); }
  });
});
NODE
echo 'WSS PASS: public TLS upgrade reached the application'

test "$(sqlite3 "$database" 'PRAGMA integrity_check;')" = ok
echo 'DATABASE PASS: integrity_check=ok'

latest=$(find "$backup_root" -maxdepth 1 -type f -name 'srszq-daily-*.sqlite' -mmin -1560 -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
test -n "$latest"
test "$(stat -c %a "$latest")" = 600
test "$(sqlite3 "$latest" 'PRAGMA integrity_check;')" = ok
echo "BACKUP PASS: fresh verified backup $latest"
