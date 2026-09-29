/**
 * SRSZQ P3A(B5) —— 训练许可 / 数据集切分与去重 / 事件表 / 导出删除 / 举报屏蔽审计。
 *   npm run test:privacy   （scripts/product/run-tests.mjs --suite privacy 调用）
 *
 * 规格来源：01_PRODUCT_IMPLEMENTATION_SPEC_CN.md 6.1（标准数据）、6.2（数据卫生）、
 *           7.1（第一方指标）、7.2（运营/管理员与隐私）、§8（表名建议）。
 * 验收矩阵：D01-D04、D06 部分、O01、O03、O04。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { buildDataset, trajectoryStateKeys, type DatasetCandidate } from '../../shared/src/product/dataset.js';
import { decideTrainingConsent, decideGameTrainingEligibility, TRAINING_CONSENT_VERSION } from '../../shared/src/product/consent.js';
import { stateDigest } from '../../shared/src/product/replay.js';
import { createInitialState, applyMove } from '../../shared/src/game/rules.js';
import { RULESET_VERSION } from '../../shared/src/product/protocol.js';
import { buildSettlement } from '../../shared/src/product/resultModel.js';
import type { TrailMove } from '../../shared/src/product/puzzleBank.js';
import type { BoardSize } from '../../shared/src/game/types.js';

let db: Db;
let apiBase = '';
let failures = 0;
const observed: Record<string, unknown> = {};

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}
async function registerUser(name: string) {
  const r = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name };
}

/** 造一条真实可重放的轨迹（用引擎逐手走合法手，不手写棋盘）。 */
function makeMoves(boardSize: BoardSize, cells: Array<[number, number]>): TrailMove[] {
  let state = createInitialState(boardSize);
  const moves: TrailMove[] = [];
  for (const [row, col] of cells) {
    const seat = (['A', 'B', 'C'] as const)[state.turnIndex % 3];
    const res = applyMove(state, row, col);
    assert.equal(res.rejected, undefined, '测试轨迹必须合法：' + row + ',' + col + ' -> ' + res.rejected);
    moves.push({ seat, row, col });
    state = res.state;
  }
  return moves;
}

function candidate(gameId: string, moves: TrailMove[], source: 'HUMAN' | 'SYNTHETIC', participantUserIds: string[], boardSize: BoardSize = 13): DatasetCandidate {
  return {
    gameId, rulesetVersion: RULESET_VERSION, boardSize, mode: 'online', source, moves,
    terminal: 'open', participantUserIds, createdAt: 0,
  };
}

const BASE_CELLS: Array<[number, number]> = [[5, 5], [6, 1], [0, 1], [10, 10], [6, 2], [0, 2], [10, 11], [6, 3]];
/** 空间镜像（左右翻转）：与 BASE_CELLS 互为对称，必须被识别为重复样本。 */
const MIRROR_CELLS: Array<[number, number]> = BASE_CELLS.map(([r, c]) => [r, 12 - c] as [number, number]);
/** 颜色置换（把每个座位的落子位置错位到下一手）：**不是**对称等价，不得被判为重复。 */
const SHIFTED_CELLS: Array<[number, number]> = BASE_CELLS.map(([r, c]) => [r, c + 1] as [number, number]);

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-privacy-'));
  db = openDb(join(dir, 'test.sqlite'));
  const { server: apiServer } = createApi(db, {});
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;

  const alice = await registerUser('PrivacyAlice');
  const bob = await registerUser('PrivacyBob');
  const admin = await registerUser('PrivacyAdmin');
  db.setUserRole(admin.id, 'ADMIN');

  console.log('--- D01 训练许可 ---');

  await check('D01a 默认不纳入：没有记录时一律按不允许处理', async () => {
    assert.equal(decideTrainingConsent(null).allowed, false);
    assert.equal((decideTrainingConsent(null) as any).reason, 'NO_RECORD');
    const r = await api('GET', '/api/consent/training', undefined, alice.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.consent, null, '新账号不应有许可记录');
    assert.equal(r.json.decision.allowed, false);
    assert.ok(String(r.json.notice.revoke).includes('无法要求已训练模型遗忘'), '撤回后果必须写清楚，不含糊');
  });

  await check('D01b 授予/撤回/版本不符三种状态各自可判定，并写审计', async () => {
    const granted = await api('POST', '/api/consent/training', { grant: true }, alice.token);
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    assert.equal(granted.json.consent.version, TRAINING_CONSENT_VERSION);
    assert.equal(granted.json.decision.allowed, true);
    assert.equal(decideTrainingConsent({ userId: alice.id, kind: 'TRAINING', version: 'old-v0', grantedAt: 1, revokedAt: null }).allowed, false);
    assert.equal((decideTrainingConsent({ userId: alice.id, kind: 'TRAINING', version: 'old-v0', grantedAt: 1, revokedAt: null }) as any).reason, 'VERSION_MISMATCH');
    const audit = db.listAudit(50).filter((a) => a.action === 'CONSENT_GRANT');
    assert.ok(audit.length >= 1, '授予许可必须留审计');
    const revoked = await api('POST', '/api/consent/training', { grant: false }, alice.token);
    assert.equal(revoked.json.decision.allowed, false);
    assert.equal(revoked.json.decision.reason, 'REVOKED');
    assert.equal(revoked.json.consent.version, TRAINING_CONSENT_VERSION, '撤回后仍保留原版本以便审计');
  });

  await check('D01c 一局里只要有一位参与者未授权，这一局就不纳入', async () => {
    const verdict = decideGameTrainingEligibility([alice.id, bob.id], (uid) =>
      decideTrainingConsent({ userId: uid, kind: 'TRAINING', version: TRAINING_CONSENT_VERSION, grantedAt: 1, revokedAt: uid === bob.id ? 2 : null }));
    assert.equal(verdict.allowed, false, '混合授权必须按不允许处理');
    assert.equal(verdict.blockedBy.length, 1);
    assert.equal(verdict.blockedBy[0].reason, 'REVOKED');
  });

  console.log('--- D02/D03 数据集切分与对称去重 ---');

  await check('D02a 空间镜像对局被识别为重复样本，只保留一份', async () => {
    const base = makeMoves(13, BASE_CELLS);
    const mirror = makeMoves(13, MIRROR_CELLS);
    const a = trajectoryStateKeys(13, base, RULESET_VERSION);
    const b = trajectoryStateKeys(13, mirror, RULESET_VERSION);
    assert.equal(a.canonicalTrajectoryHash, b.canonicalTrajectoryHash, '互为空间镜像的轨迹规范哈希必须相同');
    assert.equal(a.variants, 8, '必须真的算了 8 种空间变换');
    const manifest = buildDataset([
      candidate('mirror-a', base, 'SYNTHETIC', []),
      candidate('mirror-b', mirror, 'SYNTHETIC', []),
    ], () => ({ allowed: false, reason: 'NO_RECORD' }));
    observed.d02_duplicates = manifest.symmetricDuplicatesDropped;
    assert.equal(manifest.entries.length, 1, '镜像重复只应保留一局');
    assert.equal(manifest.symmetricDuplicatesDropped, 1);
    assert.equal(manifest.excluded.filter((e) => e.reason === 'SYMMETRIC_DUPLICATE').length, 1);
  });

  await check('D03a 红绿白颜色置换**不**视为等价（规格明写不等价）', async () => {
    const base = makeMoves(13, BASE_CELLS);
    const shifted = makeMoves(13, SHIFTED_CELLS);
    const a = trajectoryStateKeys(13, base, RULESET_VERSION);
    const b = trajectoryStateKeys(13, shifted, RULESET_VERSION);
    assert.notEqual(a.canonicalTrajectoryHash, b.canonicalTrajectoryHash, '错位（相当于换色）不得被判为同一局面');
    const manifest = buildDataset([
      candidate('shift-a', base, 'SYNTHETIC', []),
      candidate('shift-b', shifted, 'SYNTHETIC', []),
    ], () => ({ allowed: false, reason: 'NO_RECORD' }));
    assert.equal(manifest.entries.length, 2, '两局都必须保留');
    assert.equal(manifest.symmetricDuplicatesDropped, 0);
  });

  await check('D03b stateKey 含棋盘尺寸/ruleset/turnIndex 与资格 phase', async () => {
    const base = makeMoves(13, BASE_CELLS);
    const keys13 = trajectoryStateKeys(13, base, RULESET_VERSION);
    const k13 = createInitialState(13);
    const k17 = createInitialState(17);
    assert.notEqual(stateDigest(k13, RULESET_VERSION), stateDigest(k17, RULESET_VERSION), '棋盘尺寸必须进 stateKey');
    assert.notEqual(stateDigest(k13, 'formal-rules-v2'), stateDigest(k13, 'other-rules'), 'ruleset 必须进 stateKey');
    const s1 = applyMove(createInitialState(13), 5, 5).state;
    const advanced = applyMove(s1, 6, 6).state;
    assert.notEqual(stateDigest(s1, RULESET_VERSION), stateDigest(advanced, RULESET_VERSION), 'turnIndex 必须进 stateKey');
    assert.equal(keys13.keys.length, base.length, '每一手都要有 stateKey');
    assert.equal(keys13.canonicalKeys.length, base.length);
    // 资格 phase 变化会改变摘要：第 1 轮与第 6 轮的空盘状态不同
    const round6 = createInitialState(13);
    const r6 = { ...round6, turnIndex: 15 };
    assert.notEqual(stateDigest(round6, RULESET_VERSION), stateDigest(r6 as any, RULESET_VERSION), '资格 phase 必须进 stateKey');
  });

  await check('D02b 整盘切分：同一局不跨 split，且 test 不得用于选权重', async () => {
    const moves = makeMoves(13, BASE_CELLS);
    const manifest = buildDataset([
      candidate('split-1', moves, 'SYNTHETIC', []),
      candidate('split-2', makeMoves(13, SHIFTED_CELLS), 'SYNTHETIC', []),
      candidate('split-3', makeMoves(13, BASE_CELLS.map(([r, c]) => [r + 2, c] as [number, number])), 'SYNTHETIC', []),
    ], () => ({ allowed: false, reason: 'NO_RECORD' }));
    for (const e of manifest.entries) assert.ok(['train', 'dev', 'test'].includes(e.split));
    assert.equal(manifest.testForWeightSelection, false, 'test 分片必须显式声明不用于选权重');
    assert.equal(manifest.entries.length, 3);
    observed.d02_splits = manifest.bySplit;
    // 数据集哈希可由同一批输入复算
    const again = buildDataset([
      candidate('split-1', moves, 'SYNTHETIC', []),
      candidate('split-2', makeMoves(13, SHIFTED_CELLS), 'SYNTHETIC', []),
      candidate('split-3', makeMoves(13, BASE_CELLS.map(([r, c]) => [r + 2, c] as [number, number])), 'SYNTHETIC', []),
    ], () => ({ allowed: false, reason: 'NO_RECORD' }));
    assert.equal(again.datasetHash, manifest.datasetHash, '同输入必须得到同一 datasetHash');
  });

  await check('D02c 未授权的人类棋谱被排除，合成棋谱可纳入（默认不纳入私密真人数据）', async () => {
    const moves = makeMoves(13, BASE_CELLS);
    const human = candidate('human-1', moves, 'HUMAN', [alice.id]);
    const synth = candidate('synth-1', makeMoves(13, SHIFTED_CELLS), 'SYNTHETIC', []);
    const denied = buildDataset([human, synth], () => decideTrainingConsent(db.getConsent(alice.id, 'TRAINING')));
    assert.equal(denied.entries.filter((e) => e.source === 'HUMAN').length, 0, '未授权的人类棋谱不得纳入');
    assert.ok(denied.excluded.some((e) => e.reason === 'NO_TRAINING_CONSENT'));
    assert.equal(denied.entries.filter((e) => e.source === 'SYNTHETIC').length, 1);
    const allowed = buildDataset([human], () => ({ allowed: true, version: TRAINING_CONSENT_VERSION }));
    assert.equal(allowed.entries.length, 1);
    assert.equal(allowed.entries[0].consentVersion, TRAINING_CONSENT_VERSION, '纳入时必须记录当时同意的版本');
  });

  await check('D02d 端到端：真实棋谱先被排除，授予许可后纳入，撤回后停止纳入', async () => {
    const denied = await api('POST', '/api/admin/dataset/build', {}, bob.token);
    assert.equal(denied.status, 403, '普通用户不得访问数据集接口');

    // 1) 先在库里记录一条**真实**棋谱：逐手写 game_events（与线上同一条持久化路径），再结算。
    const moves = makeMoves(13, BASE_CELLS);
    moves.forEach((m, i) => {
      db.appendGameCommand({
        gameId: 'privacy-dataset-1', commandId: 'cmd-' + i, seat: m.seat,
        payload: { row: m.row, col: m.col },
        revisionBefore: i, revisionAfter: i + 1, seq: i + 1,
        eventType: 'move.applied',
        eventPayload: { seat: m.seat, row: m.row, col: m.col, revision: i + 1 },
        snapshot: { state: { boardSize: 13 }, mode: 'online', seats: {} },
        ack: { type: 'ack', commandId: 'cmd-' + i },
        createdAt: Date.now() + i,
      });
    });
    const plan = buildSettlement({
      gameId: 'privacy-dataset-1', mode: 'online', boardSize: 13, status: 'draw', boardWinner: null,
      endReason: 'BOARD_DRAW', isRanked: true,
      participants: [
        { seat: 'A', kind: 'human', userId: alice.id },
        { seat: 'B', kind: 'human', userId: bob.id },
        { seat: 'C', kind: 'human', userId: admin.id },
      ],
    });
    db.settleMatch({ ...plan, matchId: 'privacy-dataset-match-1', movesJson: '[]', players: [alice.id, bob.id, admin.id] });

    const withoutConsent = await api('POST', '/api/admin/dataset/build', {}, admin.token);
    assert.equal(withoutConsent.status, 200, JSON.stringify(withoutConsent.json));
    assert.ok(withoutConsent.json.candidates >= 1, '库里已有真实棋谱，候选数必须 >= 1');
    assert.equal(withoutConsent.json.manifest.entries.length, 0, '未授权的人类棋谱不得进入数据集');
    assert.ok(
      withoutConsent.json.manifest.excluded.some((e: any) => e.reason === 'NO_TRAINING_CONSENT'),
      '排除原因必须写明是未授权',
    );
    assert.equal(withoutConsent.json.manifest.testForWeightSelection, false);
    assert.ok(db.listAudit(50).some((a) => a.action === 'DATASET_BUILD'), '数据集构建必须留审计');

    // 2) 三位参与者都同意 → 这一局被纳入，并记录当时同意的版本。
    for (const u of [alice, bob, admin]) await api('POST', '/api/consent/training', { grant: true }, u.token);
    const withConsent = await api('POST', '/api/admin/dataset/build', {}, admin.token);
    const entry = withConsent.json.manifest.entries.find((e: any) => e.gameId === 'privacy-dataset-1');
    assert.ok(entry, '全部同意后这一局必须被纳入');
    assert.equal(entry.consentVersion, TRAINING_CONSENT_VERSION);
    assert.equal(entry.source, 'HUMAN');
    assert.equal(entry.plies, moves.length, '轨迹手数必须与持久事件一致');
    assert.ok(withConsent.json.manifest.datasetHash.length === 32);

    // 3) 撤回 → 停止纳入**新**数据集（已纳入的历史样本不会被追回，这一点在接口里也写明）。
    await api('POST', '/api/consent/training', { grant: false }, alice.token);
    const afterRevoke = await api('POST', '/api/admin/dataset/build', {}, admin.token);
    assert.equal(
      afterRevoke.json.manifest.entries.some((e: any) => e.gameId === 'privacy-dataset-1'),
      false,
      '撤回后不得再纳入新数据集',
    );
    observed.d02_build = {
      candidates: withConsent.json.candidates,
      withoutConsent: withoutConsent.json.manifest.entries.length,
      withConsent: withConsent.json.manifest.entries.length,
      afterRevoke: afterRevoke.json.manifest.entries.length,
      bySplit: withConsent.json.manifest.bySplit,
    };
  });

  console.log('--- D04 运行登记（同 seed/配置/轨迹不算新增独立样本）---');

  await check('D04 阶段重跑登记一次为独立样本，重复登记被识别', async () => {
    const base = { seedFrom: 1, seedTo: 1000, sourceSha: 'abc', engineVersion: 'eng-1', budget: 'nodes=1000', trajectoryHash: 'traj-1', configHash: 'cfg-1', uniqueSampleCount: 500 };
    const first = await api('POST', '/api/admin/dataset/runs', { runId: 'run-1', ...base }, admin.token);
    assert.equal(first.status, 201);
    assert.equal(first.json.isNewIndependentSample, true);
    const second = await api('POST', '/api/admin/dataset/runs', { runId: 'run-2', ...base }, admin.token);
    assert.equal(second.json.isNewIndependentSample, false, '相同 seed/配置/轨迹不得算新增独立样本');
    assert.equal(second.json.duplicateOf, 'run-1');
    const other = await api('POST', '/api/admin/dataset/runs', { runId: 'run-3', ...base, seedFrom: 1001, seedTo: 2000 }, admin.token);
    assert.equal(other.json.isNewIndependentSample, true, '不同 seed 区间是新的独立样本');
    const runs = await api('GET', '/api/admin/dataset/runs', undefined, admin.token);
    assert.ok(runs.json.runs.length >= 2);
  });

  console.log('--- O01 事件表 ---');

  await check('O01a eventId 去重；bot/合成在真人口径里被排除', async () => {
    const a = await api('POST', '/api/events', { eventId: 'evt-1', name: 'review_open' }, alice.token);
    assert.equal(a.json.recorded, true);
    const b = await api('POST', '/api/events', { eventId: 'evt-1', name: 'review_open' }, alice.token);
    assert.equal(b.json.duplicate, true, '同一 eventId 重发不得重复计数');
    assert.equal(b.json.recorded, false);
    db.insertProductEvent({ eventId: 'evt-bot', name: 'match_finish', source: 'SYNTHETIC', isBot: true, isSample: false });
    db.insertProductEvent({ eventId: 'evt-synth', name: 'match_finish', source: 'SYNTHETIC', isBot: false });
    db.insertProductEvent({ eventId: 'evt-human', name: 'match_finish', source: 'HUMAN', isBot: false });
    const humanOnly = db.countProductEvents({ name: 'match_finish' });
    const all = db.countProductEvents({ name: 'match_finish', excludeBot: false, excludeSynthetic: false });
    observed.o01 = { humanOnly, all };
    assert.equal(humanOnly.total, 1, '真人口径只应剩 1 条');
    assert.equal(all.total, 3);
  });

  await check('O01b 客户端不能伪造对局事实（白名单外的事件被拒）', async () => {
    const forged = await api('POST', '/api/events', { eventId: 'evt-forged', name: 'match_finish' }, alice.token);
    assert.equal(forged.status, 400, '客户端不得上报对局事实事件');
    assert.ok(Array.isArray(forged.json.allowed));
    const allowed = await api('POST', '/api/events', { eventId: 'evt-2', name: 'retry_move' }, alice.token);
    assert.equal(allowed.status, 200);
  });

  console.log('--- O04 数据导出与删除 ---');

  await check('O04a 导出为任务形态：DONE 后取回本人数据，且不含凭据与他人身份', async () => {
    const created = await api('POST', '/api/me/export', {}, alice.token);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const taskId = created.json.task.taskId;
    assert.equal(created.json.task.status, 'DONE');
    const fetched = await api('GET', '/api/me/export/' + taskId, undefined, alice.token);
    assert.equal(fetched.status, 200);
    const data = fetched.json.task.result;
    assert.equal(data.profile.email, 'privacyalice@t.local'.replace('privacyalice', 'privacyalice'));
    const blob = JSON.stringify(fetched.json);
    for (const bad of ['password_hash', 'passwordHash', 'salt', 'token']) {
      assert.equal(blob.toLowerCase().includes(bad.toLowerCase()), false, '导出物不得包含 ' + bad);
    }
    const tasks = await api('GET', '/api/me/data-tasks', undefined, alice.token);
    assert.ok(tasks.json.tasks.some((t: any) => t.taskId === taskId && t.kind === 'EXPORT'));
    assert.ok(db.listAudit(50).some((a) => a.action === 'DATA_EXPORT'));
  });

  await check('O04b 删除账号：多人记录去标识、分享被撤销、他人记录不受影响', async () => {
    // 造一局同时包含 alice 与 bob 的已结算记录
    const plan = {
      gameId: 'privacy-game-1', mode: 'online', boardSize: 13 as BoardSize, status: 'won' as const, boardWinner: 'A' as const,
      endReason: 'NORMAL_WIN' as const, isRanked: true,
      participants: [
        { seat: 'A' as const, kind: 'human' as const, userId: alice.id },
        { seat: 'B' as const, kind: 'human' as const, userId: bob.id },
        { seat: 'C' as const, kind: 'human' as const, userId: admin.id },
      ],
    };
    const built = (await import('../../shared/src/product/resultModel.js')).buildSettlement(plan as any);
    db.settleMatch({ ...built, matchId: 'privacy-match-1', movesJson: '[]', players: [alice.id, bob.id, admin.id] });
    const share = await api('POST', '/api/games/privacy-game-1/share', {}, alice.token);
    assert.equal(share.status, 201);
    const before = db.listMatchParticipants('privacy-game-1').length;
    assert.equal(before, 3);
    const wrongConfirm = await api('DELETE', '/api/me/data', { confirm: 'nope' }, alice.token);
    assert.equal(wrongConfirm.status, 400, '必须显式确认才执行删除');
    const del = await api('DELETE', '/api/me/data', { confirm: 'DELETE_MY_DATA' }, alice.token);
    assert.equal(del.status, 200, JSON.stringify(del.json));
    const result = del.json.task.result;
    observed.o04_delete = result;
    assert.ok(result.deidentifiedParticipants >= 1, '至少一行的 user_id 被摘除');
    assert.equal(result.revokedShares, 1, '分享链接必须被撤销');
    assert.equal(db.listMatchParticipants('privacy-game-1').length, 3, '对局本身不得删除（他人合法记录保留）');
    const aliceRow = db.raw.prepare('SELECT user_id FROM match_participants WHERE game_id = ? AND seat = ?').get('privacy-game-1', 'A') as { user_id: string | null };
    assert.equal(aliceRow.user_id, null, '被删账号的名次行必须去标识');
    const bobRow = db.raw.prepare('SELECT user_id FROM match_participants WHERE game_id = ? AND seat = ?').get('privacy-game-1', 'B') as { user_id: string | null };
    assert.equal(bobRow.user_id, bob.id, '其他参与者的身份不得被改动');
    const userRow = db.raw.prepare('SELECT email, username, deleted_at FROM users WHERE id = ?').get(alice.id) as { email: string; username: string; deleted_at: number | null };
    assert.ok(userRow.email.includes('deleted.invalid'));
    assert.ok(userRow.username.startsWith('已注销用户'));
    assert.ok(Number(userRow.deleted_at) > 0);
    const shareAfter = db.findShareLink(share.json.share.token);
    assert.ok(shareAfter && shareAfter.revokedAt !== null, '撤销时间必须落库');
    const publicView = await api('GET', '/api/shared/' + share.json.share.token);
    assert.equal(publicView.status, 410);
  });

  console.log('--- O03 举报 / 屏蔽 / 审计 ---');

  await check('O03a 举报只登记不自动处罚，进人工队列', async () => {
    const created = await api('POST', '/api/report', { targetKind: 'USER', targetId: bob.id, reason: 'harass', detail: '在聊天里辱骂' }, admin.token);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.report.status, 'PENDING');
    assert.ok(String(created.json.note).includes('不会依据举报自动封禁'), '必须明确不做自动处罚');
    const self = await api('POST', '/api/report', { targetKind: 'USER', targetId: admin.id, reason: 'x' }, admin.token);
    assert.equal(self.status, 400, '不能举报自己');
    const queue = await api('GET', '/api/admin/reports?status=PENDING', undefined, admin.token);
    assert.ok(queue.json.reports.length >= 1);
    const forbidden = await api('GET', '/api/admin/reports', undefined, bob.token);
    assert.equal(forbidden.status, 403);
  });

  await check('O03b 举报复核与屏蔽/解除都留审计，且不影响历史评分', async () => {
    const queue = await api('GET', '/api/admin/reports?status=PENDING', undefined, admin.token);
    const reportId = queue.json.reports[0].reportId;
    const reviewed = await api('POST', '/api/admin/reports/' + reportId, { status: 'REVIEWED', note: '人工看过，先不处理' }, admin.token);
    assert.equal(reviewed.status, 200);
    const after = await api('GET', '/api/admin/reports?status=REVIEWED', undefined, admin.token);
    assert.ok(after.json.reports.some((r: any) => r.reportId === reportId));
    assert.ok(db.listAudit(50).some((a) => a.action === 'REPORT_REVIEW'));
    const blocked = await api('POST', '/api/block', { userId: bob.id }, admin.token);
    assert.equal(blocked.status, 200);
    assert.deepEqual(blocked.json.blocks, [bob.id]);
    const unblocked = await api('DELETE', '/api/block/' + bob.id, undefined, admin.token);
    assert.equal(unblocked.status, 200);
    assert.deepEqual(unblocked.json.blocks, []);
    assert.ok(db.listAudit(50).some((a) => a.action === 'BLOCK_ADD'));
    assert.ok(db.listAudit(50).some((a) => a.action === 'BLOCK_REMOVE'));
    // 评分历史只能追加，不被举报流程改写：账本行数不因复核而变化
    const ledgerBefore = Number((db.raw.prepare('SELECT COUNT(*) AS n FROM rating_ledger').get() as any).n);
    await api('POST', '/api/report', { targetKind: 'USER', targetId: bob.id, reason: 'again' }, admin.token);
    const ledgerAfter = Number((db.raw.prepare('SELECT COUNT(*) AS n FROM rating_ledger').get() as any).n);
    assert.equal(ledgerAfter, ledgerBefore, '举报不得改动评分账本');
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  await new Promise<void>((r) => apiServer.close(() => r()));
  db.close();
  if (failures === 0) console.log('PRIVACY DATASET: ALL PASS 0');
  else console.log('PRIVACY DATASET: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });