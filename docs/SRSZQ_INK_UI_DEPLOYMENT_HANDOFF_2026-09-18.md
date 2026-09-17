# SRSZQ Ink UI + W10 Production Deployment Handoff — 2026-09-18

## 1. Executive status

`STATUS = DEPLOYED & VERIFIED`

The "Ink" frontend redesign, the 30-second online turn clock, the W10 matchmaking
recovery, and the leaderboard pagination were released to production on
2026-09-18 (Asia/Shanghai) without a database migration and without touching the
proven Netlify + Caddy/Nginx edge architecture.

## 2. Released commits

| Commit | Content |
| --- | --- |
| `f143bc8` | feat(ui): ink redesign + 30s online clock + W10 matchmaking recovery (main release) |
| `25fc09e` | fix(build): track frontend hero-game data swallowed by `data/` ignore rule |
| `40a4769` | chore: keep `frontend/src/data` trackable in `.gitignore` |
| `72b4acd` | fix(ws): 25s protocol heartbeat to survive idle-killing middleboxes |

`f143bc8` alone failed CI/Netlify typecheck because the new landing-page hero
replay file `frontend/src/data/heroGame.ts` sat under a path matched by the
existing `data/` gitignore rule (runtime databases). `25fc09e` tracked the file
and `40a4769` added the gitignore negation; CI is green on both and Netlify
published `40a4769` as production.

## 3. Deployment targets

- Frontend: Netlify site `srszq` (Git-connected to `xiao18825501901-rgb/SRSZQ`,
  auto-publish on push). Production deploy for `40a4769` = `ready`.
- Backend: Alibaba Cloud HK ECS `8.210.58.22`, `/var/www/SRSZQ` at `40a4769`,
  PM2 `srszq-backend` (user `admin`), started from the updated
  `ecosystem.config.cjs` which now pins `SRSZQ_TURN_TIMEOUT_MS=30000` explicitly.
- Edge: unchanged — Caddy terminates public TLS for `api.srszq.com` and forwards
  to loopback Nginx `127.0.0.1:9080` → API `8080` / WS `8081`.

## 4. Verification matrix (2026-09-18)

| Gate | Result |
| --- | --- |
| Local QA gate (npm ci, typecheck, 149 unit tests, API, WS integration, build) | PASS |
| GitHub Actions CI on `25fc09e` and `40a4769` (typecheck, unit, API, WS, backup, build, audit) | PASS |
| Netlify production build + publish of `40a4769` | PASS — ready |
| Live `https://srszq.com` serves new UI (`<title>三人四子棋</title>`, ink CSS) | PASS |
| Live bundle points to `https://api.srszq.com` / `wss://api.srszq.com/ws` (0 localhost refs) | PASS |
| Public register + tutorial completion + ranking pagination (158 users, stable order, all pages) | PASS |
| Public 60s AI fill → `game.start` with BAC qualification, 13×13, 1H+2AI | PASS |
| Public 30s turn clock → real 30-second wait → `MATCH_ENDED` reason `TIMEOUT` | PASS |
| Public active leave → `MATCH_ENDED` reason `PLAYER_FORFEIT` | PASS |
| Public 3-human online game over WSS: instant match, distinct A/B/C seats, two full rounds broadcast in sync, resign → forfeit to all clients | PASS |
| Public disconnect grace: resume inside 10s keeps the game alive; a later drop past grace → `PLAYER_DISCONNECT` to all clients | PASS |
| Browser walk of the new UI (headless Edge, production): landing/hero replay, rules, register, tutorial gate, tutorial AI response, lobby cards, Human vs AI, Local Match, ranking (50 rows + pagination), friends, online match with hidden nav + turn clock + exit flow, zero uncaught page exceptions — 23/23 checks | PASS |
| WS heartbeat regression: browser WSS survives >75s idle through a local proxy that previously killed tunnels at ~50s | PASS |

## 5. Fixes applied during deployment

1. `backend/tests/ws.integration.ts` — the "dropped game.start → queue.sync replay"
   assertion compared the replayed room to the original start snapshot; an AI move
   landing between the missed start and the sync made it flaky. The replay now
   asserts the at-or-after invariant (latest authoritative room state), matching
   the W10 spec's idempotent `game.start` contract.
2. `.gitignore` + `frontend/src/data/heroGame.ts` — see section 2.
3. `ecosystem.config.cjs` — explicit `SRSZQ_TURN_TIMEOUT_MS: '30000'` for ops
   visibility (code default is also 30s).
4. WebSocket heartbeat (`72b4acd`) — production browsers behind the local proxy
   `127.0.0.1:7890` had their WSS CONNECT tunnel killed at ~50s of idle time,
   dropping queued players mid-wait and resetting the 60s AI-fill deadline via
   rejoin. The server now pings every 25s (protocol-level, auto-ponged by
   browsers) and terminates sockets that miss a pong. Verified: the same browser
   scenario holds the connection beyond 75s idle after the fix.

## 6. Operational notes

- Database: no schema change; the live `data/srszq.sqlite` was untouched by the
  release. `SRSZQ_DATA_DIR` support was added (defaults to `cwd/data` as before).
- Verification QA users were registered against production (`QA_*`, `RANK_*`,
  `DBG_*`, `ui.*`/`UI_*` tags, `@srszq.test` domain). Their forfeit games altered
  only their own ratings.
- `srszq-backup.timer` remains active; take a fresh manual backup per the runbook
  if a longer observation window is desired.
- Rollback: `git -C /var/www/SRSZQ reset --hard 2752d29 && pm2 restart
  srszq-backend` for the backend; Netlify "Deploy previous" on site `srszq` for
  the frontend. `2752d29` was the last pre-Ink production commit.
- Old `e2e.cjs`/`e2e-local.cjs` assertions still target the pre-Ink UI texts and
  are not used in CI; the current production verification suite lives in
  `scripts/pub-smoke.mjs`, `scripts/pub-smoke-3h.mjs`,
  `scripts/pub-ranking-check.mjs`, `scripts/pub-smoke-reconnect.mjs`,
  `scripts/ui-prod-check.cjs` (browser walk) and `scripts/ws-debug.cjs`
  (instrumented WS lifecycle diagnostics).
- Reminder: the HK ECS expiry (`2026-09-13 23:59:59`) recorded in the previous
  handoff has passed but the server remains online — confirm the renewal status
  in the Alibaba Cloud console.

## 7. Public URLs

| URL | Result |
| --- | --- |
| `https://srszq.com` | PASS — new Ink frontend, HTTP 200 |
| `https://www.srszq.com` | 301 → `https://srszq.com` |
| `https://api.srszq.com` | PASS — API edge (Caddy → Nginx → 8080) |
| `wss://api.srszq.com/ws` | PASS — authenticated WebSocket (token query param) |
