# SRSZQ Interaction Polish — Test Report

Date: 2026-10-19 (Asia/Shanghai)

Result: **PASS — READY_FOR_STAGING**

## Native checks

| Gate | Result | Evidence |
|---|---:|---|
| `npm ci` from frozen lock | PASS | 60 packages installed; lock hash unchanged |
| Full TypeScript check | PASS | root, frontend and backend |
| Unit suite | PASS | 19 files, 169 tests |
| Production frontend build | PASS | 73 modules; JS 312.45 kB / 98.55 kB gzip; CSS 44.48 kB / 10.85 kB gzip |
| Production dependency audit | PASS | 0 vulnerabilities with `npm audit --omit=dev` |
| Diff whitespace check | PASS | `git diff --check` |

The full development dependency audit reports one pre-existing high advisory in `source-map-js <1.2.2`. It is absent from the production dependency audit. The lockfile was deliberately not upgraded because this delivery is based on the frozen product lock and the UI task did not authorize a dependency migration.

## Real browser checks

All checks used the current built frontend on `127.0.0.1:4173`, the real local backend on `8080/8081`, isolated synthetic accounts and Edge/Chromium CDP. No offline component demo was used as acceptance evidence.

### Account, layout and queue

- One-click account creation and HttpOnly-cookie session: PASS.
- Account claim preserves the same user ID: PASS.
- Lobby and 20-second matchmaking copy/countdown: PASS.
- Desktop 1440×900 and mobile 390×844: PASS.
- Mobile horizontal overflow: 0 (document width 390): PASS.

### Daily training

- ANSWERING, wrong answer, solved state, next question, refresh persistence and complete state: PASS.
- Wrong answer leaves the board unchanged and Next disabled: PASS.
- Correct answer leaves the accepted stone on the board: PASS.
- Next moves from question 1 to question 2 exactly once: PASS.
- Completion stops at 20/20 and never renders question 21: PASS.
- Daily page contains no replay controls or move numbers: PASS.

### Multi-account and online match

- Two independent browser profiles completed friend invite and accept: PASS.
- Three independent accounts all received `game.start`: PASS.
- Queue acknowledgement alone was not treated as a match: PASS.
- Online move clock existed and was at most 30 seconds: PASS.
- Same-account second connection replaced the first without reconnect loops: PASS.

### Modal and accessibility interaction

- Native dialog opened in the top layer: PASS.
- Safe/cancel action received initial focus: PASS.
- Board activation was blocked beneath the dialog: PASS.
- Escape closed the dialog without exiting the game: PASS.
- Settings dialog used the same safe focus behavior: PASS.
- Reduced-motion mode disabled continuous button animation: PASS.
- Browser runtime exceptions across final targeted flows: 0.

### Replay and current-site evidence

- Real three-user scripted game and 20 accepted moves: PASS.
- History, replay timeline, key-move evidence and shared replay: PASS.
- Desktop and mobile replay geometry: PASS.
- White stone fill/border contrast remained distinct: PASS.

Raw native outputs and screenshots are stored in the ignored local evidence directory and copied into the delivery archive. The isolated runtime SQLite database is excluded from every deliverable.
