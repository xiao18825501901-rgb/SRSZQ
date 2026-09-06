#!/usr/bin/env bash
set -euo pipefail
umask 077
repo=/var/www/SRSZQ
cd "$repo"
exec 9>/var/lock/srszq-deploy.lock
flock -n 9 || { echo 'Another release is running'; exit 1; }
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
git fetch origin
previous=$(git rev-parse HEAD)
target=$(git rev-parse origin/main)
git merge-base --is-ancestor "$previous" "$target"
for revision in "$previous" "$target"; do
  if git ls-tree -r --name-only "$revision" | grep -Eq '(^|/)(data/|\.env($|\.))|\.(sqlite(-wal|-shm)?|pem|key)$'; then
    # .env.example is an allowed non-secret template; check again without it.
    if git ls-tree -r --name-only "$revision" | grep -vE '(^|/)\.env\.example$' | grep -Eq '(^|/)(data/|\.env($|\.))|\.(sqlite(-wal|-shm)?|pem|key)$'; then
      echo 'Runtime or secret files tracked; release refused'; exit 1
    fi
  fi
done
if git grep -IlE 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY' "$target" -- .; then
  echo 'Potential credential detected; release refused'; exit 1
else
  scan_status=$?
  test "$scan_status" -eq 1
fi
stage=$(mktemp -d /var/tmp/srszq-release-XXXXXX)
git archive "$target" | tar -x -C "$stage"
echo "Validating $target in $stage while production stays online"
(
  cd "$stage"
  unset NODE_ENV ONLY
  npm ci --include=dev
  npm run typecheck
  npm test
  npm run test:backend
  npm run test:ws
  node --test scripts/backup-production-db.test.mjs
  npm run build
  npm audit --audit-level=high
  # Workspace links must remain valid when node_modules is moved to the live root.
  while IFS= read -r -d '' link; do
    case "$(readlink "$link")" in /*) echo 'Absolute dependency symlink; promotion refused'; exit 1;; esac
  done < <(find node_modules -type l -print0)
)
test "$(git rev-parse HEAD)" = "$previous"
test -z "$(git status --porcelain)"
rollback=$(mktemp -d /var/backups/srszq/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX)
printf '%s\n' "$previous" > "$rollback/previous-commit"
printf '%s\n' "$target" > "$rollback/target-commit"
node "$stage/scripts/backup-production-db.mjs" "$repo/data/srszq.sqlite" "$rollback"
recover() {
  rc=$?
  trap - EXIT
  if test "$rc" -ne 0; then
    pm2 stop srszq-backend || true
    if test -d "$rollback/node_modules"; then
      if test -d "$repo/node_modules"; then mv "$repo/node_modules" "$rollback/failed-node_modules"; fi
      mv "$rollback/node_modules" "$repo/node_modules"
    fi
    # Both revisions passed the runtime-file audit, so this only restores tracked source.
    git restore --source="$previous" --staged --worktree -- .
    pm2 start ecosystem.config.cjs --update-env
    pm2 save
    echo "RELEASE FAILED: restored previous source/dependencies; database untouched."
    echo "Review the deliberate Git rollback diff before the next release. Evidence: $rollback"
  fi
  exit "$rc"
}
trap recover EXIT
pm2 stop srszq-backend
test -z "$(ss -H -ltn 'sport = :8080 or sport = :8081')"
git merge --ff-only "$target"
mv "$repo/node_modules" "$rollback/node_modules"
mv "$stage/node_modules" "$repo/node_modules"
pm2 start ecosystem.config.cjs --update-env
node scripts/smoke-production.mjs
pm2 save
trap - EXIT
echo "RELEASE PASS: $target; rollback dependencies: $rollback; validation tree: $stage"
