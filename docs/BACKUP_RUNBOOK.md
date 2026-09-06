# SRSZQ database backup and recovery runbook

## Current policy

- Production database: `/var/www/SRSZQ/data/srszq.sqlite` in WAL mode.
- Daily backups: `/var/backups/srszq/daily/srszq-daily-*.sqlite`.
- Release backups: `/var/backups/srszq/release-*`.
- Schedule: daily at 03:15 server local time, with up to five minutes of jitter and `Persistent=true`.
- Retention: always keep the seven newest managed daily backups. Older managed daily backups expire after seven days, only after a new backup passes verification.
- Migration, cold, restore-check and release backups are never removed by the daily job.

The backup script uses Node's SQLite online backup API. It includes committed WAL pages, verifies `PRAGMA integrity_check`, writes with mode `0600`, and publishes by atomic rename only after verification.

## Routine operations

```bash
cd /var/www/SRSZQ

# Run and test the backup implementation.
node --test scripts/backup-production-db.test.mjs

# Create one verified online backup without stopping production.
bash scripts/backup-production-db.sh

# Inspect the schedule and recent executions.
systemctl status srszq-backup.timer --no-pager
systemctl status srszq-backup.service --no-pager
journalctl -u srszq-backup.service -n 100 --no-pager

# Trigger the systemd job immediately.
systemctl start srszq-backup.service
```

## Non-destructive restore verification

1. Choose a backup and copy it to a new directory under `/var/backups/srszq/restore-check-*`.
2. Open only the copy. Run `PRAGMA integrity_check`; require exactly `ok`.
3. Confirm the expected tables exist and read representative row counts.
4. Start and roll back a small transaction on the copy to prove it is writable.
5. Leave the production database untouched.

The 2026-09-06 verification used this process successfully: integrity was `ok`, eight tables were present, data was readable, and the temporary copy accepted a rolled-back write transaction.

## Production restore

Use a maintenance window because in-memory matches do not survive a backend restart.

1. Confirm the selected backup passed isolated restore verification.
2. Stop the backend: `pm2 stop srszq-backend`.
3. Confirm neither 8080 nor 8081 is listening.
4. Copy the current `srszq.sqlite`, `srszq.sqlite-wal`, and `srszq.sqlite-shm` together into a new timestamped cold-backup directory.
5. Move the current main database and sidecars into a timestamped archive. Do not combine old WAL/SHM files with a restored main database.
6. Install the verified backup as `/var/www/SRSZQ/data/srszq.sqlite` with owner `root:root` and mode `0600`.
7. Start the backend with `pm2 start ecosystem.config.cjs --update-env`, then run `pm2 save`.
8. Run `node scripts/smoke-production.mjs` and verify login with a known test account.
9. Preserve the pre-restore cold backup until the incident is closed.

Never restore while PM2 is running. Never overwrite production as part of a restore test.

## Disaster recovery limits

Backups currently share the ECS storage failure domain. A complete disaster recovery plan still needs encrypted off-server copies, a retention policy for those copies, and a scheduled restore drill. This remains `MANUAL_HARDENING_PENDING` because no external backup destination has been authorized.
