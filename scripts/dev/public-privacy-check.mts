
/**
 * 公网行为验收（P3A）：训练许可 / 数据导出 / 删除账号 / 事件表 / 举报屏蔽。
 *
 *   npx tsx scripts/dev/public-privacy-check.mts
 *
 * 这些能力必须对**真实域名**验证：许可与删除是不可逆的用户承诺，
 * 只在测试库里成立不算数。删除流程会在生产上真的去标识一个验证账号（DEMO 账号，非真人）。
 */
import { api, playScriptedTrioGame } from './lib/scriptedGame.mjs';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const WSURL = process.env.SRSZQ_WS_URL ?? 'wss://api.srszq.com/ws';
const stamp = Date.now().toString(36);

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };

async function main(): Promise<void> {
  console.log('=== 公网版本 ===');
  const v = await api(API, 'GET', '/api/version');
  const release = v.json?.protocol?.releaseId;
  ok(v.json?.protocol?.protocolVersion === 2, 'protocolVersion=2 release=' + release);

  console.log('=== 准备一局真实对局（DEMO 账号） ===');
  const game = await playScriptedTrioGame({ apiBase: API, wsUrl: WSURL, prefix: 'pv', password: 'Demo-PV-' + stamp + '!3' });
  ok(game.humanSeats === 3 && game.ackFail === 0, '三人同房且 20 手全部被接受');
  const winner = game.winner;

  console.log('=== D01 训练许可（默认不纳入） ===');
  const before = await api(API, 'GET', '/api/consent/training', undefined, winner.token);
  ok(before.status === 200 && before.json?.consent === null, '新账号没有许可记录');
  ok(before.json?.decision?.allowed === false, '默认按不允许处理（decision.allowed=false）');
  ok(String(before.json?.notice?.revoke ?? '').includes('无法要求已训练模型遗忘'), '撤回后果说明不含糊');
  const granted = await api(API, 'POST', '/api/consent/training', { grant: true }, winner.token);
  ok(granted.json?.decision?.allowed === true, '授予后允许纳入');
  ok(granted.json?.consent?.version === before.json?.version, '许可版本与服务器当前版本一致');
  const revoked = await api(API, 'POST', '/api/consent/training', { grant: false }, winner.token);
  ok(revoked.json?.decision?.allowed === false && revoked.json?.decision?.reason === 'REVOKED', '撤回后立即不允许');
  ok(revoked.json?.consent?.version === before.json?.version, '撤回后仍保留原版本以便审计');
  await api(API, 'POST', '/api/consent/training', { grant: true }, winner.token);

  console.log('=== O01 事件表（客户端不能伪造对局事实） ===');
  const evtId = 'pv-evt-' + stamp;
  const first = await api(API, 'POST', '/api/events', { eventId: evtId, name: 'review_open' }, winner.token);
  ok(first.status === 200 && first.json?.recorded === true, '白名单内的 UI 事件被记录');
  const dup = await api(API, 'POST', '/api/events', { eventId: evtId, name: 'review_open' }, winner.token);
  ok(dup.json?.duplicate === true && dup.json?.recorded === false, '同一 eventId 重发不重复计数');
  const forged = await api(API, 'POST', '/api/events', { eventId: evtId + '-x', name: 'match_finish' }, winner.token);
  ok(forged.status === 400, '客户端伪造 match_finish 被拒（实际 ' + forged.status + '）');
  const anon = await api(API, 'POST', '/api/events', { eventId: evtId + '-y', name: 'review_open' });
  ok(anon.status === 401, '未登录不得写事件');

  console.log('=== 管理端门禁 ===');
  const denied = await api(API, 'POST', '/api/admin/dataset/build', {}, winner.token);
  ok(denied.status === 403, '普通账号访问数据集接口 403（实际 ' + denied.status + '）');
  const auditDenied = await api(API, 'GET', '/api/admin/audit', undefined, winner.token);
  ok(auditDenied.status === 403, '普通账号读审计 403');

  console.log('=== O04 举报 / 屏蔽 ===');
  const report = await api(API, 'POST', '/api/report', { targetKind: 'USER', targetId: game.users[0].id, reason: 'spam', detail: '验证用举报' }, winner.token);
  ok(report.status === 201 && report.json?.report?.status === 'PENDING', '举报进入人工队列（PENDING）');
  ok(String(report.json?.note ?? '').includes('不会依据举报自动封禁'), '接口明确说明不做自动处罚');
  const blocked = await api(API, 'POST', '/api/block', { userId: game.users[0].id }, winner.token);
  ok(blocked.status === 200 && Array.isArray(blocked.json?.blocks) && blocked.json.blocks.length === 1, '屏蔽生效');
  const unblocked = await api(API, 'DELETE', '/api/block/' + game.users[0].id, undefined, winner.token);
  ok(unblocked.status === 200 && unblocked.json?.blocks.length === 0, '解除屏蔽');

  console.log('=== O04 导出 ===');
  const created = await api(API, 'POST', '/api/me/export', {}, winner.token);
  ok(created.status === 201, '导出任务创建 http=' + created.status);
  const taskId = created.json?.task?.taskId;
  ok(!!taskId && created.json.task.status === 'DONE', '任务完成状态 DONE');
  const fetched = await api(API, 'GET', '/api/me/export/' + taskId, undefined, winner.token);
  const body = JSON.stringify(fetched.json);
  ok(fetched.status === 200 && fetched.json?.task?.result?.profile?.username === winner.username, '导出物是本人数据');
  ok(!/password_hash|passwordHash|"salt"|Bearer /.test(body), '导出物不含凭据材料');
  ok(fetched.json?.task?.result?.matches?.length >= 1, '导出物包含本人已结算对局（' + fetched.json?.task?.result?.matches?.length + ' 局）');

  console.log('=== O04 删除账号（去标识） ===');
  const share = await api(API, 'POST', '/api/games/' + game.gameId + '/share', {}, winner.token);
  ok(share.status === 201, '先创建一条分享链接');
  const token = share.json?.share?.token as string;
  ok((await api(API, 'GET', '/api/shared/' + token)).status === 200, '删除前分享可访问');
  const wrong = await api(API, 'DELETE', '/api/me/data', { confirm: 'no' }, winner.token);
  ok(wrong.status === 400, '缺少显式确认时拒绝执行删除');
  const del = await api(API, 'DELETE', '/api/me/data', { confirm: 'DELETE_MY_DATA' }, winner.token);
  ok(del.status === 200, '删除请求被接受 http=' + del.status);
  const result = del.json?.task?.result;
  ok(Number(result?.deidentifiedParticipants) >= 1, '名次行被去标识（' + result?.deidentifiedParticipants + ' 行）');
  ok(Number(result?.revokedShares) >= 1, '分享链接被撤销（' + result?.revokedShares + ' 条）');
  const afterShare = await api(API, 'GET', '/api/shared/' + token);
  ok(afterShare.status === 410, '删除后公开分享返回 410（实际 ' + afterShare.status + '）');
  const meAfter = await api(API, 'GET', '/api/me', undefined, winner.token);
  ok(meAfter.status === 401, '会话已失效（旧 token 不再可用）');
  const otherStillThere = await api(API, 'GET', '/api/games/' + game.gameId + '/replay', undefined, game.users[0].token);
  ok(otherStillThere.status === 200, '同一局对其他参与者仍然可读（不连带删除他人记录）');

  console.log('=== 观测 ===');
  console.log('  release=' + release);
  console.log('  gameId=' + game.gameId);
  console.log('  demoUsers=' + game.users.map((u) => u.username).join(','));
  console.log('  deleteResult=' + JSON.stringify(result));
  console.log(failures === 0 ? 'PUBLIC PRIVACY CHECK: ALL PASS 0' : 'PUBLIC PRIVACY CHECK: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });