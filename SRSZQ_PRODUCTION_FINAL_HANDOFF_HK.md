# SRSZQ Production Final Handoff — Hong Kong

Generated: 2026-09-07 (Asia/Shanghai)

## 1 Executive Status

`STATUS = PARTIALLY_READY / BLOCKED`

The application, database, backup, process manager, loopback Nginx proxy, Netlify fallback, CI, security boundary, and reboot recovery are ready. Final DNS, public API TLS/WSS, and Netlify custom-domain cutover were intentionally not performed because the current ECS expiry could not be confirmed.

`BLOCKED_BY_SERVER_EXPIRY`

The last known expiry supplied for this ECS is `2026-09-13 23:59:59`. The server exposes no expiry value through instance metadata and has no attached RAM role or local Alibaba Cloud credential that can query billing data.

## 2 Final URLs

| URL | State |
| --- | --- |
| `https://srszq.netlify.app` | PASS; rollback frontend remains live |
| `https://srszq.com` | BLOCKED pending expiry gate and DNS |
| `https://www.srszq.com` | BLOCKED pending expiry gate, Netlify domain setup, and redirect |
| `https://api.srszq.com` | BLOCKED pending expiry gate, DNS, and Caddy certificate |
| `wss://api.srszq.com/ws` | BLOCKED publicly; equivalent pre-cutover proxy and authenticated application tests pass |

## 3 Git

- Repository: `xiao18825501901-rgb/SRSZQ`
- Branch: `main`
- Deployed commit: `51e53f7e8360ad484cf1a42b43e47900fd723320`
- Local, origin, and Hong Kong checkout matched and were clean before this report.
- GitHub Actions CI: PASS, run `34050035989`.

## 4 Hong Kong ECS

- Public IP: `8.210.58.22`
- Private IP: `172.19.63.160`
- Region: `cn-hongkong`
- OS: Ubuntu 24.04 LTS, x86_64
- Resources: 2 vCPU, approximately 1.6 GiB visible RAM, 2 GiB swap, 40 GiB disk
- Disk after deployment: approximately 31 GiB free
- Reboot test: completed; captured uptime was under one minute after recovery
- Expiry: unconfirmed; last known value `2026-09-13 23:59:59`

## 5 SSH / sudo

- `admin` public-key SSH: PASS
- Passwordless sudo: PASS
- Separate read-only GitHub ED25519 deploy key: PASS
- Deploy-key fingerprint: `SHA256:auMppqEiDJRfY2aPSvFtOX4sbAAnD9Y/K5OGaj3INdg`
- No private key or credential was copied into Git or this report.
- Effective SSH settings currently permit public keys, password authentication, and root login. Access-policy hardening should be coordinated with every administrator of this shared server.

## 6 PM2

- PM2 7.0.4, application user `admin`
- `srszq-backend`: online
- Working directory: `/var/www/SRSZQ`
- Real Node process opens `/var/www/SRSZQ/data/srszq.sqlite`
- `pm2-admin.service`: enabled and active
- Saved process list resurrected successfully after a real server reboot

## 7 Nginx

- Version: Nginx 1.24.0
- Service: enabled and active
- Config: `/etc/nginx/sites-available/api.srszq.com`
- Listener: `127.0.0.1:9080` only
- `/` proxies to `127.0.0.1:8080`
- `/ws` proxies to `127.0.0.1:8081` with WebSocket upgrade headers and one-hour read/send timeouts
- `nginx -t`: PASS
- Host-header API and WebSocket tests for `api.srszq.com`: PASS

Caddy already serves unrelated CourseMate domains on public ports 80/443. It remains the public edge to prevent an outage. The prepared SRSZQ Caddy block will proxy to Nginx after the expiry and DNS gates pass. Certbot is installed but will not contend for Caddy's public ports.

## 8 DNS

- Authoritative nameservers: `ns1.julydns.com`, `ns2.julydns.com`
- `srszq.com`: no public A answer at verification time
- `www.srszq.com`: no public A answer at verification time
- `api.srszq.com`: no public A answer at verification time
- Required backend record after expiry approval: `api A 8.210.58.22`
- Resolver checks used Cloudflare, Google, and AliDNS.

## 9 HTTPS

- Netlify fallback HTTPS: PASS
- `api.srszq.com` certificate: not issued because DNS cutover is blocked
- Planned issuer: Let's Encrypt through the existing Caddy edge
- HTTP-to-HTTPS redirect and certificate renewal: pending public DNS

## 10 WSS

- Direct loopback application handshake: PASS
- Nginx Host-header upgrade on `127.0.0.1:9080/ws`: PASS
- Unauthenticated rejection reached the WebSocket application: PASS
- Synthetic account authenticated connection received the expected `hello` identity: PASS
- Public `wss://api.srszq.com/ws`: pending DNS and TLS

## 11 Database

- Path: `/var/www/SRSZQ/data/srszq.sqlite`
- Owner/mode: `admin:admin`, `0600`; data directory `0700`
- Journal mode: WAL
- Migration source SHA-256: `8e3ebe835535b19b041d9f1fa673e579a1d36dcffb4ec5110450165e06a4bbce`
- Initial Hong Kong integrity check: `ok`
- Initial table counts exactly matched Hangzhou: users 2, ranking 2, sessions 4; all other business tables 0
- Current counts after two retained synthetic production checks: users 4, ranking 4, sessions 10; friends, games, invitations, matches, and tutorial progress remain 0
- Registration, login, existing session after PM2 restart, and authenticated WSS persistence: PASS

## 12 Backup

- Daily path: `/var/backups/srszq/daily`
- Online SQLite backup includes committed WAL pages
- Integrity check, atomic publish, mode `0600`, and retention of at least seven daily backups are enforced
- `srszq-backup.timer`: enabled and active
- Manual service run: PASS
- Isolated restore/write/rollback test: PASS
- Latest verified post-reboot backup: `/var/backups/srszq/daily/srszq-daily-2026-09-06T17-54-38-730Z-bdd30f11-41c2-422f-9940-e182b5af295a.sqlite`

## 13 Netlify

- Site: `srszq`, ID `8ba9ce96-b7ec-409a-965c-10d6e2335bf2`
- Fallback: `https://srszq.netlify.app`, HTTP 200
- Production deploy: `6a9da8c84d5aaa00098dad75`, ready
- Deployed commit: `51e53f7e8360ad484cf1a42b43e47900fd723320`
- Production bundle contains `api.srszq.com` and contains no active `api.srszq.net`
- Build endpoints: `https://api.srszq.com` and `wss://api.srszq.com/ws`
- Custom domains: not added while the expiry gate is blocked

## 14 CORS

Allowed production origins:

- `https://srszq.com`
- `https://www.srszq.com`
- `https://srszq.netlify.app` during rollback

Allowed origins are reflected with `Vary: Origin`. Untrusted normal requests receive no allow-origin header, and untrusted preflight requests receive HTTP 403. Integration and live checks pass.

## 15 Security

- UFW: active; public inbound rules only for 22, 80, and 443
- External probe: 22/80/443 reachable; 8080/8081/9080 unreachable
- API, WS, and Nginx application proxy bind only to loopback
- Database, WAL, SHM, migration backup, and scheduled backups use mode `0600`
- Git tracked-file and history credential-pattern scans: PASS
- GitHub deploy key is read-only
- PM2 and application run as `admin`, not root
- CORS wildcard removed
- PM2 and SRSZQ Nginx logs rotate daily, retain seven rotations, and compress old logs
- Public TLS is pending the expiry and DNS gates

## 16 Tests

| Gate | Result |
| --- | --- |
| TypeScript typecheck | PASS locally and on Hong Kong |
| Unit tests | PASS, 80/80 |
| API integration | PASS |
| WebSocket integration | PASS |
| Backup tests | PASS, 3/3 |
| Frontend build | PASS |
| `npm audit --audit-level=high` | PASS, 0 vulnerabilities |
| Nginx/API/WS pre-cutover smoke | PASS |
| Synthetic register/login/session | PASS |
| Authenticated WebSocket | PASS |
| Public Netlify bundle | PASS |
| Public final-domain E2E | BLOCKED by expiry/DNS/TLS |

## 17 Reboot Test

`PASS`

After the explicitly approved reboot, SSH, Caddy, both CourseMate services, Nginx, `pm2-admin`, the SRSZQ backend, SQLite, API, WebSocket, and the backup timer recovered automatically. A new verified backup succeeded after reboot.

## 18 Old Server

- Hangzhou ECS `47.114.34.175` remains running as rollback reference.
- Git remains at `6c912272dd7a72cf4b5fd078bb07baa54107d38e`.
- PM2, Nginx, and the backup timer remained active at the latest check.
- Retain for 24–72 hours after public cutover.
- Once Hong Kong receives new public production writes, Hong Kong is the only database source of truth.

### OLD_SERVER_DECOMMISSION_CHECKLIST

- [ ] Complete 24–72 hour Hong Kong observation window
- [ ] Confirm no DNS points to `47.114.34.175`
- [ ] Take and verify a fresh old-server archival backup
- [ ] Archive old configuration and evidence
- [ ] Stop old PM2 application
- [ ] Obtain explicit user approval before ECS cancellation

## 19 ICP

The `srszq.net` ICP workflow may still exist. It is `NOT_REQUIRED_FOR_HK_PRODUCTION`. This migration did not alter, cancel, or fabricate any ICP or public-security filing.

## 20 Remaining Manual User Actions

Immediate required action:

1. Renew the Hong Kong ECS if needed and provide the newly confirmed expiry date. It must safely cover cutover plus the 24–72 hour observation window.

After that gate passes, JulyDNS access is still required to enter `api A 8.210.58.22` and the exact current Netlify apex/`www` records. No DNS-provider credential or authenticated browser session is available to this execution environment, so those entries may require the user to enter them when requested.
