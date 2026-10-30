# SRSZQ bilingual upgrade — 2026-10-30

Status: IMPLEMENTED_NATIVE_PASS_BROWSER_PARTIAL. Full acceptance is not claimed.

## Source and merge
Independent branch `feature/bilingual-ui-20261030`, based on current product commit `5712f7c`. The preferred Downloads copy has no Git metadata and is an older Ink archive. The clean product worktree includes the previous interaction implementation plus later operations documentation. No checkout of the supplied historical reference was performed.

Installer `--check` returned CONFLICT_NO_WRITES for App, OnlinePage, Platform and PuzzlePage. Compared normalized baseline/overlay/current contents. The other files match verified baseline content after newline normalization. Merged the four conflicts while retaining Btn feedback, async-operation guards, per-invitation controls, queue recovery and isAcceptedPuzzleAttempt. Original files and source branches are preserved. main retains refresh.css, ink.css, review.css and interactions.css, with i18n.css appended.

## Implementation
Imported the supplied locale store, switcher, 490-entry catalog and translated page modules. Added eight current-version messages, for 498 catalog entries, including invitation decisions and next-question rejection. Retained the three original module-only interaction files without business changes. Existing notices are translated on rendering; invitation acceptance/rejection stores descriptors, not language-frozen success text. Online raw errors use the safe display mapping. No remote translation or DOM substitution is used. User text and protocol identifiers remain source data.

## Validation
Native clean npm ci: PASS (60 packages). Frozen product lock unchanged.
Native root/frontend/backend typecheck: PASS.
Native Vitest: PASS, 20 files / 185 tests (169 existing + 16 locale tests).
Native production build: PASS, 77 modules. Final JS about 354.05 kB, gzip 115.60 kB; CSS 47.79 kB.
HTTP API integration: ALL PASS. WebSocket integration: ALL PASS. Puzzle bank/daily-session integration: ALL PASS.
No backend, shared, API client, WS client, AI implementation, package manifest or product lock change.

Real current frontend at http://127.0.0.1:4173 and real backend on 8080/8081, using evidence/runtime/srszq.sqlite only. Local CORS was enabled by process environment for this local origin; no backend source or production change.

Observed browser PASS:
- English/Chinese navigation, document title/lang and literal language names.
- Login text/password field lengths preserved across language switch (synthetic test values; browser redacts content).
- Reload, new-tab locale restoration, and actual cross-tab storage propagation.
- Real one-click account creation, account settings, rules, friends and ranking views.
- Actual daily wrong attempt: no success feedback, next disabled, board unchanged.
- Actual correct attempt: accepted Red stone at row 10/column 8 remains; language switch stays at puzzle 1/20; reload restores solved state; Next alone advances to 2/20.
- Daily page does not show move history or move numbers.
- Local 17x17: 289 points; keyboard Enter creates exactly one stone; language switch preserves stone and route.
- Native settings dialog remains open and updates language from a second tab; Escape cancels without resetting the board.
- Real 20-second queue and AI fill create online game; displayed human clock within 30 seconds. Language switch observed same countdown second; real move accepted and AI responds; exit confirmation and resign outcome render correctly.
- Independent HTTP/WS synthetic three-account scripted game: 3 human seats, 20 moves, zero missing ACKs, proper end and share creation. This is not three independent UI-browser profiles.
- Shared replay backed by that actual server game; cursor moved to 8/20 and preserved across language switch, with 8 stones.
- Current history and server replay verification shown; captured browser warning/error logs empty at final observation.

## Remaining acceptance gates
NOT_RUN / BLOCKED: real 390x844 and 360x800 mobile acceptance. The browser viewport capability returned successfully but did not change observed innerWidth/innerHeight; purported mobile screenshots measured desktop sizes. Files were renamed and actual dimensions are in SCREENSHOT_PROVENANCE.json. No desktop image is claimed as mobile proof.
A native Edge fallback was attempted. Computer Use then stopped because it could not reliably identify the current Windows browser URL for its policy checks. No further browser inputs were sent.
NOT_RUN: 200% text zoom, Safari/iOS device, three isolated browser-account UI profiles, full admin UI, old-user login submission, full claim/save UI, daily completion through all 20 questions, simultaneous AI/worker duplicate-action tracing and network-count instrumentation, share revocation. Backend regressions cover their underlying unchanged policies but do not substitute for these UI checks.
Denied storage tested with unit doubles, not real browser privacy mode. Daily cap 20 covered by existing regression tests and real displayed session total, not 20 browser-completed answers.

## Next action
Restore a browser automation session that exposes working viewport controls (verify actual innerWidth/innerHeight before any mobile screenshot), then execute remaining gates above against this branch and the isolated runtime. Do not repeat already-passed baseline tests unless source changes. No production publication authorization exists for this task.

## Rollback
The original worktree and branch remain untouched. Switch back to the original worktree to inspect the prior version. To roll back in a branch where this feature has been merged, revert only the bilingual feature commits; do not reset/clean, delete databases or overwrite later business logic. Locale preference is display-only and can remain stored. No database migration is needed.
