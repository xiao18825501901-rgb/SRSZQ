# Bilingual merge plan
1. Verify current source and frozen lock; preserve clean base 5712f7c in isolated feature worktree.
2. Compare each baseline/overlay/current file; merge presentation only, preserve current interaction and business transitions. Gate: no unresolved markers and native typecheck.
3. Import locale tests into native Vitest; clean install, unit, build, HTTP/WS and puzzle regressions.
4. Run real isolated backend and current frontend; verify locale persistence, multi-account gameplay, daily and responsive layouts; capture current screenshots.
5. Review scope, hashes, report observed passes and explicit gaps; package real build and recovery instructions. No production actions.
