# SRSZQ API outage — 2026-10-19

## Impact

`https://srszq.com` continues to load from Netlify, but account creation,
login, quick account, matchmaking and online games fail because the production
API and WebSocket origin are unavailable.

## Confirmed root cause

- `api.srszq.com` resolves to the former Hong Kong host `8.210.58.22`.
- TCP ports 22, 80 and 443 on that host all time out.
- Requests to `https://api.srszq.com` time out before an HTTP response.
- The current frontend bundle was built from
  `1878587c36121ef5805b67d6fb06c1a8aa5d69cc` and still targets
  `https://api.srszq.com` / `wss://api.srszq.com/ws`.

The failure is therefore at the production backend host/DNS boundary, not in
the account form or interaction-polish UI.

## Data findings

- The unreachable Hong Kong host cannot currently be read or frozen.
- The available Hangzhou migration snapshot passes SQLite `quick_check` and
  contains 140 users and 30 games.
- The older Hangzhou live instance contains only 2 users and 0 games.
- The Hangzhou snapshot predates later production evidence, so switching it to
  public writes without first checking the old ECS would create a recovery
  point objective gap and possible split-brain history.

No existing database was overwritten or deleted.

## Recovery environment prepared

- Host: Hangzhou `47.114.34.175`
- Source commit: `ba75b2c0deb11ac24ea6fee496ad34aed1a30bc2`
- Source archive SHA-256:
  `1ea8dec3d68568f4bb3bd91f92dd1d7e79de89f0bfd681e3abc2885c1d5d47c3`
- Release directory:
  `/var/www/SRSZQ-recovery-ba75b2c-20261019`
- PM2 process: `srszq-recovery`
- Loopback API/WS: `127.0.0.1:18080` / `127.0.0.1:18081`
- HTTP virtual host for `api.srszq.com` is prepared on port 80 and proxies to
  the recovery ports.

The recovery database is an independent copy of the 140-user migration
snapshot. Startup migrations and synthetic checks affected only this copy.

## Verification completed

- Typecheck: pass.
- Unit tests: 19 files / 169 tests pass.
- Backend API integration: pass.
- WebSocket integration: pass.
- Frontend production build: pass.
- Production dependency audit: 0 vulnerabilities.
- Runtime `/ready`: all checks pass, including migrations, writable rollback
  transaction and AI worker warm-up.
- Runtime flow: registration, login, quick-account cookie, WebSocket ticket,
  20-second queue and `game.start` all pass.
- External request pinned to the Hangzhou IP with Host `api.srszq.com` returns
  HTTP 200 from `/ready`.

## Remaining gates

1. Inspect the old ECS in Alibaba Cloud. If it can be restarted or its disk can
   be recovered, create a final SQLite backup and use that newer state.
2. If the old state is irrecoverable, explicitly accept the 140-user snapshot
   as the recovery point before public writes begin.
3. Change only the `api.srszq.com` A record to `47.114.34.175`.
4. Issue the TLS certificate on Hangzhou and enable the 443 virtual host.
5. Run public register, login, quick account, WebSocket ticket, matchmaking and
   online-game acceptance checks through the real domain.

## Rollback

Before public cutover, rollback is simply removing the prepared HTTP virtual
host and stopping `srszq-recovery`; no public traffic or authoritative data is
affected. After cutover, revert the A record only if the previous backend is
confirmed reachable and authoritative. Preserve the recovery database and all
pre-cutover backups in either case.
