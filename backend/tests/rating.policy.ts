/**
 * SRSZQ P1(B3) —— 排位资格、V1 评分算法、重复对手保护、排行榜过滤
 *   npm run test:rating   （scripts/product/run-tests.mjs --suite features 调用）
 *
 * 规格来源：reference_spec/01_PRODUCT_IMPLEMENTATION_SPEC_CN.md 第 4 节。
 * H1/H2 直接使用规格自带的两个例子当回归基准（+16/-8/-8、-8/+4/+4），
 * 这样「实现是否符合规格」有一个不依赖我理解的锚点。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer } from '../src/ws/gameServer.js';
import {
  computeRatingDeltas, computeLegacyDeltas, evaluateBetaEligibility, resolveRatingPolicy,
  deriveScoreTargets, applyDeltas,
  LEGACY_POLICY_ID, BETA_V1_POLICY_ID, NO_RATING_POLICY_ID,
  type EligibilityInput, type Eligibility,
} from '../../shared/src/product/ratingPolicy.js';
import { buildSettlement } from '../../shared/src/product/resultModel.js';
import { PROTOCOL_VERSION, RULESET_VERSION } from '../../shared/src/product/protocol.js';

let db: Db;
let apiBase = '';
let wsBase = '';
let failures = 0;
const observed: Record<string, unknown> = {};

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 取不合格原因；合格时返回 null。避免在断言里对联合类型直接取 .reason。 */
function ineligibleReason(e: Eligibility): string | null {
  return e.eligible ? null : e.reason;
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

interface TestClient { ws: WebSocket; msgs: Array<{ type: string; [k: string]: any }>; }
const clientRevisions = new WeakMap<TestClient, number>();
function connect(token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '?token=' + token + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
    const msgs: TestClient['msgs'] = [];
    const client: TestClient = { ws, msgs };
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (typeof m.revision === 'number') clientRevisions.set(client, m.revision); msgs.push(m); });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
const send = (c: TestClient, msg: unknown) => c.ws.send(JSON.stringify(msg));
const close = (c: TestClient) => { try { c.ws.close(); } catch { /* noop */ } };
async function waitFor(c: TestClient, type: string, timeoutMs = 8000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = c.msgs.findIndex((m) => m.type === type);
    if (i >= 0) return c.msgs.splice(i, 1)[0];
    await sleep(15);
  }
  throw new Error('timeout waiting ' + type + '; got ' + c.msgs.map((m) => m.type).join(','));
}
async function pollUntil<T>(fn: () => T | null | undefined, timeoutMs = 8000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = fn(); if (v) return v; await sleep(25); }
  return null;
}
const rawRow = (sql: string, ...a: unknown[]): any => db.raw.prepare(sql).get(...(a as never[])) ?? null;
const ratingOf = (id: string): number => Number((rawRow('SELECT rating FROM users WHERE id = ?', id) as any)?.rating ?? -1);
async function registerUser(name: string) {
  const r = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name };
}

function eligibility(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    mode: 'online',
    seatIsHuman: { A: true, B: true, C: true },
    seatGatePassed: { A: true, B: true, C: true },
    ratingBeta: true,
    noContest: false,
    sameTrioMatchNumber: 1,
    ...over,
  };
}

const THREE = [
  { seat: 'A' as const, userId: 'u-a', rating: 1200 },
  { seat: 'B' as const, userId: 'u-b', rating: 1200 },
  { seat: 'C' as const, userId: 'u-c', rating: 1200 },
];

function planFor(endReason: any, status: any, boardWinner: any, participants: any) {
  return buildSettlement({ gameId: 'g', mode: 'online', boardSize: 13, status, boardWinner, endReason, isRanked: true, participants });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-rating-'));
  db = openDb(join(dir, 'test.sqlite'));
  const gs = new GameServer(db, { queueTimeoutMs: 300, aiMoveDelayMs: 5, forfeitGraceMs: 500, aiTimeBudgetMs: 40, queueSweepMs: 20 });
  const wsHttp = createServer();
  gs.attach(wsHttp, '/ws');
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', r));
  wsBase = 'ws://127.0.0.1:' + (wsHttp.address() as AddressInfo).port + '/ws';
  const { server: apiServer } = createApi(db, {
    onInviteCreated: (a, b) => gs.registerInvitation(a, b),
    onInviteAccepted: (a, b) => gs.handleInviteAccept(a, b),
    onInviteRejected: (a, b) => gs.onInviteRejected(a, b),
    onSessionRevoked: (uid, reason) => gs.revokeUserSession(uid, reason),
  });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;

  console.log('--- H V1 评分算法（规格第 4.2 节）---');

  await check('H1 规格自带例子：三人同分正常局 = +16 / -8 / -8', async () => {
    const plan = planFor('NORMAL_WIN', 'won', 'A', [
      { seat: 'A', kind: 'human', userId: 'u-a' },
      { seat: 'B', kind: 'human', userId: 'u-b' },
      { seat: 'C', kind: 'human', userId: 'u-c' },
    ]);
    const d = computeRatingDeltas(THREE, deriveScoreTargets(plan));
    const bySeat = Object.fromEntries(d.map((x) => [x.seat, x.deltaDisplay]));
    observed.h1 = bySeat;
    assert.deepEqual(bySeat, { A: 16, B: -8, C: -8 }, '规格基准：+16/-8/-8');
  });

  await check('H2 规格自带例子：三人同分单人退出 = -8 / +4 / +4', async () => {
    const plan = planFor('PLAYER_FORFEIT', 'playing', null, [
      { seat: 'A', kind: 'human', userId: 'u-a', forfeited: true },
      { seat: 'B', kind: 'human', userId: 'u-b' },
      { seat: 'C', kind: 'human', userId: 'u-c' },
    ]);
    const d = computeRatingDeltas(THREE, deriveScoreTargets(plan));
    const bySeat = Object.fromEntries(d.map((x) => [x.seat, x.deltaDisplay]));
    observed.h2 = bySeat;
    assert.deepEqual(bySeat, { A: -8, B: 4, C: 4 }, '规格基准：-8/+4/+4');
  });

  await check('H3 真平局：全员 y=1/3 -> 分差 0', async () => {
    const plan = planFor('BOARD_DRAW', 'draw', null, [
      { seat: 'A', kind: 'human', userId: 'u-a' },
      { seat: 'B', kind: 'human', userId: 'u-b' },
      { seat: 'C', kind: 'human', userId: 'u-c' },
    ]);
    const t = deriveScoreTargets(plan);
    assert.equal(t.updatesRating, true);
    assert.deepEqual([t.y.A, t.y.B, t.y.C], [1 / 3, 1 / 3, 1 / 3]);
    const d = computeRatingDeltas(THREE, t);
    assert.ok(d.every((x) => x.delta === 0), '平局同分不应有分差');
  });

  await check('H4 系统中止：不更新 rating（规格 4.2）', async () => {
    const plan = planFor('SYSTEM_ABORT', 'playing', null, [
      { seat: 'A', kind: 'human', userId: 'u-a' },
      { seat: 'B', kind: 'human', userId: 'u-b' },
      { seat: 'C', kind: 'human', userId: 'u-c' },
    ]);
    const t = deriveScoreTargets(plan);
    assert.equal(t.updatesRating, false, 'SYSTEM_ABORT 不得更新 rating');
    assert.equal(t.reason, 'SYSTEM_ABORT');
  });

  await check('H5 三人全部退出：不更新 rating', async () => {
    const plan = planFor('PLAYER_FORFEIT', 'playing', null, [
      { seat: 'A', kind: 'human', userId: 'u-a', forfeited: true },
      { seat: 'B', kind: 'human', userId: 'u-b', forfeited: true },
      { seat: 'C', kind: 'human', userId: 'u-c', forfeited: true },
    ]);
    const t = deriveScoreTargets(plan);
    assert.equal(t.updatesRating, false);
    assert.equal(t.reason, 'ALL_FORFEIT');
  });

  await check('H6 两人退出只剩一人：幸存者 y=1', async () => {
    const plan = planFor('PLAYER_FORFEIT', 'playing', null, [
      { seat: 'A', kind: 'human', userId: 'u-a', forfeited: true },
      { seat: 'B', kind: 'human', userId: 'u-b', forfeited: true },
      { seat: 'C', kind: 'human', userId: 'u-c' },
    ]);
    const t = deriveScoreTargets(plan);
    assert.equal(t.updatesRating, true);
    assert.equal(t.y.C, 1, '唯一幸存者 y=1');
  });

  await check('H7 不同分值：ΣDelta 定点后精确为 0，精度 1e-4', async () => {
    const spread = [
      { seat: 'A' as const, userId: 'a', rating: 1347 },
      { seat: 'B' as const, userId: 'b', rating: 1183 },
      { seat: 'C' as const, userId: 'c', rating: 1271 },
    ];
    const plan = planFor('NORMAL_WIN', 'won', 'B', [
      { seat: 'A', kind: 'human', userId: 'a' },
      { seat: 'B', kind: 'human', userId: 'b' },
      { seat: 'C', kind: 'human', userId: 'c' },
    ]);
    const d = computeRatingDeltas(spread, deriveScoreTargets(plan));
    const sum = d.reduce((a, x) => a + x.delta, 0);
    observed.h7_sum = sum;
    assert.equal(Number(sum.toFixed(4)), 0, 'ΣDelta 必须为 0，实际 ' + sum);
    for (const x of d) assert.equal(x.delta, Number(x.delta.toFixed(4)), '定点精度应为 1e-4');
    // 低分玩家赢应当涨更多（softmax 的合理方向）
    const lowWin = computeRatingDeltas(spread, deriveScoreTargets(planFor('NORMAL_WIN', 'won', 'B', [
      { seat: 'A', kind: 'human', userId: 'a' }, { seat: 'B', kind: 'human', userId: 'b' }, { seat: 'C', kind: 'human', userId: 'c' },
    ])));
    const highWin = computeRatingDeltas(spread, deriveScoreTargets(planFor('NORMAL_WIN', 'won', 'A', [
      { seat: 'A', kind: 'human', userId: 'a' }, { seat: 'B', kind: 'human', userId: 'b' }, { seat: 'C', kind: 'human', userId: 'c' },
    ])));
    assert.ok(lowWin[1].delta > highWin[0].delta, '低分者赢的收益应大于高分者赢的收益');
  });

  await check('H8 不在 0 处 clamp：低分者继续扣分，总和不变正（规格 4.2）', async () => {
    const low = [
      { seat: 'A' as const, userId: 'a', rating: 3 },
      { seat: 'B' as const, userId: 'b', rating: 1500 },
      { seat: 'C' as const, userId: 'c', rating: 1500 },
    ];
    const plan = planFor('NORMAL_WIN', 'won', 'A', [
      { seat: 'A', kind: 'human', userId: 'a' },
      { seat: 'B', kind: 'human', userId: 'b' },
      { seat: 'C', kind: 'human', userId: 'c' },
    ]);
    const d = computeRatingDeltas(low, deriveScoreTargets(plan));
    const after = applyDeltas(low, d);
    observed.h8_after = after;
    assert.ok(after[1] < 1500 && after[2] < 1500, '败者必须真的扣分');
    assert.equal(Number((after[0] + after[1] + after[2] - (3 + 1500 + 1500)).toFixed(4)), 0, '总分不因 clamp 而变正');
  });

  console.log('--- I 资格与策略选择（规格 4.1 / 55 / 142）---');

  await check('I1 快速人机局（AI 补位）永不产生真人竞技分', async () => {
    const one = eligibility({ seatIsHuman: { A: true, B: false, C: false } });
    assert.equal(resolveRatingPolicy(one), NO_RATING_POLICY_ID, '1H+2AI 必须不计真人竞技分');
    const two = eligibility({ seatIsHuman: { A: true, B: true, C: false } });
    assert.equal(resolveRatingPolicy(two), NO_RATING_POLICY_ID, '2H+1AI 必须不计真人竞技分');
    assert.equal(ineligibleReason(evaluateBetaEligibility(one)), 'NOT_THREE_HUMANS');
  });

  await check('I2 好友局 / 非 online 一律不计竞技分', async () => {
    assert.equal(resolveRatingPolicy(eligibility({ mode: 'invite' })), NO_RATING_POLICY_ID);
  });

  await check('I3 beta 关闭时，恰好 3 真人仍走 legacy 过渡策略', async () => {
    assert.equal(resolveRatingPolicy(eligibility({ ratingBeta: false })), LEGACY_POLICY_ID);
    assert.equal(resolveRatingPolicy(eligibility({ ratingBeta: true })), BETA_V1_POLICY_ID);
  });

  await check('I4 门禁未过（未完成教学）不得进入 beta', async () => {
    assert.equal(
      ineligibleReason(evaluateBetaEligibility(eligibility({ seatGatePassed: { A: true, B: false, C: true } }))),
      'NOT_TUTORIAL_COMPLETE',
    );
  });

  await check('I5 无竞技后果的终局：不上分也不扣分（规格 4.2）', async () => {
    assert.equal(resolveRatingPolicy(eligibility({ noContest: true })), NO_RATING_POLICY_ID);
    assert.equal(ineligibleReason(evaluateBetaEligibility(eligibility({ noContest: true }))), 'NO_CONTEST');
  });

  await check('I6 重复对手保护：同一三人组合 24h 内第 4 局起不计分（规格 4.2）', async () => {
    assert.equal(resolveRatingPolicy(eligibility({ sameTrioMatchNumber: 3 })), BETA_V1_POLICY_ID, '第 3 局仍计分');
    const fourth = eligibility({ sameTrioMatchNumber: 4 });
    assert.equal(resolveRatingPolicy(fourth), NO_RATING_POLICY_ID, '第 4 局起变动为 0');
    assert.equal(ineligibleReason(evaluateBetaEligibility(fourth)), 'REPEAT_OPPONENTS');
  });

  console.log('--- J 真实对局：积分到底有没有被改（本轮修的缺陷）---');

  await check('J1 真实 1H+2AI 快速局：真人 rating 必须不变（修复前会被 -10/+30）', async () => {
    const solo = await registerUser('RankSolo');
    const c = await connect(solo.token);
    try {
      const before = ratingOf(solo.id);
      send(c, { type: 'queue.join' });
      const start = await waitFor(c, 'game.start', 12000);
      const gameId = start.gameId as string;
      const aiCount = Object.values(start.seats).filter((s: any) => s.kind === 'ai').length;
      assert.equal(aiCount, 2, '应为 1H+2AI');
      send(c, { type: 'PLAYER_RESIGN' });
      const row = await pollUntil(() => rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId));
      assert.ok(row, '必须落盘');
      assert.equal(row.is_ranked, 0, 'AI 补位快速局不得标记为排位');
      assert.equal(row.score_policy, NO_RATING_POLICY_ID, '策略必须为 none');
      assert.equal(ratingOf(solo.id), before, '快速人机局不得改真人 rating');
      assert.equal(Number((rawRow('SELECT COUNT(*) AS n FROM rating_ledger WHERE game_id = ?', gameId) as any).n), 0, '不得写积分账本');
      const parts = db.listMatchParticipants(gameId);
      assert.ok(parts.every((x) => x.ratingDelta === 0), '参与者分差必须为 0');
    } finally { close(c); await sleep(200); }
  });

  await check('J2 真实 3 真人 online 局：beta 关闭时仍按 legacy +30/-10 结算（过渡期保留）', async () => {
    const u1 = await registerUser('RankA1');
    const u2 = await registerUser('RankB1');
    const u3 = await registerUser('RankC1');
    const cs = [await connect(u1.token), await connect(u2.token), await connect(u3.token)];
    try {
      const before = [ratingOf(u1.id), ratingOf(u2.id), ratingOf(u3.id)];
      for (const c of cs) send(c, { type: 'queue.join' });
      const starts = await Promise.all(cs.map((c) => waitFor(c, 'game.start', 8000)));
      const gameId = starts[0].gameId as string;
      const seatsHuman = Object.values(starts[0].seats).filter((s: any) => s.kind === 'human').length;
      assert.equal(seatsHuman, 3, '必须 3 真人');
      send(cs[0], { type: 'PLAYER_RESIGN' });
      await Promise.all(cs.map((c) => waitFor(c, 'MATCH_ENDED', 6000)));
      const row = await pollUntil(() => rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId));
      assert.ok(row);
      assert.equal(row.is_ranked, 1, '3 真人 online 局在 beta 关闭时仍计分');
      assert.equal(row.score_policy, LEGACY_POLICY_ID);
      const after = [ratingOf(u1.id), ratingOf(u2.id), ratingOf(u3.id)];
      const deltas = after.map((v, i) => v - before[i]).sort((a, b) => a - b);
      observed.j2_deltas = deltas;
      assert.deepEqual(deltas, [-10, 30, 30], 'legacy 过渡口径：退出者 -10、两名胜者 +30');
    } finally { cs.forEach(close); await sleep(250); }
  });

  await check('J3 重复对手保护在真实流程中生效：第 4 局被判定为 REPEAT_OPPONENTS', async () => {
    const ids = [
      (await registerUser('RepA')).id,
      (await registerUser('RepB')).id,
      (await registerUser('RepC')).id,
    ];
    const now = Date.now();
    // 直接构造 3 条已结算记录（同一三人组合）
    for (let i = 0; i < 3; i++) {
      const gid = 'rep-' + i;
      const plan = buildSettlement({
        gameId: gid, mode: 'online', boardSize: 13, status: 'won', boardWinner: 'A', endReason: 'NORMAL_WIN', isRanked: true,
        participants: [
          { seat: 'A', kind: 'human', userId: ids[0] },
          { seat: 'B', kind: 'human', userId: ids[1] },
          { seat: 'C', kind: 'human', userId: ids[2] },
        ],
      });
      db.settleMatch({ ...plan, matchId: randomUUID(), movesJson: '[]', players: ids });
    }
    const n = db.countRecentMatchesForUsers(ids, now - 24 * 3600 * 1000);
    observed.j3_count = n;
    assert.equal(n, 3, '应统计到同一三人组合的 3 局');
    const policy = resolveRatingPolicy(eligibility({ sameTrioMatchNumber: n + 1 }));
    assert.equal(policy, NO_RATING_POLICY_ID, '第 4 局必须不计竞技分');
    // 24 小时窗口外不计入
    assert.equal(db.countRecentMatchesForUsers(ids, now + 3600 * 1000), 0, '窗口之后应清零');
  });

  await check('J4 排行榜过滤合成/测试/演示账号（规格 4.1）', async () => {
    const human = await registerUser('LbHuman');
    const demo = await registerUser('LbDemo');
    db.setUserSource(demo.id, 'TEST');
    db.raw.prepare('UPDATE users SET rating = 9999 WHERE id = ?').run(demo.id);
    assert.equal(db.getUserSource(demo.id), 'TEST');
    assert.equal(db.getUserSource(human.id), 'HUMAN', '老用户默认 HUMAN，不被误判');
    const list = await api('GET', '/api/ranking');
    assert.equal(list.status, 200);
    const ids = list.json.ranking.map((x: any) => x.id);
    observed.j4_topRating = list.json.ranking[0]?.rating;
    assert.ok(!ids.includes(demo.id), 'TEST 账号不得出现在公开排行榜');
    assert.ok(list.json.ranking.every((x: any) => x.rating < 9999), '排行榜不得泄露演示账号的分数');
  });

  await check('J5 legacy 分差函数仍可用于历史对账（规格 4.1：旧分只读保留）', async () => {
    const d = computeLegacyDeltas([
      { seat: 'A', userId: 'a', rating: 1200, outcome: 'WIN' },
      { seat: 'B', userId: 'b', rating: 1200, outcome: 'LOSS' },
      { seat: 'C', userId: 'c', rating: 1200, outcome: 'DRAW' },
    ]);
    assert.deepEqual(d.map((x) => x.delta), [30, -10, 0]);
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  await new Promise<void>((r) => apiServer.close(() => r()));
  await new Promise<void>((r) => wsHttp.close(() => r()));
  await gs.aiHost.close();
  db.close();
  if (failures === 0) console.log('RATING POLICY: ALL PASS 0');
  else console.log('RATING POLICY: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
