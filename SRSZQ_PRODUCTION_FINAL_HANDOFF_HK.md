# SRSZQ Production Final Handoff — Hong Kong

Generated: 2026-09-07 (Asia/Shanghai)

## 1. Executive status

`STATUS = READY`

SRSZQ is publicly functional on its final domains. DNS, Netlify custom domains, HTTPS, Caddy routing, authenticated WSS, CORS, browser E2E, game lifecycle, persistence, backup, CI, and the public port boundary all pass.

The Hong Kong ECS expiry is recorded as an accepted operational risk and is not a launch blocker.

## 2. Final production URLs

| URL | Result |
| --- | --- |
| `https://srszq.com` | PASS — canonical frontend, HTTP 200 |
| `https://www.srszq.com` | PASS — HTTP 301 to `https://srszq.com/` |
| `https://api.srszq.com` | PASS — public API edge |
| `wss://api.srszq.com/ws` | PASS — authenticated application WebSocket |
| `https://srszq.netlify.app` | PASS — retained frontend rollback URL |

## 3. Production architecture

```text
Internet
  -> Netlify: srszq.com / www.srszq.com
  -> Caddy 80/443: api.srszq.com
  -> Nginx 127.0.0.1:9080
  -> API 127.0.0.1:8080
  -> WebSocket 127.0.0.1:8081/ws
```

Caddy remains the shared public TLS edge. Nginx remains loopback-only and does not compete for ports 80 or 443.

## 4. Git, CI, and deployment identity

- Repository: `xiao18825501901-rgb/SRSZQ`
- Branch: `main`
- Tested executable commit: `1163297e5fe1017e4e4ac2a7442fad62690c227b`
- Local, origin, and Hong Kong checkout matched this commit and were clean before this handoff report was written.
- GitHub Actions CI: PASS
- CI run: `34052885765`
- CI conclusion: `success`
- Netlify production deploy: `6a9db57cb662e40008dea4ca`
- Netlify deploy state: `ready`
- Netlify deployed commit: `1163297e5fe1017e4e4ac2a7442fad62690c227b`
- The final handoff commit after the tested commit changes documentation only.

## 5. DNS

Authoritative nameservers remain `ns1.julydns.com` and `ns2.julydns.com`.

Cloudflare (`1.1.1.1`), Google (`8.8.8.8`), and AliDNS (`223.5.5.5`) all returned:

- `srszq.com A 75.2.60.5`
- `www.srszq.com CNAME srszq.netlify.app`
- `api.srszq.com A 8.210.58.22`

## 6. HTTPS and redirects

### Frontend certificate

- Subject: `CN=srszq.com`
- SAN: `srszq.com`, `www.srszq.com`
- Issuer: Let's Encrypt `YE2`
- Valid from: `2026-09-06T17:24:24Z`
- Valid until: `2026-12-05T17:24:23Z`
- HSTS: enabled by Netlify

### API certificate

- Subject/SAN: `api.srszq.com`
- Issuer: Let's Encrypt `YE1`
- Valid from: `2026-09-06T17:20:25Z`
- Valid until: `2026-12-05T17:20:24Z`
- Renewal: managed automatically by Caddy

Redirect checks:

- `https://www.srszq.com/` -> HTTP 301 -> `https://srszq.com/`
- `http://api.srszq.com/` -> HTTP 308 -> `https://api.srszq.com/`

## 7. Public application and WebSocket E2E

The platform browser test ran against the public frontend, API, and WSS endpoints. It passed:

- landing page and authentication
- registration and session refresh
- tutorial gate and tutorial AI response
- lobby, ranking, and friend invitation
- two-browser friend acceptance and automatic game entry
- 13x13 local and online boards
- Human vs AI and AI fill
- BAC timeline synchronization through Round 6
- online matchmaking UI
- public client console with zero JavaScript errors

The production rules browser test passed:

- 13x13 and 17x17 boards
- BAC R1 victory lock
- BAC R6 C victory right
- forbidden four-in-a-row for a non-eligible player
- eligible C victory
- 0–2 AI seat enforcement and hidden AI levels
- AI thinking lock and automatic move
- undo to the previous human turn
- v2 and legacy import plus export
- zero JavaScript errors

The public game lifecycle test used three fresh QA users over `wss://api.srszq.com/ws` and passed:

- authenticated `hello` identity
- three-human online game start
- disconnect notification
- reconnect and `resume` within the production grace period
- no false disconnect loss after the original grace deadline
- `PLAYER_RESIGN` -> `PLAYER_FORFEIT` for all clients
- disconnect timeout -> `PLAYER_DISCONNECT`
- both results persisted to the public ranking

## 8. Hong Kong ECS and shared services

- Public IP: `8.210.58.22`
- Region: `cn-hongkong`
- OS: Ubuntu 24.04 LTS, x86_64
- SSH as `admin`: PASS
- Passwordless sudo: PASS
- `srszq-backend`: online under PM2 user `admin`
- PM2 startup service: enabled and active
- Application working directory: `/var/www/SRSZQ`
- Production database: `/var/www/SRSZQ/data/srszq.sqlite`
- Nginx config validation: PASS
- Caddy config validation and reload: PASS
- `coursemate-rag.service`: active and enabled; public `/docs` returned 200
- `coursemate-agent.service`: active and enabled; public route returned its expected application 404
- Previously completed full reboot recovery test: PASS; it was not repeated because the final cutover used a validated Caddy reload and did not change boot dependencies.

## 9. Database and persistence

- SQLite integrity check: `ok`
- Journal mode: WAL
- Data directory: mode `0700`, owner `admin:admin`
- Database: mode `0600`, owner `admin:admin`
- PM2 restart persistence test: PASS
- Existing authenticated session after PM2 restart: PASS
- Authenticated WSS after PM2 restart: PASS

Final table counts after retained synthetic production tests:

| Table | Rows |
| --- | ---: |
| users | 13 |
| ranking | 13 |
| sessions | 24 |
| friends | 4 |
| games | 2 |
| invitations | 2 |
| matches | 2 |
| tutorial_progress | 0 |

These counts include QA users and the two deliberately persisted public lifecycle matches.

## 10. Backups

- Timer: `srszq-backup.timer`, active and enabled
- Online SQLite backup includes committed WAL pages
- Integrity check, atomic publication, retention, and mode `0600` are enforced
- Isolated restore/write/rollback test: PASS
- Fresh post-E2E backup: `/var/backups/srszq/daily/srszq-daily-2026-09-06T18-52-05-075Z-e151e80d-1ef9-4011-8f87-b4936bc7f5f2.sqlite`
- Backup owner/mode: `root:root`, `0600`

## 11. CORS and security boundary

Allowed frontend origins:

- `https://srszq.com`
- `https://www.srszq.com`
- `https://srszq.netlify.app` for rollback

The canonical origin preflight returned HTTP 204 and the exact `Access-Control-Allow-Origin`. An untrusted preflight returned HTTP 403 without an allow-origin header.

External TCP probes:

| Port | Expected | Result |
| --- | --- | --- |
| 22 | public | PASS — reachable |
| 80 | public | PASS — reachable |
| 443 | public | PASS — reachable |
| 8080 | private | PASS — unreachable publicly |
| 8081 | private | PASS — unreachable publicly |
| 9080 | private | PASS — unreachable publicly |

Additional controls:

- UFW active
- API, WebSocket, and Nginx application proxy bind only to loopback
- Git tracked-file and history credential-pattern scan: PASS
- GitHub deploy key is read-only
- Application and PM2 run as `admin`, not root
- Database and completed backups use mode `0600`
- CORS wildcard is absent
- Security response headers are active

## 12. Verification matrix

| Gate | Result |
| --- | --- |
| TypeScript typecheck | PASS |
| Unit tests | PASS — 80/80 |
| Backend API integration | PASS |
| WebSocket integration | PASS |
| Frontend production build | PASS |
| `npm audit --audit-level=high` | PASS — 0 vulnerabilities |
| GitHub Actions CI | PASS |
| Netlify production deploy | PASS — ready |
| Public platform browser E2E | PASS |
| Public rules browser E2E | PASS |
| Public disconnect/reconnect/forfeit lifecycle | PASS |
| Public API/WSS and persistence smoke | PASS |
| Fresh production backup | PASS |
| CourseMate regression check | PASS |

## 13. Old Hangzhou server and rollback

- Hangzhou ECS `47.114.34.175` remains available as a rollback reference.
- It was not deleted, cancelled, or used to overwrite the Hong Kong database.
- The Hong Kong database is the production source of truth after public writes began.
- Keep the old server for the planned 24–72 hour observation window.

Before any later decommission:

- confirm no DNS points to `47.114.34.175`
- take and verify an archival backup
- archive old configuration and evidence
- stop the old application only after the observation window
- obtain explicit approval before ECS cancellation

## 14. ICP

The separate `srszq.net` ICP workflow was not changed or cancelled.

`ICP_NOT_REQUIRED_FOR_CURRENT_HK_HOSTING`

## 15. Operational risk

The Hong Kong ECS last-known expiry was `2026-09-13 23:59:59`.

The user explicitly instructed production cutover to proceed regardless of renewal status and accepted the risk that the Hong Kong ECS may expire shortly after launch.

Risk: if the ECS expires, the backend API and WSS service will go offline while the Netlify frontend may remain reachable.

Mitigation recommendation: renew the ECS before expiration.

`RISK_ACCEPTED_BY_USER`

This risk does not block the READY status.

## 16. Remaining actions

No manual action remains for the production launch. Continue monitoring during the 24–72 hour observation window and renew the Hong Kong ECS as the recorded risk mitigation.
