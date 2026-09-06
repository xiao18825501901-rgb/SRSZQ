# Old server pre-migration snapshot

Captured on 2026-09-07 at approximately 01:13 China Standard Time from `47.114.34.175`.

| Check | Result |
| --- | --- |
| Git | `main`, clean, `6c912272dd7a72cf4b5fd078bb07baa54107d38e` |
| PM2 | `srszq-backend` online; `pm2-root` enabled and active |
| Nginx | enabled and active |
| API / WS | production smoke passed |
| SQLite | WAL mode; `PRAGMA integrity_check` returned `ok` |
| Backup timer | enabled and active |
| Latest scheduled backup | `/var/backups/srszq/daily/srszq-daily-2026-09-06T13-24-14-034Z-5512e8d3-1461-426e-b09b-3095ed219d00.sqlite` |
| Disk | 40 GB total, approximately 34 GB free |

## Business table row counts

| Table | Rows |
| --- | ---: |
| friends | 0 |
| games | 0 |
| invitations | 0 |
| matches | 0 |
| ranking | 2 |
| sessions | 4 |
| tutorial_progress | 0 |
| users | 2 |

## Final migration backup

- Path: `/var/backups/srszq/final-migration/srszq-daily-2026-09-06T17-21-36-605Z-f6bb6238-c3eb-4aa0-806b-b93bc8da5df1.sqlite`
- Size: 77,824 bytes
- SHA-256: `8e3ebe835535b19b041d9f1fa673e579a1d36dcffb4ec5110450165e06a4bbce`
- Mode: `0600`, owner `root:root`
- Validation: integrity `ok`; isolated write and rollback test passed; all table counts matched this snapshot.
