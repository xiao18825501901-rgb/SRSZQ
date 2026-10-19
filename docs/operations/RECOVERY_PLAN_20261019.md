# SRSZQ production recovery plan

## Phase 1 — diagnose and preserve

- [x] Reproduce the public frontend/API split.
- [x] Identify the expired Hong Kong light server as the outage cause.
- [x] Renew the server and restore access.
- [x] Create an Alibaba disk snapshot before migration.
- [x] Preserve and hash the authoritative SQLite database.

## Phase 2 — isolated Hangzhou candidate

- [x] Deploy the frontend-compatible backend to an isolated directory.
- [x] Run typecheck, unit, API, WebSocket, build and dependency-audit gates.
- [x] Load a copy of the authoritative 381-user database on separate ports.
- [x] Verify migrations, registration, ranking, WSS, AI fill and settlement.
- [x] Preserve the older Hangzhou databases before replacement.

## Phase 3 — production activation

- [x] Freeze Hong Kong writes with zero active games.
- [x] Create and verify the final consistent SQLite backup.
- [x] Transfer it to Hangzhou with matching SHA-256.
- [x] Replace the Hangzhou candidate database atomically.
- [x] Verify Hangzhou readiness and database counts.
- [x] Stop the former Hong Kong application process.
- [x] Relay Hong Kong TLS/API/WSS traffic to Hangzhou with upstream certificate
  verification enabled.
- [x] Save PM2 recovery state.

## Phase 4 — public acceptance

- [x] Verify `/ready`, `/health`, CORS and security headers publicly.
- [x] Verify registration, logout, login and authenticated WebSocket.
- [x] Verify paginated ranking.
- [x] Verify 20-second matchmaking and AI fill.
- [x] Verify timeout and active-resignation settlement.
- [x] Verify Netlify frontend availability.
- [x] Recheck SQLite integrity and zero live games after acceptance.

## Deferred infrastructure gate

- [ ] Remove the Hong Kong TLS-edge dependency only after direct SNI TLS to the
  Hangzhou mainland ECS is permitted or a different compliant edge is ready.
- [ ] Then update the authoritative `api.srszq.com` A record and re-run the
  complete public acceptance suite.

The incident is closed with the Hong Kong relay topology. Direct DNS cutover to
Hangzhou remains intentionally blocked because it would break browser TLS.
