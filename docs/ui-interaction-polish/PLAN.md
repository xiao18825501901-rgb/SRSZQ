# SRSZQ Interaction Polish Execution Plan

Base: authoritative clean product workspace at `1878587c36121ef5805b67d6fb06c1a8aa5d69cc`.
Branch: `feature/ui-interaction-polish-20261019`.
Scope: frontend interaction presentation and honest UI feedback only. Backend, shared rules, AI, database, DNS and production remain unchanged.

## 1. Apply the verified presentation patch

- Run the supplied installer check and require `READY`.
- Apply only the nine declared frontend paths and preserve all current business logic.
- Verify the installer-created backup and inspect the resulting diff.

Acceptance: button/icon/modal/replay/selection CSS lands with no backend or shared changes; `main.tsx` preserves existing CSS imports.

## 2. Bind current business states

- Add focused tests for async feedback invalidation, rejected domain results and duplicate-click protection.
- Bind daily-puzzle attempt/next states so `correct=false` is never success, the accepted stone remains, and only the next button advances once.
- Reuse existing auth, queue, friend and settings state machines; add presentation state only where a real operation already exposes completion/failure.

Acceptance: no fake timers or optimistic domain success; stale puzzle/session responses cannot affect the new scope; frozen product behavior remains intact.

## 3. Native verification

- Install dependencies from the unchanged lock file with `npm ci`.
- Run project typecheck, unit tests and build.
- Run focused daily-puzzle, quick-account, matchmaking and rules regressions available in the repository.

Acceptance: commands exit 0 with non-zero test counts; package-lock remains unchanged.

## 4. Real runtime and browser verification

- Start isolated local backend/frontend with a temporary database and non-production ports.
- Exercise desktop 1440x900 and mobile 390x844 / 360x800, including 13x13 and 17x17 flows.
- Verify modal focus/Escape, pointer/keyboard activation, loading/error/success, daily puzzle sequencing, queue semantics and no horizontal overflow.
- Capture current full-site screenshots and record console/network limitations truthfully.

Acceptance: screenshots come from the real full application; no offline component demo is used as final evidence.

## 5. Review and delivery

- Review the diff for correctness, accessibility, performance and scope.
- Produce source fingerprint, changed-file hashes, reports, rollback instructions, source ZIP and real-demo ZIP.
- Stop at `READY_FOR_STAGING`; do not push or deploy.

Acceptance: artifacts exclude secrets, databases, sessions, private games, node_modules and build caches; production touched remains false.
