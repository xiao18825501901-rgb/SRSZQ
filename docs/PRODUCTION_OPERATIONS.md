# SRSZQ production operations

## Invariants

- `/var/www/SRSZQ` remains PM2 cwd. Run tsx directly; never use the npm backend workspace as the production entrypoint.
- SQLite remains `/var/www/SRSZQ/data/srszq.sqlite`, with WAL. Only Nginx is public; API/WS stay on loopback 8080/8081.
- Source Git must never track data directories, database sidecars, private keys or production environment files.
- In-memory games do not survive a PM2 restart. Schedule releases outside active matches. Persisted users and sessions must survive.

## Backup and restore

The Node script uses the [official SQLite online backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), not a live copy of the main database file. Completed backups pass `PRAGMA integrity_check`, use mode 0600, and are atomically renamed from a partial filename.

```bash
cd /var/www/SRSZQ
node --test scripts/backup-production-db.test.mjs
bash scripts/backup-production-db.sh
install -m 644 ops/systemd/srszq-backup.service /etc/systemd/system/
install -m 644 ops/systemd/srszq-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now srszq-backup.timer
systemctl start srszq-backup.service
systemctl list-timers srszq-backup.timer
```

Daily backups run at 03:15 server local time with up to five minutes jitter, under `/var/backups/srszq/daily`. The seven newest managed daily backups are always retained; older managed files expire after seven days and only after a new verified backup succeeds. Migration, cold and release backups are never pruned automatically. This is a local-disk backup; off-server disaster recovery remains a future task.

For recovery, first stop PM2 and confirm both loopback listeners have stopped. Preserve the current main/WAL/SHM together in a new cold backup outside the repository. Verify the chosen backup on an isolated copy, then replace the production database while the service remains stopped; archive old sidecars together and do not combine them with a restored main database. Start PM2, check cwd/open DB files, and verify login. Never restore while PM2 is running.

## Release

```bash
cd /var/www/SRSZQ
bash scripts/deploy-production.sh
```

The script fetches a fixed fast-forward target, validates a separate source tree with fresh dependencies, runs types/unit/API/WS/backup/build/audit gates, and verifies dependency symlinks are relocatable. Production remains online during validation. Failed validation exits before changing or restarting production. Use `bash ops/scripts/install-production-ops.sh` after infrastructure configuration changes.

After validation and a verified backup, it briefly stops PM2, fast-forwards tracked source and swaps in the validated dependencies. Previous dependencies remain in a timestamped backup. API and Nginx WS readiness gate success. No database is restored as part of a code rollback.

If activation fails, it restores previous tracked source and dependencies and starts the old configuration. HEAD may still point to the failed target with a deliberate rollback diff; inspect it, commit the rollback as a new commit and push normally. Do not force-push or discard the rollback diff. Validation directories and rollback dependencies are retained for diagnosis; monitor disk usage and archive/remove them only after confirming a release is good.

```bash
node scripts/smoke-production.mjs
# Creates one synthetic QA user and restarts production; use during a maintenance window:
node scripts/smoke-production.mjs --persistence
```

The default smoke reports explicit API, WebSocket, PM2, database and Nginx gates. The persistence smoke uses loopback, keeps random credentials in memory, and never prints tokens or passwords. The QA account remains in the database for evidence.
