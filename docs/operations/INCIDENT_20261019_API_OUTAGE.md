# SRSZQ API outage — 2026-10-19

## Final status

**RESOLVED.** `https://srszq.com`, account registration, login, ranking,
WebSocket authentication, 20-second matchmaking, AI fill, timeout settlement
and active resignation all pass through the real production domain.

## Root cause

- `api.srszq.com` resolved to the Hong Kong light server `8.210.58.22`.
- That server expired at `2026-10-13 23:59:59 +08:00`; SSH, HTTP and HTTPS
  were unavailable while it was expired.
- The Netlify frontend remained healthy and continued targeting
  `https://api.srszq.com` / `wss://api.srszq.com/ws`.

The outage was at the backend host boundary, not in the account UI.

## Recovery and data preservation

- The Hong Kong server was renewed by the owner and returned online.
- Alibaba snapshot `s-j6c6jtq0jh6ijkxlal5o` was created as
  `SRSZQ-HK-pre-recovery-20261019` before migration.
- The authoritative SQLite database passed `quick_check` and contained:
  - users: 381
  - games: 113
  - matches: 113
  - sessions: 390
  - ranking rows: 366
  - product events: 248
- Final frozen backup:
  `/home/admin/srszq-final-cutover-20261019T103134Z.sqlite`
- Final frozen backup SHA-256:
  `2dfacbcb94177e3607a65674f2994b1a28ed256eafac9454a384bb649e45ea4e`
- The backup was copied to Hangzhou, hash-matched, opened read-only, and passed
  SQLite `quick_check` before activation.

No 140-user fallback snapshot was promoted over the newer production state.

## Production topology

- Public DNS remains `api.srszq.com -> 8.210.58.22`.
- Hong Kong terminates public TLS with Caddy, then Nginx relays API and
  WebSocket traffic to Hangzhou.
- Hangzhou backend:
  - host: `47.114.34.175`
  - release: `/var/www/SRSZQ-recovery-ba75b2c-20261019`
  - PM2 process: `srszq-recovery`
  - API: `127.0.0.1:18080`
  - WebSocket: `127.0.0.1:18081`
- The former Hong Kong `srszq-backend` PM2 process is stopped and preserved for
  rollback.

Direct public TLS with SNI to the Hangzhou mainland ECS is reset upstream, so
the paused `api -> 47.114.34.175` DNS record remains disabled. The Hong Kong
edge is required until the mainland-domain/TLS gate is resolved or a different
compliant edge is selected.

## Verification

- Production database integrity: `quick_check=ok`.
- Public `/ready` and `/health`: pass.
- Public CORS preflight from `https://srszq.com`: HTTP 204 with the correct
  `Access-Control-Allow-Origin`.
- Registration, logout, login and authenticated WSS hello: pass.
- Paginated ranking: pass.
- 20-second matchmaking and 1-human + 2-AI `game.start`: pass.
- 30-second turn timeout settlement: pass.
- Active leave to `PLAYER_FORFEIT`: pass.
- Nginx configuration on both servers: pass.
- Hong Kong-to-Hangzhou upstream certificate verification: enabled and pass.
- Frontend `https://srszq.com`: HTTP 200 from Netlify.

The acceptance run added four clearly synthetic QA users and two QA games.
Post-test production counts were 385 users, 115 games and 115 matches, with
zero live games.

## Rollback

Rollback assets are preserved on both hosts. To revert, restore the saved Hong
Kong Nginx site file, reload Nginx, and start `srszq-backend`. The frozen Hong
Kong database and Hangzhou pre-swap database copies remain available. Do not
change DNS during this rollback; public DNS already points to Hong Kong.
