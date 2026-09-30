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
# 第一方源码目录不属于“运行期数据”。.gitignore 明确写了 !frontend/src/data/
# （见 25fc09e: track frontend hero-game data swallowed by data/ ignore rule），
# 因此按通用的 data/ 名字做黑名单会把真实源码当成运行数据，导致任何 release 都被拒绝。
# 这里先把 frontend/src/data/ 排除，再套用原来的运行期/密钥规则。
tracked_runtime_or_secret() {
  git ls-tree -r --name-only "$1" \
    | grep -vE '^frontend/src/data/' \
    | grep -vE '(^|/)\.env\.example$' \
    | grep -Eq '(^|/)(data/|\.env($|\.))|\.(sqlite(-wal|-shm)?|pem|key)$'
}
for revision in "$previous" "$target"; do
  if tracked_runtime_or_secret "$revision"; then
    echo "Runtime or secret files tracked in $revision; release refused"; exit 1
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
    # 回滚同样要重建进程：否则回滚后的 env 仍是失败那次留下的值。
    pm2 delete srszq-backend >/dev/null 2>&1 || true
    pm2 start ecosystem.config.cjs
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
# PM2 的 reload 会**复用已保存的进程环境**：ecosystem.config.cjs 里新改的 env 不会生效。
# 实测踩到：文件已改成 20000、运行进程里仍是 60000，线上于是继续等 60 秒而发布脚本报 PASS。
# 所以这里重建进程，并在下面用门禁确认新 env 真的进了运行进程。
pm2 delete srszq-backend >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 status srszq-backend

# 环境变量门禁：ecosystem 里声明的值必须与运行进程里的值一致，否则视为发布失败（触发回滚）。
want=$(node -e "const c=require('./ecosystem.config.cjs');process.stdout.write(String(c.apps[0].env.SRSZQ_QUEUE_TIMEOUT_MS))")
got=$(pm2 jlist 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).find(x=>x.name==='srszq-backend');process.stdout.write(String((a&&a.pm2_env&&a.pm2_env.SRSZQ_QUEUE_TIMEOUT_MS)||''))})")
if test "$want" != "$got"; then
  echo "ENV FAIL: SRSZQ_QUEUE_TIMEOUT_MS file=$want process=$got (配置没有真正生效)"
  exit 1
fi
echo "ENV PASS: SRSZQ_QUEUE_TIMEOUT_MS=$got applied"

node scripts/smoke-production.mjs
pm2 save
trap - EXIT
echo "RELEASE PASS: $target; rollback dependencies: $rollback; validation tree: $stage"
