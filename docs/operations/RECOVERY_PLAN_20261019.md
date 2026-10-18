# SRSZQ production recovery plan

## Phase 1 — diagnose and preserve

- [x] Reproduce the public frontend/API split.
- [x] Check DNS and the old host's SSH/HTTP/HTTPS ports.
- [x] Inventory Hangzhou services and databases without modifying them.
- [x] Verify the best available migration snapshot.

## Phase 2 — isolated recovery candidate

- [x] Deploy the frontend-compatible backend source to an isolated directory.
- [x] Use a copy of the migration snapshot.
- [x] Run typecheck, unit, API, WebSocket, build and audit gates.
- [x] Verify registration, login, quick account and a real match start.
- [x] Prepare an HTTP virtual host without changing DNS or TLS.

## Phase 3 — authoritative-state decision

- [ ] Inspect the old ECS state through Alibaba Cloud.
- [ ] Recover and verify its newest SQLite state, or record that it is
  irrecoverable and select the preserved migration snapshot.
- [ ] Confirm `quick_check=ok`, table counts and a frozen SHA-256 before
  accepting public writes.

## Phase 4 — cutover and acceptance

- [ ] Update the `api.srszq.com` A record.
- [ ] Issue and verify the TLS certificate.
- [ ] Verify `/ready`, `/api/version`, CORS and security headers publicly.
- [ ] Verify registration, login and quick account in a real browser.
- [ ] Verify WebSocket tickets, 20-second matchmaking and an online game.
- [ ] Observe logs and database integrity after cutover.

Completion requires all Phase 4 checks through the real public domain. The
isolated recovery candidate alone does not close the incident.
