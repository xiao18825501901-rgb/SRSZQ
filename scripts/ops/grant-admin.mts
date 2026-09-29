/**
 * 受控 CLI：授予/撤销管理角色（规格 7.2：基本 admin 角色通过受控 CLI 授予，不硬编码邮箱）。
 *
 *   npx tsx scripts/ops/grant-admin.mts <username>            # 授予
 *   npx tsx scripts/ops/grant-admin.mts <username> --revoke   # 撤销
 *   SRSZQ_DB=/var/www/SRSZQ/data/srszq.sqlite npx tsx scripts/ops/grant-admin.mts someone
 *
 * 三条纪律：
 *  1. 只能由能在服务器上执行命令的人操作 —— 没有 HTTP 接口可以给自己发权限；
 *  2. 每次操作都写 admin_audit（谁、何时、对谁、结果），可审计；
 *  3. 找不到用户就失败退出，不创建账号（避免“顺手造一个管理员”）。
 */
import { openDb } from '../../backend/src/db.js';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const revoke = args.includes('--revoke');
const dbPath = process.env.SRSZQ_DB || '/var/www/SRSZQ/data/srszq.sqlite';

if (!username) {
  console.error('用法: npx tsx scripts/ops/grant-admin.mts <username> [--revoke]');
  process.exit(2);
}

const db = openDb(dbPath);
try {
  const user = db.findUserByUsername(username) ?? db.findUserByUsernameCI(username);
  if (!user) {
    console.error('找不到用户: ' + username + '（本工具不会创建账号）');
    process.exit(1);
  }
  const before = db.getUserRole(user.id);
  const after = revoke ? 'USER' : 'ADMIN';
  if (before === after) {
    console.log('无需变更：' + username + ' 当前已经是 ' + before);
    process.exit(0);
  }
  db.setUserRole(user.id, after);
  db.appendAudit({
    actorId: process.env.SRSZQ_ACTOR || 'cli:grant-admin',
    actorRole: 'ADMIN',
    action: revoke ? 'ROLE_REVOKE' : 'ROLE_GRANT',
    targetKind: 'USER',
    targetId: user.id,
    detail: { username, before, after, dbPath },
  });
  console.log(JSON.stringify({ username, userId: user.id, before, after, audit: 'written' }));
} finally {
  db.close();
}