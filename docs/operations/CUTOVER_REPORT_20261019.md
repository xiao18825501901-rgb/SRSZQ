# SRSZQ production cutover report — 2026-10-19

## Outcome

The production backend and authoritative database now run on the Hangzhou ECS.
The renewed Hong Kong light server remains a TLS edge and rollback anchor.
Public DNS was deliberately not changed because SNI TLS to the mainland ECS is
reset before Nginx receives the request.

## Authoritative artifacts

| Artifact | Location | Verification |
| --- | --- | --- |
| Alibaba disk snapshot | `s-j6c6jtq0jh6ijkxlal5o` | Complete |
| Frozen Hong Kong DB | `/home/admin/srszq-final-cutover-20261019T103134Z.sqlite` | `quick_check=ok` |
| Frozen DB SHA-256 | `2dfacbcb94177e3607a65674f2994b1a28ed256eafac9454a384bb649e45ea4e` | Matched on Hangzhou |
| Hangzhou cutover archive | `/root/srszq-cutover-20261019` | Contains pre-swap and final copies |
| Hangzhou live DB | `/var/www/SRSZQ-recovery-ba75b2c-20261019/data/srszq.sqlite` | `quick_check=ok` |

## Final services

| Layer | Host/process | State |
| --- | --- | --- |
| Public TLS | Hong Kong Caddy | Active |
| Public API/WSS relay | Hong Kong Nginx `127.0.0.1:9080` | Active |
| Former HK application | PM2 `srszq-backend` | Stopped, rollback-ready |
| Production application | Hangzhou PM2 `srszq-recovery` | Online |
| Production API/WSS | `127.0.0.1:18080` / `127.0.0.1:18081` | Ready |

## Acceptance evidence

- Public registration and tutorial completion passed.
- Public logout followed by password login passed.
- Authenticated WebSocket hello passed.
- Ranking pagination passed.
- Matchmaking emitted `game.start` after the configured 20-second deadline
  with one human and two AI seats.
- Turn timeout produced `TIMEOUT` settlement.
- Active leave produced `PLAYER_FORFEIT` settlement.
- Post-test database: 385 users, 115 games, 115 matches, 370 ranking rows,
  256 product events and zero live games.

## Rollback entry

1. Restore
   `/home/admin/srszq-api.nginx.before-relay-20261019T103218Z` to
   `/etc/nginx/sites-enabled/api.srszq.com` on Hong Kong. This saved file was
   rechecked and points API/WSS to the local `127.0.0.1:8080/8081` processes.
2. Validate and reload Nginx.
3. Start PM2 process `srszq-backend` on Hong Kong.
4. Confirm public `/ready` reports backend source
   `1878587c36121ef5805b67d6fb06c1a8aa5d69cc`.

The frozen source database remains intact, so rollback does not require a DNS
change.
