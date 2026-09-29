/**
 * SRSZQ P0A —— 可信结果与事务结算测试（真实 HTTP + 真实 WebSocket + 真实 SQLite）
 *   npm run test:results
 *
 * 本套件针对的是**本轮新增**的产品化实现，与历史 149 项基线测试分开记录。
 *
 * 覆盖（每条都查实际数据库行与真实广播，不 mock 返回值）：
 *  A 纯模型：成四 / AI 胜 / 平局 / 系统中止 / 宽限期不被连坐 / 开关严格解析
 *  B 真实库：原子落库、100 次重复终局只结算一次、故障注入回滚、迁移可重复执行
 *  C 真实 WS：3H 成四、主动退出、宽限期内不被提前判负、广播与库内行逐字一致
 *
 * 退出码：0 = 全部通过；1 = 存在失败（由 scripts/product/run-tests.mjs 汇总）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer } from '../src/ws/gameServer.js';
import { getLegalMoves, currentPlayerOf } from '../../shared/src/game/legalMoves.js';
import { applyMove, createInitialState } from '../../shared/src/game/rules.js';
import { buildSettlement, settlementDigest } from '../../shared/src/product/resultModel.js';
import { parseFeatureFlags, featureFlagEvidence } from '../../shared/src/config/featureFlags.js';
import { PROTOCOL_VERSION, RULESET_VERSION } from '../../shared/src/product/protocol.js';

let db: Db;
let apiBase = '';
let wsBase = '';
let failures = 0;
const observed = { terminated: 0, aiBoardWins: 0, humanBoardWins: 0, draws: 0 };

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try {
    await fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    const detail = e instanceof Error ? e.message + ' :: ' + (String(e.stack).split('\n')[1] ?? '') : String(e);
    console.log('FAIL  ' + name + '  [' + detail + ']');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 真实 HTTP / WS 客户端（与基线测试同一风格） ---------------- */

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

interface TestClient { ws: WebSocket; msgs: Array<{ type: string; [k: string]: any }>; }

/** P0B：每个连接最近一次看到的服务器 revision（game.start / game.state / ack）。 */
const clientRevisions = new WeakMap<TestClient, number>();

function connect(token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '?token=' + token + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
    const msgs: TestClient['msgs'] = [];
    const client: TestClient = { ws, msgs };
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (typeof m.revision === 'number') clientRevisions.set(client, m.revision);
      msgs.push(m);
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

const send = (c: TestClient, msg: unknown) => c.ws.send(JSON.stringify(msg));
const close = (c: TestClient) => { try { c.ws.close(); } catch { /* noop */ } };

async function waitFor(c: TestClient, type: string, timeoutMs = 6000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const idx = c.msgs.findIndex((m) => m.type === type);
    if (idx >= 0) return c.msgs.splice(idx, 1)[0];
    await sleep(20);
  }
  throw new Error('timeout waiting ' + type + '; got ' + c.msgs.map((m) => m.type).join(','));
}

async function pollUntil<T>(fn: () => T | null | undefined, timeoutMs = 5000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(30);
  }
  return null;
}

function rawRow(sql: string, ...args: unknown[]): any {
  return db.raw.prepare(sql).get(...(args as never[])) ?? null;
}
function countOf(table: string, gameId: string): number {
  return Number((rawRow('SELECT COUNT(*) AS n FROM ' + table + ' WHERE game_id = ?', gameId) as any)?.n ?? 0);
}
function ratingOf(userId: string): number {
  return Number((rawRow('SELECT rating FROM users WHERE id = ?', userId) as any)?.rating ?? -1);
}
async function registerUser(name: string) {
  const r = await api('POST', '/api/register', {
    email: name.toLowerCase() + '@test.local', username: name, password: 'Passw0rd!23',
  });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name };
}
function seedUser(id: string, rating = 1200): void {
  db.raw.prepare('INSERT OR IGNORE INTO users (id,email,username,avatar,password_hash,salt,created_at,online_status,rating) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, id + '@seed.local', id, '', 'x', 'y', Date.now(), 'offline', rating);
  db.raw.prepare('INSERT OR IGNORE INTO ranking (user_id,wins,games,score) VALUES (?,0,0,0)').run(id);
}

/* ---------------- 故障注入：包装真实 Db，只在 settleMatch 上注入 ---------------- */

function dbWithSettleFaults(real: Db, failCount: number): Db {
  let remaining = failCount;
  return new Proxy(real, {
    get(target, prop, recv) {
      if (prop === 'settleMatch') {
        return (input: any) => {
          if (remaining > 0) { remaining -= 1; throw new Error('INJECTED_SETTLE_FAILURE'); }
          return target.settleMatch(input);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Db;
}

/* ---------------- 用共享引擎造出真实终局状态 ---------------- */

function playRealGame(boardSize: 13 | 17, seed: number) {
  let state = createInitialState(boardSize);
  let s = seed >>> 0;
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  let guard = 0;
  while (state.status === 'playing' && guard < 400) {
    guard += 1;
    const legal = getLegalMoves(state);
    if (legal.length === 0) break;
    const m = legal[Math.floor(rand() * legal.length)];
    const res = applyMove(state, m.row, m.col);
    if (res.rejected) break;
    state = res.state;
  }
  return state;
}

const HUMAN3 = [
  { seat: 'A' as const, kind: 'human' as const, userId: 'u-a' },
  { seat: 'B' as const, kind: 'human' as const, userId: 'u-b' },
  { seat: 'C' as const, kind: 'human' as const, userId: 'u-c' },
];
const MIXED3 = [
  { seat: 'A' as const, kind: 'human' as const, userId: 'u-a' },
  { seat: 'B' as const, kind: 'ai' as const, userId: null },
  { seat: 'C' as const, kind: 'human' as const, userId: 'u-c' },
];

/* =========================== 主流程 =========================== */

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-results-'));
  db = openDb(join(dir, 'test.sqlite'));

  const wsHttp = createServer();
  const gs = new GameServer(db, {
    queueTimeoutMs: 300, aiMoveDelayMs: 8, disconnectSkipMs: 200,
    aiTimeBudgetMs: 40, inviteGatherMs: 400, forfeitGraceMs: 900, queueSweepMs: 20,
    settlementMaxAttempts: 3,
  });
  gs.attach(wsHttp, '/ws');
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', r));
  wsBase = 'ws://127.0.0.1:' + (wsHttp.address() as AddressInfo).port + '/ws';

  const { server: apiServer } = createApi(db, {
    onInviteCreated: (x, y) => gs.registerInvitation(x, y),
    onInviteAccepted: (x, y) => gs.handleInviteAccept(x, y),
    onInviteRejected: (x, y) => gs.onInviteRejected(x, y),
  });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;

  console.log('--- A 纯模型（服务器结算语义，无 IO） ---');

  await check('A1 真平局：全员 DRAW，无 LOSS，零积分变化', async () => {
    const plan = buildSettlement({ gameId: 'g-draw', mode: 'online', boardSize: 13, status: 'draw', boardWinner: null, endReason: 'BOARD_DRAW', isRanked: true, participants: HUMAN3 });
    assert.deepEqual(plan.participants.map((x) => x.outcome), ['DRAW', 'DRAW', 'DRAW'], '平局不得出现 LOSS');
    assert.equal(plan.winnerSeat, null);
    assert.deepEqual(plan.winnerUserIds, []);
    assert.deepEqual(plan.loserIds, [], '平局不得有人进 loser_ids');
    assert.ok(plan.participants.every((x) => x.ratingDelta === 0), '平局不产生积分变化');
    assert.equal(plan.endReason, 'BOARD_DRAW');
  });

  await check('A2 AI 成四：保留获胜棋色，winnerUserIds 为空是正常情况', async () => {
    const plan = buildSettlement({ gameId: 'g-ai', mode: 'online', boardSize: 13, status: 'won', boardWinner: 'B', endReason: 'NORMAL_WIN', isRanked: true, participants: MIXED3 });
    assert.equal(plan.winnerSeat, 'B', 'AI 获胜必须保留获胜棋色');
    assert.deepEqual(plan.winnerUserIds, [], '没有真人胜者 -> winnerUserIds 为空');
    const aiSeat = plan.participants.find((x) => x.seat === 'B')!;
    assert.equal(aiSeat.outcome, 'WIN');
    assert.equal(aiSeat.ratingDelta, 0, 'AI 永不计分');
    assert.deepEqual([...plan.loserIds].sort(), ['u-a', 'u-c'], '两名真人均为败者');
    assert.ok(plan.participants.filter((x) => x.outcome === 'LOSS').every((x) => x.ratingDelta === -10));
  });

  await check('A3 真人成四：胜者 +30，其余 -10，摘要可绑定证据', async () => {
    const plan = buildSettlement({ gameId: 'g-win', mode: 'online', boardSize: 13, status: 'won', boardWinner: 'A', endReason: 'NORMAL_WIN', isRanked: true, participants: HUMAN3 });
    assert.equal(plan.winnerSeat, 'A');
    assert.deepEqual(plan.winnerUserIds, ['u-a']);
    assert.deepEqual([...plan.loserIds].sort(), ['u-b', 'u-c']);
    assert.equal(plan.participants.find((x) => x.seat === 'A')!.ratingDelta, 30);
    assert.equal(settlementDigest(plan).length, 32);
    assert.equal(settlementDigest(plan), settlementDigest({ ...plan }), '同输入同摘要');
  });

  await check('A4 系统中止：全员 VOID，零竞技变更', async () => {
    const plan = buildSettlement({ gameId: 'g-abort', mode: 'online', boardSize: 13, status: 'playing', boardWinner: null, endReason: 'SYSTEM_ABORT', isRanked: true, participants: HUMAN3 });
    assert.deepEqual(plan.participants.map((x) => x.outcome), ['VOID', 'VOID', 'VOID']);
    assert.deepEqual(plan.winnerUserIds, []);
    assert.deepEqual(plan.loserIds, []);
    assert.ok(plan.participants.every((x) => x.ratingDelta === 0), '中止不得扣分');
  });

  await check('A5 断线宽限：仍在自身宽限期的玩家记 VOID，不被别人的超时连坐', async () => {
    const plan = buildSettlement({
      gameId: 'g-grace', mode: 'online', boardSize: 13, status: 'playing', boardWinner: null,
      endReason: 'PLAYER_DISCONNECT', isRanked: true,
      participants: [
        { seat: 'A', kind: 'human', userId: 'u-a', forfeited: true },
        { seat: 'B', kind: 'human', userId: 'u-b' },
        { seat: 'C', kind: 'human', userId: 'u-c', inGrace: true },
      ],
    });
    assert.equal(plan.participants.find((x) => x.seat === 'A')!.outcome, 'LOSS', '已越过自身截止者判负');
    assert.equal(plan.participants.find((x) => x.seat === 'C')!.outcome, 'VOID', '仍在宽限期内者不得被提前判负');
    assert.equal(plan.participants.find((x) => x.seat === 'C')!.ratingDelta, 0, '宽限期内不扣分');
    assert.equal(plan.participants.find((x) => x.seat === 'B')!.outcome, 'WIN');
    assert.deepEqual(plan.loserIds, ['u-a'], 'loser_ids 只能包含真正越期者');
  });

  await check('A6 功能开关：默认关闭，解析严格，且服务端实际值可核验', async () => {
    assert.equal(parseFeatureFlags({}).ratingBeta, false, '未配置 -> Rating Beta 关闭');
    assert.equal(parseFeatureFlags({}).invitusShadow, false, '未配置 -> Invitus shadow 关闭');
    for (const v of ['false', '0', 'off', 'no', 'garbage', '']) {
      assert.equal(parseFeatureFlags({ SRSZQ_RATING_BETA: v }).ratingBeta, false, 'input=' + v);
    }
    assert.equal(parseFeatureFlags({ SRSZQ_RATING_BETA: ' TRUE ' }).ratingBeta, true);
    assert.equal(parseFeatureFlags({ SRSZQ_RATING_BETA: '1' }).ratingBeta, true);
    const ev = featureFlagEvidence({ SRSZQ_RATING_BETA: '1' });
    assert.equal(ev.find((x) => x.key === 'ratingBeta')!.rawValue, '1');
    assert.equal(ev.find((x) => x.key === 'invitusShadow')!.isDefault, true);
    const live = await api('GET', '/api/config/features');
    assert.equal(live.status, 200);
    assert.equal(live.json.flags.ratingBeta, false, '运行中的服务端必须报告 OFF');
    assert.equal(live.json.flags.invitusShadow, false, '运行中的服务端必须报告 OFF');
    assert.equal(live.json.scorePolicy, 'legacy-online-v1');
  });

  console.log('--- B 真实 SQLite：原子、幂等、回滚、迁移 ---');

  for (const id of ['u-a', 'u-b', 'u-c']) seedUser(id);

  await check('B1 原子落库：结果 + 参与者 + 账本 + 评分在同一事务内一致', async () => {
    const gameId = 'g-db-1';
    const plan = buildSettlement({ gameId, mode: 'online', boardSize: 13, status: 'won', boardWinner: 'A', endReason: 'NORMAL_WIN', isRanked: true, participants: HUMAN3 });
    const before = { a: ratingOf('u-a'), b: ratingOf('u-b'), c: ratingOf('u-c') };
    const settled = db.settleMatch({ ...plan, matchId: randomUUID(), movesJson: '[]', players: ['u-a', 'u-b', 'u-c'] });
    assert.equal(settled.alreadySettled, false);
    assert.equal(countOf('match_results', gameId), 1);
    assert.equal(countOf('match_participants', gameId), 3);
    assert.equal(countOf('rating_ledger', gameId), 3, '三名真人各一条账本');
    const row = rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId);
    assert.equal(row.winner_seat, 'A');
    assert.deepEqual(JSON.parse(row.winner_user_ids), ['u-a']);
    assert.equal(row.is_ranked, 1);
    assert.equal(row.settlement_digest, settled.digest);
    assert.equal(ratingOf('u-a'), before.a + 30);
    assert.equal(ratingOf('u-b'), before.b - 10);
    assert.equal(ratingOf('u-c'), before.c - 10);
    for (const e of db.listRatingLedger(gameId)) {
      assert.equal(e.ratingAfter - e.ratingBefore, e.delta, '账本 before/after 必须自洽');
      assert.equal(e.policy, 'legacy-online-v1');
    }
    const legacy = rawRow('SELECT * FROM matches WHERE game_id = ?', gameId);
    assert.ok(legacy, '历史 matches 行保留以兼容既有查询');
    assert.equal(legacy.end_reason, 'NORMAL_WIN');
    assert.deepEqual(db.listMatchParticipants(gameId).map((x) => x.outcome), ['WIN', 'LOSS', 'LOSS']);
  });

  await check('B2 重复终局 100 次：同一结果，不额外写统计/账本', async () => {
    const gameId = 'g-db-repeat';
    const plan = buildSettlement({ gameId, mode: 'online', boardSize: 13, status: 'won', boardWinner: 'A', endReason: 'NORMAL_WIN', isRanked: true, participants: HUMAN3 });
    const first = db.settleMatch({ ...plan, matchId: randomUUID(), movesJson: '[]', players: ['u-a', 'u-b', 'u-c'] });
    const snapshot = { a: ratingOf('u-a'), b: ratingOf('u-b'), c: ratingOf('u-c') };
    const gamesBefore = Number((rawRow('SELECT games FROM ranking WHERE user_id = ?', 'u-a') as any).games);
    const digests = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = db.settleMatch({ ...plan, matchId: randomUUID(), movesJson: '[]', players: ['u-a', 'u-b', 'u-c'] });
      assert.equal(r.alreadySettled, true, '第 ' + (i + 1) + ' 次必须命中已结算');
      digests.add(r.digest);
    }
    assert.equal(digests.size, 1, '100 次必须返回同一个结果摘要');
    assert.equal(first.digest, [...digests][0]);
    assert.equal(countOf('match_results', gameId), 1, '结果表恰好一行');
    assert.equal(countOf('match_participants', gameId), 3, '参与者表恰好三行');
    assert.equal(countOf('rating_ledger', gameId), 3, '账本恰好三行');
    assert.equal(Number((rawRow('SELECT COUNT(*) AS n FROM games WHERE id = ?', gameId) as any).n), 1);
    assert.equal(Number((rawRow('SELECT COUNT(*) AS n FROM matches WHERE game_id = ?', gameId) as any).n), 1);
    assert.deepEqual([ratingOf('u-a'), ratingOf('u-b'), ratingOf('u-c')], [snapshot.a, snapshot.b, snapshot.c], '评分不得二次变化');
    assert.equal(Number((rawRow('SELECT games FROM ranking WHERE user_id = ?', 'u-a') as any).games), gamesBefore, 'games 计数不得重复累加');
  });

  await check('B3 数据库失败注入：整笔回滚，无半份结果；恢复后一次重试成功', async () => {
    const gameId = 'g-db-fail';
    seedUser('u-fail');
    const before = ratingOf('u-fail');
    const plan = buildSettlement({
      gameId, mode: 'online', boardSize: 13, status: 'won', boardWinner: 'A', endReason: 'NORMAL_WIN', isRanked: true,
      participants: [
        { seat: 'A', kind: 'human', userId: 'u-fail' },
        { seat: 'B', kind: 'ai', userId: null },
        { seat: 'C', kind: 'ai', userId: null },
      ],
    });
    const poisoned = {
      ...plan,
      matchId: randomUUID(), movesJson: '[]', players: ['u-fail', null, null],
      participants: [...plan.participants, { seat: 'Z', kind: 'human', userId: 'u-fail', outcome: 'BOGUS', ratingDelta: 0 }],
    } as any;
    assert.throws(() => db.settleMatch(poisoned), '非法名次必须触发 CHECK 约束并抛出');
    assert.equal(countOf('match_results', gameId), 0, '回滚：结果表不得留下半份');
    assert.equal(countOf('match_participants', gameId), 0, '回滚：参与者表必须为空');
    assert.equal(countOf('rating_ledger', gameId), 0, '回滚：账本必须为空');
    assert.equal(Number((rawRow('SELECT COUNT(*) AS n FROM games WHERE id = ?', gameId) as any).n), 0, '回滚：games 不得留下行');
    assert.equal(Number((rawRow('SELECT COUNT(*) AS n FROM matches WHERE game_id = ?', gameId) as any).n), 0, '回滚：matches 不得留下行');
    assert.equal(ratingOf('u-fail'), before, '评分不得变化');
    const ok = db.settleMatch({ ...plan, matchId: randomUUID(), movesJson: '[]', players: ['u-fail', null, null] });
    assert.equal(ok.alreadySettled, false, '恢复后一次重试必须成功');
    assert.equal(countOf('match_results', gameId), 1);
    assert.equal(ratingOf('u-fail'), before + 30);
  });

  await check('B5 真实引擎终局 + 真实库：AI 棋色落盘，winnerUserId 为空', async () => {
    // 用共享引擎真实下完一盘，得到**真实**的成四终局（不是编造的棋盘）。
    let state = playRealGame(13, 20260930);
    let attempt = 20260930;
    while (state.status !== 'won' && attempt < 20260930 + 40) {
      attempt += 1;
      state = playRealGame(13, attempt);
    }
    assert.equal(state.status, 'won', '共享引擎必须在若干次尝试内产生真实成四终局');
    assert.ok(state.winner, '真实终局必须带获胜棋色');
    assert.ok(Array.isArray(state.winLine) && state.winLine.length >= 4, '获胜必须由 >=4 连子构成');
    const winnerSeat = state.winner as 'A' | 'B' | 'C';
    const humanSeats = (['A', 'B', 'C'] as const).filter((s) => s !== winnerSeat);
    for (const s of humanSeats) seedUser('u-real-' + s);
    // 把真实获胜座位声明为 AI 座位（房间级事实），其余为真人 —— 正是 1H+2AI 的形态。
    const players: Array<string | null> = ['A', 'B', 'C'].map((s) => (s === winnerSeat ? null : 'u-real-' + s));
    const before = humanSeats.map((s) => ratingOf('u-real-' + s));
    const plan = buildSettlement({
      gameId: 'g-real-engine', mode: 'online', boardSize: 13, status: 'won', boardWinner: winnerSeat,
      endReason: 'NORMAL_WIN', isRanked: true,
      participants: (['A', 'B', 'C'] as const).map((s) =>
        s === winnerSeat
          ? { seat: s, kind: 'ai' as const, userId: null }
          : { seat: s, kind: 'human' as const, userId: 'u-real-' + s }),
    });
    const settled = db.settleMatch({ ...plan, matchId: randomUUID(), movesJson: JSON.stringify(state.moves), players });
    assert.equal(settled.alreadySettled, false);
    const row = rawRow('SELECT * FROM match_results WHERE game_id = ?', 'g-real-engine');
    assert.equal(row.winner_seat, winnerSeat, 'AI 成四的获胜棋色必须落盘');
    assert.deepEqual(JSON.parse(row.winner_user_ids), [], '无真人胜者 -> winner_ids 为空');
    assert.deepEqual([...JSON.parse(row.loser_ids)].sort(), humanSeats.map((s) => 'u-real-' + s).sort(), '两名真人均为败者');
    const gamesRow = rawRow('SELECT * FROM games WHERE id = ?', 'g-real-engine');
    const moves = JSON.parse(gamesRow.moves_json) as unknown[];
    assert.equal(moves.length, state.moves.length, '真实棋谱必须完整落盘');
    const parts = db.listMatchParticipants('g-real-engine');
    assert.equal(parts.find((x) => x.seat === winnerSeat)!.kind, 'ai');
    assert.equal(parts.find((x) => x.seat === winnerSeat)!.ratingDelta, 0, 'AI 不计分');
    humanSeats.forEach((s, i) => {
      assert.equal(ratingOf('u-real-' + s), before[i] - 10, '每名真人扣 10');
    });
    // 幂等：再次提交同一真实终局不得二次入账
    const again = db.settleMatch({ ...plan, matchId: randomUUID(), movesJson: JSON.stringify(state.moves), players });
    assert.equal(again.alreadySettled, true);
    assert.equal(countOf('rating_ledger', 'g-real-engine'), 2);
  });

  await check('B4 迁移可重复执行：重开库两次，schema 齐备且历史评分/战绩不被重置', async () => {
    const migratePath = join(dir, 'migration.sqlite');
    const first = openDb(migratePath);
    first.raw.prepare('INSERT INTO users (id,email,username,avatar,password_hash,salt,created_at,online_status,rating) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('legacy-1', 'legacy@x.local', 'Legacy', '', 'h', 's', Date.now(), 'offline', 1487);
    first.raw.prepare('INSERT INTO ranking (user_id,wins,games,score) VALUES (?,?,?,?)').run('legacy-1', 7, 11, 210);
    first.close();
    for (let round = 1; round <= 2; round++) {
      const again = openDb(migratePath);
      for (const t of ['match_results', 'match_participants', 'rating_ledger', 'matches', 'games', 'users', 'ranking']) {
        assert.ok(again.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), 'round ' + round + ' 缺表 ' + t);
      }
      assert.equal(Number((again.raw.prepare('SELECT rating FROM users WHERE id = ?').get('legacy-1') as any).rating), 1487, 'round ' + round + ' 不得重置历史评分');
      const rk = again.raw.prepare('SELECT wins,games,score FROM ranking WHERE user_id = ?').get('legacy-1') as any;
      assert.deepEqual([rk.wins, rk.games, rk.score], [7, 11, 210], 'round ' + round + ' 不得重置历史战绩');
      again.close();
    }
  });

  console.log('--- C 真实 WebSocket 端到端（真库 + 真广播） ---');

  /** 在自己回合用共享引擎随机落一个合法点（只对未处理过的局面出手，避免重复提交）。 */
  function maybeAct(cl: TestClient, seat: string, state: any, actedAt: Map<TestClient, number>): void {
    if (!state || state.status !== 'playing') return;
    if (currentPlayerOf(state) !== seat) return;
    if (actedAt.get(cl) === state.moves.length) return;
    actedAt.set(cl, state.moves.length);
    const legal = getLegalMoves(state);
    if (legal.length === 0) return;
    const m = legal[Math.floor(Math.random() * legal.length)];
    // P0B 命令信封：commandId 幂等键 + 当前 revision
    send(cl, { type: 'move', commandId: randomUUID(), expectedRevision: clientRevisions.get(cl) ?? 0, row: m.row, col: m.col });
  }

  /**
   * 让每个客户端把自己那一步走完，直到真实终局。
   * 关键点：开局状态在 game.start 里，不是 game.state；只监听 game.state 会让先手玩家
   * 一直不动，最终以 30 秒落子超时收场（那是驱动缺陷，不是产品行为）。
   */
  async function driveToEnd(
    clients: TestClient[],
    seatOfClient: Map<TestClient, string>,
    initial: Array<{ state: any }>,
    capMs: number,
  ): Promise<any | null> {
    const actedAt = new Map<TestClient, number>();
    clients.forEach((cl, i) => maybeAct(cl, seatOfClient.get(cl)!, initial[i]?.state, actedAt));
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      for (const cl of clients) {
        const ei = cl.msgs.findIndex((m) => m.type === 'game.end' || m.type === 'MATCH_ENDED');
        if (ei >= 0) return cl.msgs.splice(ei, 1)[0];
      }
      for (const cl of clients) {
        let si = cl.msgs.findIndex((m) => m.type === 'game.state');
        while (si >= 0) {
          const msg = cl.msgs.splice(si, 1)[0];
          maybeAct(cl, seatOfClient.get(cl)!, msg.state, actedAt);
          si = cl.msgs.findIndex((m) => m.type === 'game.state');
        }
      }
      await sleep(5);
    }
    return null;
  }

  const a = await registerUser('RA');
  const b = await registerUser('RB');
  const c = await registerUser('RC');

  await check('C1 3H 真实成四/平局：广播的胜负与库内已提交行逐字一致', async () => {
    const clients = [await connect(a.token), await connect(b.token), await connect(c.token)];
    try {
      for (const cl of clients) send(cl, { type: 'queue.join' });
      const starts = await Promise.all(clients.map((cl) => waitFor(cl, 'game.start', 5000)));
      const gameId = starts[0].gameId as string;
      assert.ok(starts.every((s) => s.gameId === gameId), '三名真人必须进同一房间');
      const seatOfClient = new Map<TestClient, string>();
      starts.forEach((s, i) => seatOfClient.set(clients[i], s.yourSeat as string));
      assert.equal(new Set(seatOfClient.values()).size, 3, '座位必须是 A/B/C 各一');
      const end = await driveToEnd(clients, seatOfClient, starts, 90000);
      assert.ok(end, '3H 对局必须在 90 秒内到达真实终局');
      assert.ok(
        end.reason === 'NORMAL_WIN' || end.reason === 'BOARD_DRAW',
        '3H 必须由棋盘产生真实终局（成四或满盘平局），实际 reason=' + end.reason,
      );
      observed.terminated += 1;
      const row = await pollUntil(() => rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId));
      assert.ok(row, 'match_results 必须落盘');
      assert.equal(row.end_reason, end.reason, '库内 end_reason 必须等于广播 reason');
      assert.equal(row.winner_seat ?? null, end.winnerSeat ?? null, '库内棋色必须等于广播棋色');
      assert.deepEqual(JSON.parse(row.winner_user_ids), end.winnerIds);
      assert.deepEqual(JSON.parse(row.loser_ids), end.loserIds);
      const parts = db.listMatchParticipants(gameId);
      assert.equal(parts.length, 3, '三名真人各一行参与者');
      const bcastOutcomes = (end.participants as any[]).map((x) => x.seat + ':' + x.outcome).sort();
      const dbOutcomes = parts.map((x) => x.seat + ':' + x.outcome).sort();
      assert.deepEqual(bcastOutcomes, dbOutcomes, '广播名次必须逐字等于库内行（不得广播未提交的成功）');
      if (end.reason === 'BOARD_DRAW') {
        observed.draws += 1;
        assert.deepEqual(parts.map((x) => x.outcome), ['DRAW', 'DRAW', 'DRAW'], '真平局不得有人记 LOSS');
        assert.deepEqual(parts.map((x) => x.ratingDelta), [0, 0, 0], '平局不得扣分');
      } else if (end.reason === 'NORMAL_WIN') {
        const winnerPart = parts.find((x) => x.seat === end.winnerSeat);
        assert.ok(winnerPart, 'NORMAL_WIN 必须能定位获胜座位');
        if (winnerPart!.kind === 'ai') {
          observed.aiBoardWins += 1;
          assert.ok(end.winnerSeat, 'AI 成四必须保留获胜棋色');
          assert.deepEqual(end.winnerIds, [], 'AI 获胜时不得有真人 winnerIds');
          assert.equal(winnerPart!.ratingDelta, 0, 'AI 不计分');
        } else {
          observed.humanBoardWins += 1;
          assert.equal(end.winnerIds.length, 1, '真人成四恰好一名真人胜者');
          assert.equal(winnerPart!.ratingDelta, 30);
        }
      }
      for (const e of db.listRatingLedger(gameId)) {
        assert.equal(e.ratingAfter - e.ratingBefore, e.delta, '真实对局的账本也必须自洽');
      }
      assert.equal(countOf('rating_ledger', gameId), parts.filter((x) => x.kind === 'human').length, '每名真人恰好一条账本');
    } finally {
      clients.forEach(close);
      await sleep(250);
    }
  });

  await check('C2 3H 主动退出：只有退出者判负，胜负/座位与库内一致', async () => {
    const clients = [await connect(a.token), await connect(b.token), await connect(c.token)];
    try {
      for (const cl of clients) send(cl, { type: 'queue.join' });
      const starts = await Promise.all(clients.map((cl) => waitFor(cl, 'game.start', 5000)));
      const gameId = starts[0].gameId as string;
      const leaverSeat = starts[0].yourSeat as string;
      send(clients[0], { type: 'PLAYER_RESIGN' });
      const ends = await Promise.all(clients.map((cl) => waitFor(cl, 'MATCH_ENDED', 5000)));
      assert.ok(ends.every((e) => e.reason === 'PLAYER_FORFEIT'));
      assert.deepEqual(ends[0].loserSeats, [leaverSeat], '只有退出者判负');
      assert.equal(ends[0].winnerSeats.length, 2, '其余两名真人获胜');
      const row = await pollUntil(() => rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId));
      assert.ok(row);
      assert.equal(row.end_reason, 'PLAYER_FORFEIT');
      assert.equal(row.winner_seat, null, '两名胜者 -> 无单一获胜棋色');
      assert.deepEqual(JSON.parse(row.loser_ids), [ends[0].loserIds[0]]);
      const parts = db.listMatchParticipants(gameId);
      assert.equal(parts.filter((x) => x.outcome === 'WIN').length, 2);
      assert.equal(parts.filter((x) => x.outcome === 'LOSS').length, 1);
      assert.equal(parts.filter((x) => x.outcome === 'VOID').length, 0);
    } finally {
      clients.forEach(close);
      await sleep(250);
    }
  });

  await check('C3 断线宽限：仍在自身宽限期的玩家记 VOID，评分不变', async () => {
    const victim = await registerUser('RVictim');
    const resigner = await registerUser('RResigner');
    const other = await registerUser('ROther');
    const cv = await connect(victim.token);
    const cr = await connect(resigner.token);
    const co = await connect(other.token);
    try {
      for (const cl of [cv, cr, co]) send(cl, { type: 'queue.join' });
      const starts = await Promise.all([cv, cr, co].map((cl) => waitFor(cl, 'game.start', 5000)));
      const gameId = starts[0].gameId as string;
      const victimSeat = starts[0].yourSeat as string;
      const victimRatingBefore = ratingOf(victim.id);
      close(cv); // 掉线 -> 进入 900ms 宽限
      const disc = await waitFor(co, 'player.status', 4000);
      assert.equal(disc.status, 'disconnected', '服务器必须已登记掉线并开始宽限');
      assert.equal(disc.seat, victimSeat);
      send(cr, { type: 'PLAYER_RESIGN' }); // 在受害者自己的截止之前结束对局
      const [er, eo] = await Promise.all([waitFor(cr, 'MATCH_ENDED', 5000), waitFor(co, 'MATCH_ENDED', 5000)]);
      assert.equal(er.reason, 'PLAYER_FORFEIT');
      const row = await pollUntil(() => rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId));
      assert.ok(row);
      const parts = db.listMatchParticipants(gameId);
      const victimPart = parts.find((x) => x.seat === victimSeat)!;
      assert.equal(victimPart.outcome, 'VOID', '仍在宽限期内者不得被别人的超时提前判负');
      assert.equal(victimPart.ratingDelta, 0, '宽限期内不扣分');
      assert.equal(ratingOf(victim.id), victimRatingBefore, '受害者评分必须保持不变');
      assert.equal(countOf('rating_ledger', gameId), 2, '只有两名到期/在场者写账本');
      assert.ok(!JSON.parse(row.loser_ids).includes(victim.id), '受害者不得进入 loser_ids');
      assert.ok(er);
      void eo;
    } finally {
      [cv, cr, co].forEach(close);
      await sleep(250);
    }
  });

  await check('C4 服务端结算失败：不广播成功，房间保留；重试后正确完成', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'srszq-fault-'));
    const realDb = openDb(join(dir2, 'fault.sqlite'));
    const uid = 'fault-user-1';
    realDb.raw.prepare('INSERT INTO users (id,email,username,avatar,password_hash,salt,created_at,online_status,rating,tutorial_completed) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid, 'fault@x.local', 'Faulty', '', 'h', 's', Date.now(), 'online', 1200, 1);
    realDb.raw.prepare('INSERT INTO ranking (user_id,wins,games,score) VALUES (?,0,0,0)').run(uid);
    const faultToken = 'fault-token-1';
    realDb.createSession(faultToken, uid, Date.now() + 3600_000);

    // 前 3 次 settleMatch 调用（== settlementMaxAttempts）全部注入失败
    const faulty = dbWithSettleFaults(realDb, 3);
    const http2 = createServer();
    const gs2 = new GameServer(faulty, {
      queueTimeoutMs: 120, aiMoveDelayMs: 5, forfeitGraceMs: 500, aiTimeBudgetMs: 30,
      queueSweepMs: 20, settlementMaxAttempts: 3,
    });
    gs2.attach(http2, '/ws');
    await new Promise<void>((r) => http2.listen(0, '127.0.0.1', r));
    const base2 = 'ws://127.0.0.1:' + (http2.address() as AddressInfo).port + '/ws';
    const prevWs = wsBase;
    wsBase = base2;
    const cf = await connect(faultToken);
    try {
      send(cf, { type: 'queue.join' });
      const start = await waitFor(cf, 'game.start', 6000);
      const gameId = start.gameId as string;
      send(cf, { type: 'PLAYER_RESIGN' });
      const errMsg: any = await (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          const ei = cf.msgs.findIndex((m) => m.type === 'error');
          if (ei >= 0) return cf.msgs.splice(ei, 1)[0];
          await sleep(20);
        }
        return null;
      })();
      assert.ok(errMsg, '结算失败必须显式告知客户端，而不是静默或假成功');
      assert.equal(errMsg.error, 'settlement_failed');
      assert.equal(errMsg.retryable, true);
      assert.equal(cf.msgs.some((m) => m.type === 'MATCH_ENDED' || m.type === 'game.end'), false, '失败时不得广播“已结算”');
      assert.equal(Number((realDb.raw.prepare('SELECT COUNT(*) AS n FROM match_results WHERE game_id = ?').get(gameId) as any).n), 0, '失败后库内不得有结果行');
      assert.equal(Number((realDb.raw.prepare('SELECT COUNT(*) AS n FROM match_participants WHERE game_id = ?').get(gameId) as any).n), 0);
      assert.equal(Number((realDb.raw.prepare('SELECT COUNT(*) AS n FROM rating_ledger WHERE game_id = ?').get(gameId) as any).n), 0);
      assert.equal(Number((realDb.raw.prepare('SELECT rating FROM users WHERE id = ?').get(uid) as any).rating), 1200, '失败路径不得改分');
      // 恢复后重试：房间仍存活，同一客户端再次提交终局
      send(cf, { type: 'PLAYER_RESIGN' });
      const ended: any = await waitFor(cf, 'MATCH_ENDED', 6000);
      assert.equal(ended.reason, 'PLAYER_FORFEIT');
      assert.equal(ended.matchId, gameId);
      // 本用例是 1H+2AI 快速局：按规格 4.1/55 不计真人竞技分，
      // 所以「恰好一次结算」的证据落在 match_results / match_participants 上，
      // 而不是账本行数上（账本在快速局必须为空）。
      assert.equal(Number((realDb.raw.prepare('SELECT COUNT(*) AS n FROM match_results WHERE game_id = ?').get(gameId) as any).n), 1, '重试后恰好一条结果');
      assert.equal(Number((realDb.raw.prepare('SELECT COUNT(*) AS n FROM match_participants WHERE game_id = ?').get(gameId) as any).n), 3, '重试后恰好三条参与者行');
      assert.equal(Number((realDb.raw.prepare('SELECT COUNT(*) AS n FROM rating_ledger WHERE game_id = ?').get(gameId) as any).n), 0, '快速局不得写积分账本');
      assert.equal(Number((realDb.raw.prepare('SELECT rating FROM users WHERE id = ?').get(uid) as any).rating), 1200, '快速局重试成功后评分仍不变');
    } finally {
      // 先同步终止套接字再关服务端，避免 GameServer.onClose 仍在飞行时数据库已被关闭
      // （那会以 ERR_INVALID_STATE 直接把测试进程打挂，把真实失败掩盖成崩溃）。
      try { cf.ws.terminate(); } catch { /* noop */ }
      await sleep(300);
      wsBase = prevWs;
      await new Promise<void>((r) => http2.close(() => r()));
      // 故意不关闭 realDb：故障注入服务器的回调可能最后一刻才到；
      // 临时目录在进程退出时回收，测试无需为此引入关闭竞态。
      void realDb;
    }
  });

  await check('C5 好友局全员离开 → SYSTEM_ABORT 落盘，全员 VOID、零竞技变更', async () => {
    const h1 = await registerUser('RAInv1');
    const h2 = await registerUser('RAInv2');
    const ct1 = await connect(h1.token);
    const ct2 = await connect(h2.token);
    try {
      const inv = await api('POST', '/api/invite', { toUsername: h2.username }, h1.token);
      assert.equal(inv.status, 201, JSON.stringify(inv.json));
      const list = await api('GET', '/api/invitations', undefined, h2.token);
      assert.equal(list.json.invitations.length, 1);
      const acc = await api('POST', '/api/invite/accept', { id: list.json.invitations[0].id }, h2.token);
      assert.equal(acc.status, 200);
      const g1 = await waitFor(ct1, 'game.start', 5000);
      await waitFor(ct2, 'game.start', 5000);
      const gameId = g1.gameId as string;
      const r1 = ratingOf(h1.id);
      const r2 = ratingOf(h2.id);
      close(ct1);
      close(ct2);
      const row = await pollUntil(() => rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId), 8000);
      assert.ok(row, '全员离开必须落盘 SYSTEM_ABORT 结果（旧实现完全不写库）');
      assert.equal(row.end_reason, 'SYSTEM_ABORT');
      assert.equal(row.is_ranked, 0, '好友局不是排位对局');
      assert.equal(row.winner_seat, null, '中止不得虚构获胜棋色');
      const parts = db.listMatchParticipants(gameId);
      assert.equal(parts.length, 3, '两个真人 + 一个 AI 补位座位');
      assert.deepEqual(parts.map((x) => x.outcome).sort(), ['VOID', 'VOID', 'VOID'], '系统中止全员 VOID');
      assert.deepEqual(parts.map((x) => x.ratingDelta), [0, 0, 0], '中止不得产生积分变化');
      assert.equal(countOf('rating_ledger', gameId), 0, '中止不写积分账本');
      assert.equal(ratingOf(h1.id), r1, '发起者评分不变');
      assert.equal(ratingOf(h2.id), r2, '接受者评分不变');
    } finally {
      close(ct1);
      close(ct2);
      await sleep(250);
    }
  });
  console.log('--- 本轮观测样本（用于如实报告，不作强度结论） ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  await new Promise<void>((r) => apiServer.close(() => r()));
  await new Promise<void>((r) => wsHttp.close(() => r()));
  db.close();

  if (failures === 0) console.log('RESULTS SETTLEMENT: ALL PASS 0');
  else console.log('RESULTS SETTLEMENT: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
