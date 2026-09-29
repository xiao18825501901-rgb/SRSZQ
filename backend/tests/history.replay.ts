/**
 * SRSZQ P2(B4) —— 棋谱历史 / 全谱重放 / 关键三手解释 / 跨轮防守 / 去标识分享。
 *   npm run test:history   （scripts/product/run-tests.mjs --suite replay 调用）
 *
 * 规格来源：reference_spec/01_PRODUCT_IMPLEMENTATION_SPEC_CN.md 5.1 / 5.2 / 6.1
 * 验收矩阵：R01 历史与分页、R02 全谱重放/分支、R03 关键三手、R04 跨轮防守、
 *           R05 多个好动作、R06 分享与撤销。
 *
 * 本套件刻意打一场**真实脚本对局**（20 手，3 真人 online），而不是构造假棋谱：
 * 关键片段的坐标/执子/胜权必须来自真实引擎与真实持久事件，否则测试就成了自证。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer } from '../src/ws/gameServer.js';
import { PROTOCOL_VERSION, RULESET_VERSION } from '../../shared/src/product/protocol.js';
import {
  replayGame, reviewKeyMoves, stateDigest, threatWindows,
  type PersistedEvent,
} from '../../shared/src/product/replay.js';
import { applyMove, createInitialState } from '../../shared/src/game/rules.js';
import { getLegalMoves } from '../../shared/src/game/legalMoves.js';
import { playerFromTurn } from '../../shared/src/game/eligibility.js';
import type { BoardSize } from '../../shared/src/game/types.js';

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

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

interface TestClient { ws: WebSocket; msgs: Array<{ type: string; [k: string]: any }>; }
function connect(token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '?token=' + token + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
    const msgs: TestClient['msgs'] = [];
    const client: TestClient = { ws, msgs };
    ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw))); });
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
    await sleep(10);
  }
  throw new Error('timeout waiting ' + type + '; got ' + c.msgs.map((m) => m.type).join(','));
}
async function pollUntil<T>(fn: () => T | null | undefined, timeoutMs = 8000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = fn(); if (v) return v; await sleep(25); }
  return null;
}
const rawRow = (sql: string, ...a: unknown[]): any => db.raw.prepare(sql).get(...(a as never[])) ?? null;
async function registerUser(name: string) {
  const r = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name, email: name.toLowerCase() + '@t.local' };
}

/**
 * 20 手脚本对局（三人 online，A/B/C 座位顺序 = 行动顺序）。设计目的：
 *  - ply 16：R6 的 A 占掉 C（本轮胜权持有者）的 (0,0) —— 跨轮遮挡片段；
 *  - ply 18：R6 的 C 手里还有 (0,4) 却下在别处 —— 错失致胜点片段；
 *  - ply 20：R7 的 B 用 (6,4) 真正成四 —— 终局致胜片段。
 * R1–R5 无人有胜权，任何 4 连都属于禁手，因此所有前 15 手都刻意只有 ≤3 连。
 */
const SCRIPT: Array<[number, number]> = [
  [5, 5], [6, 1], [0, 1],
  [10, 10], [6, 2], [0, 2],
  [10, 11], [6, 3], [0, 3],
  [10, 12], [11, 11], [12, 12],
  [5, 6], [11, 12], [12, 11],
  [0, 0], [11, 10], [2, 2],
  [5, 7], [6, 4],
];
const SEATS = ['A', 'B', 'C'] as const;

const sortCells = (cells: Array<{ row: number; col: number }>): number[][] =>
  cells.map((p) => [p.row, p.col]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

/** 确定性 LCG：让长局生成可复现（不用 Math.random，否则预算数字无法复验）。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
}

/**
 * 长棋谱生成器（固定种子，可复现）：每手在**引擎给出的合法手**里按 LCG 选一个，
 * 直到终局或到上限。用来量测重放/跨轮窗口在 17×17 满盘量级上的真实预算，
 * 而不是靠断言“应该很快”。种子 20260930 实测 218 手（约满盘的 75%）。
 */
function longGameEvents(boardSize: BoardSize, seed = 20260930, maxPlies = 600): { events: PersistedEvent[]; plies: number } {
  const rnd = lcg(seed);
  let state = createInitialState(boardSize);
  const events: PersistedEvent[] = [];
  while (state.status === 'playing' && events.length < maxPlies) {
    const legal = getLegalMoves(state);
    if (legal.length === 0) break;
    const pick = legal[rnd() % legal.length];
    const seat = playerFromTurn(state.turnIndex);
    events.push({
      seq: events.length + 1,
      revision: events.length + 1,
      type: 'move.applied',
      payload: { seat, row: pick.row, col: pick.col },
    });
    const res = applyMove(state, pick.row, pick.col);
    assert.equal(res.rejected, undefined, '生成器只能走引擎认可的合法手');
    state = res.state;
  }
  return { events, plies: events.length };
}

/** 独立复核：某玩家在 (row,col) 落子后是否形成 >=4 连（不使用被测模块的胜点函数）。 */
function independentFormsFour(
  board: Array<Array<string | null>>, row: number, col: number, player: string,
): boolean {
  const n = board.length;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as Array<[number, number]>) {
    let run = 1;
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < n && c >= 0 && c < n && board[r][c] === player) { run += 1; r += dr * sign; c += dc * sign; }
    }
    if (run >= 4) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-history-'));
  db = openDb(join(dir, 'test.sqlite'));
  const gs = new GameServer(db, { queueTimeoutMs: 400, aiMoveDelayMs: 5, forfeitGraceMs: 500, aiTimeBudgetMs: 40, queueSweepMs: 20 });
  const wsHttp = createServer();
  gs.attach(wsHttp, '/ws');
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', r));
  wsBase = 'ws://127.0.0.1:' + (wsHttp.address() as AddressInfo).port + '/ws';
  const { server: apiServer } = createApi(db, { onSessionRevoked: (uid, reason) => gs.revokeUserSession(uid, reason) });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;

  const uA = await registerUser('HistA');
  const uB = await registerUser('HistB');
  const uC = await registerUser('HistC');
  const cA = await connect(uA.token);
  const cB = await connect(uB.token);
  const cC = await connect(uC.token);
  const clients = { A: cA, B: cB, C: cC } as const;
  const usersList = [uA, uB, uC] as const;
  const clientOfSeat = {} as Record<'A' | 'B' | 'C', TestClient>;
  const userOfSeat = {} as Record<'A' | 'B' | 'C', typeof uA>;

  let gameId = '';
  let endMsg: any = null;
  try {
    for (const s of SEATS) send(clients[s], { type: 'queue.join' });
    const starts = await Promise.all(SEATS.map((s) => waitFor(clients[s], 'game.start', 12000)));
    gameId = starts[0].gameId as string;
    assert.ok(gameId, '必须拿到 gameId');
    // 座位由服务端分配：从 game.start 的 yourSeat 读回来，而不是假设 join 顺序。
    for (let i = 0; i < SEATS.length; i += 1) {
      const seat = starts[i].yourSeat as 'A' | 'B' | 'C';
      clientOfSeat[seat] = clients[SEATS[i]];
      userOfSeat[seat] = usersList[i];
    }
    assert.deepEqual(Object.keys(clientOfSeat).sort(), ['A', 'B', 'C'], '三个座位都必须有人，实际 ' + JSON.stringify(Object.keys(clientOfSeat)));
    // 逐手真实落子：等到 ack 才发下一手，避免把真实对局变成竞态测试。
    for (let i = 0; i < SCRIPT.length; i += 1) {
      const seat = SEATS[i % 3];
      const [row, col] = SCRIPT[i];
      send(clientOfSeat[seat], { type: 'move', commandId: 'hist-' + gameId + '-' + i, expectedRevision: undefined, row, col });
      const ack = await waitFor(clientOfSeat[seat], 'ack', 8000);
      assert.equal(ack.type, 'ack', '第 ' + (i + 1) + ' 手必须被接受');
    }
    endMsg = await waitFor(clientOfSeat.B, 'MATCH_ENDED', 8000);
    assert.equal(endMsg.winner, 'B', '终局广播的胜者必须是 B');
    await Promise.all(SEATS.map((s) => waitFor(clients[s], 'MATCH_ENDED', 8000).catch(() => null)));
  } catch (e) {
    console.log('SETUP FAILURE: ' + (e instanceof Error ? e.message : String(e)));
    failures += 1;
  } finally {
    for (const s of SEATS) close(clients[s]);
    await sleep(300);
  }

  console.log('--- R01 历史与分页 ---');

  await check('R01a 未登录不得读历史', async () => {
    const r = await api('GET', '/api/history');
    assert.equal(r.status, 401);
  });

  await check('R01b 本人历史可读且顺序正确（本人视角，含结果与分差）', async () => {
    const r = await api('GET', '/api/history?limit=10&offset=0', undefined, userOfSeat.A.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(Array.isArray(r.json.history), 'history 必须是数组');
    assert.ok(r.json.total >= 1, '本人至少 1 局');
    const mine = r.json.history.filter((x: any) => x.gameId === gameId);
    assert.equal(mine.length, 1, '本局必须出现在本人历史里');
    const it = mine[0];
    observed.r01_item = it;
    assert.equal(it.seat, 'A');
    assert.equal(it.mode, 'online');
    assert.equal(it.boardSize, 13);
    assert.equal(it.endReason, 'NORMAL_WIN');
    assert.equal(it.winnerSeat, 'B');
    assert.equal(it.outcome, 'LOSS');
    assert.equal(it.moveCount, SCRIPT.length, '落子手数必须与真实事件数一致');
    assert.equal(it.isRanked, true);
    assert.ok(Number.isInteger(it.ratingDelta));
  });

  await check('R01c 历史不泄露对手内部 ID / 邮箱 / IP', async () => {
    const r = await api('GET', '/api/history?limit=10', undefined, userOfSeat.B.token);
    const blob = JSON.stringify(r.json);
    for (const u of [uC, uA]) {
      assert.equal(blob.indexOf(u.id), -1, '不得出现其他用户 id');
      assert.equal(blob.indexOf(u.email), -1, '不得出现邮箱');
      assert.equal(blob.indexOf(u.username), -1, '不得出现对手用户名');
    }
    assert.equal(blob.indexOf('token'), -1, '不得出现会话 token 字段');
  });

  await check('R01d 分页边界：limit 上限 50、offset 可推进、total 与过滤条件一致', async () => {
    const a = await api('GET', '/api/history?limit=999&offset=0', undefined, userOfSeat.A.token);
    assert.equal(a.status, 200);
    assert.equal(a.json.limit, 50, 'limit 必须被夹到 50');
    assert.ok(a.json.history.length <= 50);
    const b = await api('GET', '/api/history?limit=1&offset=1', undefined, userOfSeat.A.token);
    assert.equal(b.json.limit, 1);
    assert.equal(b.json.offset, 1);
    assert.equal(b.json.total, a.json.total, 'total 不受分页参数影响');
  });

  await check('R01e 别人的对局不在我的历史里，也不能重放（404，不用 403 泄露存在性）', async () => {
    const uX = await registerUser('HistX');
    const h = await api('GET', '/api/history?limit=10', undefined, uX.token);
    assert.equal(h.status, 200);
    assert.equal(h.json.total, 0, '新人历史必须为空');
    assert.deepEqual(h.json.history, []);
    const rep = await api('GET', '/api/games/' + gameId + '/replay', undefined, uX.token);
    assert.equal(rep.status, 404, '非参与者的重放必须 404');
  });

  console.log('--- R02 全谱重放 / 分支隔离 ---');

  await check('R02a 重放逐手走真实引擎，最终 hash 与服务器权威快照一致', async () => {
    const r = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.A.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rep = r.json.replay;
    observed.r02 = { finalHash: rep.finalHash, hashMatches: rep.hashMatches, moveCount: rep.moveCount };
    assert.equal(rep.replayOk, true, '重放必须成功：' + JSON.stringify(rep.replayErrors));
    assert.deepEqual(rep.replayErrors, []);
    assert.equal(rep.moveCount, SCRIPT.length);
    assert.equal(rep.rulesetVersion, RULESET_VERSION);
    assert.equal(rep.hashMatches, true, '重放结果必须与持久快照同 hash');
    assert.ok(rep.snapshotHash && rep.snapshotHash.length === 32, '快照 hash 必须是 32 位十六进制');
    assert.deepEqual(rep.moves.map((m: any) => [m.seat, m.row, m.col]), SCRIPT.map(([row, col], i) => [SEATS[i % 3], row, col]));
    assert.equal(rep.status, 'won');
    assert.equal(rep.winnerSeat, 'B');
    assert.deepEqual(sortCells(rep.winLine), [[6, 1], [6, 2], [6, 3], [6, 4]]);
    // 独立复核：从持久快照自己算一遍摘要，必须等于重放摘要（不采信 API 自报的 hashMatches）。
    const snap = db.latestSnapshot(gameId);
    assert.ok(snap, '终局必须有权威快照');
    const snapState = (JSON.parse(snap.stateJson) as { state: any }).state;
    assert.equal(stateDigest(snapState), rep.finalHash, '快照摘要必须等于重放摘要');
    assert.equal(rep.snapshotRevision, snap.revision);
  });

  await check('R02b 重放确定性：同一棋谱两次重放得到同一 hash', async () => {
    const a = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.A.token);
    const b = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.C.token);
    assert.equal(a.json.replay.finalHash, b.json.replay.finalHash, '不同参与者看到同一 hash');
    assert.equal(a.json.replay.reviewCacheKey, b.json.replay.reviewCacheKey, '缓存键必须按局稳定');
    assert.ok(a.json.replay.reviewCacheKey.includes(RULESET_VERSION), '缓存键必须含 rulesetId');
    assert.ok(a.json.replay.reviewCacheKey.includes(a.json.replay.finalHash), '缓存键必须含 gameHash');
  });

  await check('R02c 伪造棋谱会被真实引擎拒绝（占位 / 违反行动序 / 禁手）', async () => {
    const occupied: PersistedEvent[] = [
      { seq: 1, revision: 1, type: 'move.applied', payload: { seat: 'A', row: 5, col: 5 } },
      { seq: 2, revision: 2, type: 'move.applied', payload: { seat: 'B', row: 5, col: 5 } },
    ];
    const r1 = replayGame(13, occupied);
    assert.equal(r1.ok, false, '占位重放必须失败');
    assert.ok(r1.errors.join(' ').includes('occupied'), '错误应指出 occupied：' + r1.errors.join(' '));

    const wrongSeat: PersistedEvent[] = [
      { seq: 1, revision: 1, type: 'move.applied', payload: { seat: 'B', row: 0, col: 0 } },
    ];
    const r2 = replayGame(13, wrongSeat);
    assert.equal(r2.ok, false, '违反行动序必须失败');
    assert.ok(r2.errors.join(' ').includes('座位'), '错误应指出座位不一致');

    // 10 手：第 10 手 A 在 R4（无胜权）用 (0,0) 补成 4 连 —— 必须是禁手。
    const coords: Array<[number, number]> = [[0, 1], [10, 10], [11, 11], [0, 2], [10, 11], [11, 12], [0, 3], [10, 12], [11, 9], [0, 0]];
    const forbidden: PersistedEvent[] = coords.map(([row, col], i) => ({
      seq: i + 1, revision: i + 1, type: 'move.applied', payload: { seat: SEATS[i % 3], row, col },
    }));
    const r3 = replayGame(13, forbidden);
    assert.equal(r3.ok, false, '禁手必须让重放失败而不是被静默接受');
    assert.ok(r3.errors.join(' ').includes('forbidden'), '错误应指出 forbidden：' + r3.errors.join(' '));
    assert.equal(r3.steps.length, 9, '前 9 手合法、第 10 手被拒');
    // 同一批事件里把手换到合法位置即可通过 —— 证明失败来自引擎而不是重放器本身。
    const okEvents = forbidden.slice(0, 9).concat([{ seq: 10, revision: 10, type: 'move.applied', payload: { seat: 'A', row: 7, col: 7 } }]);
    const r4 = replayGame(13, okEvents);
    assert.equal(r4.ok, true, '换掉最后一手后必须通过：' + r4.errors.join(' '));
  });

  await check('R02d 终局后分支试下不写回原比赛：事件/快照/结算摘要全部不变', async () => {
    const before = {
      events: Number((rawRow('SELECT COUNT(*) AS n FROM game_events WHERE game_id = ?', gameId) as any).n),
      snapshots: Number((rawRow('SELECT COUNT(*) AS n FROM game_snapshots WHERE game_id = ?', gameId) as any).n),
      commands: Number((rawRow('SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ?', gameId) as any).n),
      digest: String((rawRow('SELECT settlement_digest FROM match_results WHERE game_id = ?', gameId) as any).settlement_digest),
      maxRevision: Number((rawRow('SELECT COALESCE(MAX(revision),0) AS r FROM game_snapshots WHERE game_id = ?', gameId) as any).r),
    };
    // 1) 纯逻辑分支：在终局态上试下另一手，只在内存里，不落库。
    const rep = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.A.token);
    assert.equal(rep.status, 200);
    const branchEvents = (db.listGameEvents(gameId) as PersistedEvent[]).map((e) => ({ ...e }));
    branchEvents.push({ seq: 999, revision: 999, type: 'move.applied', payload: { seat: 'C', row: 1, col: 1 } });
    const branched = replayGame(13, branchEvents);
    assert.equal(branched.ok, false, '终局后的分支重放必须被拒绝（not-playing）');
    // 2) 真实命令分支：终局房间再发一手，必须被明确拒绝且不改动任何持久状态。
    const cA2 = await connect(userOfSeat.A.token);
    try {
      send(cA2, { type: 'move', commandId: 'branch-' + gameId, row: 1, col: 1 });
      const rej = await waitFor(cA2, 'command.rejected', 5000);
      observed.r02d_code = rej.code;
      assert.ok(['NO_ACTIVE_GAME', 'GAME_ENDED'].includes(rej.code), '终局后落子必须被拒绝，实际 ' + rej.code);
    } finally { close(cA2); await sleep(200); }
    const after = {
      events: Number((rawRow('SELECT COUNT(*) AS n FROM game_events WHERE game_id = ?', gameId) as any).n),
      snapshots: Number((rawRow('SELECT COUNT(*) AS n FROM game_snapshots WHERE game_id = ?', gameId) as any).n),
      commands: Number((rawRow('SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ?', gameId) as any).n),
      digest: String((rawRow('SELECT settlement_digest FROM match_results WHERE game_id = ?', gameId) as any).settlement_digest),
      maxRevision: Number((rawRow('SELECT COALESCE(MAX(revision),0) AS r FROM game_snapshots WHERE game_id = ?', gameId) as any).r),
    };
    assert.deepEqual(after, before, '分支绝不写回原比赛');
    assert.equal(after.events, SCRIPT.length, '每手一条事件，一手不多');
  });

  await check('R02e 17×17 满盘量级的重放/窗口预算可测量且远低于上限', async () => {
    const gen = longGameEvents(17);
    const t0 = Date.now();
    const outcome = replayGame(17, gen.events);
    const t1 = Date.now();
    const windows = threatWindows(outcome);
    const t2 = Date.now();
    const km = reviewKeyMoves(outcome);
    const t3 = Date.now();
    observed.r02e = {
      plies: gen.plies, endStatus: outcome.state.status,
      replayMs: t1 - t0, windowsMs: t2 - t1, keyMovesMs: t3 - t2,
      windows: windows.length, keyMoves: km.length,
    };
    assert.equal(outcome.ok, true, '长棋谱必须能重放：' + outcome.errors.join(' '));
    assert.equal(outcome.steps.length, gen.plies);
    assert.ok(gen.plies >= 200, '样本必须是长局（固定种子实测 218 手），实际 ' + gen.plies + ' 手');
    assert.ok(t1 - t0 < 3000, '重放预算必须显著低于 3s，实际 ' + (t1 - t0) + 'ms');
    assert.ok(t2 - t1 < 8000, '跨轮窗口预算必须显著低于 8s，实际 ' + (t2 - t1) + 'ms');
    for (const k of km) assert.equal(k.certainty, 'EXACT_ONE_PLY', '长局里也只能出现精确一步结论');
  });

  console.log('--- R03 关键三手解释 ---');

  await check('R03a 终局给出至多 3 个关键片段，覆盖 致胜 / 错失 / 跨轮遮挡', async () => {
    const r = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.B.token);
    const km = r.json.replay.keyMoves;
    observed.r03 = km.map((k: any) => ({ ply: k.ply, type: k.type, seat: k.actorSeat, row: k.row, col: k.col, round: k.round, points: k.points.length }));
    assert.equal(km.length, 3, '恰好 3 个关键片段，实际 ' + JSON.stringify(observed.r03));
    assert.deepEqual(km.map((k: any) => k.type), ['IMMEDIATE_WIN', 'MISSED_WIN', 'PREEMPTIVE_BLOCK']);
    const [win, missed, block] = km;
    assert.equal(win.ply, 20);
    assert.equal(win.actorSeat, 'B');
    assert.deepEqual([win.row, win.col], [6, 4]);
    assert.equal(win.round, 7, 'R7 的胜权持有者才是 B');
    assert.equal(win.eligiblePlayer, 'B');
    assert.equal(win.actorEligible, true);
    assert.deepEqual(sortCells(win.referenceLine), [[6, 1], [6, 2], [6, 3], [6, 4]]);
    assert.equal(missed.ply, 18);
    assert.equal(missed.actorSeat, 'C');
    assert.equal(missed.round, 6);
    assert.equal(missed.eligiblePlayer, 'C');
    assert.equal(block.ply, 16);
    assert.equal(block.actorSeat, 'A');
    assert.deepEqual([block.row, block.col], [0, 0]);
    assert.equal(block.args.threatened, 'C', '被遮挡的是本轮胜权持有者 C');
    assert.equal(block.args.eligibleRound, 6, '遮挡必须落在对手真实行动的胜权回合');
  });

  await check('R03b certainty 诚实：只给精确一步结论，绝不出现搜索估计或胜率', async () => {
    const r = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.B.token);
    const rep = r.json.replay;
    assert.equal(rep.analysisMode, 'phase-a-exact-one-ply');
    for (const k of rep.keyMoves) {
      assert.equal(k.certainty, 'EXACT_ONE_PLY', 'Phase A 不得输出 SEARCH_ESTIMATE');
      assert.equal(k.proofHorizon, 1);
      assert.ok(Number.isInteger(k.nodes) && k.nodes > 0, '必须报告精确检查的预算口径');
      assert.ok(Number.isInteger(k.wallMs) && k.wallMs >= 0);
      assert.ok(k.messageKey.startsWith('KEY_MOVE_'), '必须有可本地化文案 key');
    }
    const blob = JSON.stringify(rep);
    for (const bad of ['胜率', '%', 'winRate', 'probability', '一定赢', '必胜', '恶意', '串通', '送分']) {
      assert.equal(blob.indexOf(bad), -1, '不得出现未经校准的措辞：' + bad);
    }
  });

  await check('R03c 坐标/执子/胜权/禁手与引擎一致（逐点复核）', async () => {
    const r = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.B.token);
    const events = db.listGameEvents(gameId) as PersistedEvent[];
    const outcome = replayGame(13, events, { expectedHash: r.json.replay.snapshotHash });
    assert.equal(outcome.ok, true);
    // 独立复核：把 ply-1 之前的状态重新走一遍，确认关键片段的回合/资格与引擎逐步一致。
    for (const km of outcome.steps.map((s, i) => ({ s, i }))) {
      assert.equal(km.s.round, Math.floor(km.i / 3) + 1, 'round 必须是 1-based 真实 Round');
      assert.equal(km.s.seat, SEATS[km.i % 3], '执子必须等于行动序');
    }
    const km = reviewKeyMoves(outcome);
    for (const k of km) {
      const step = outcome.steps[k.ply - 1];
      assert.equal(step.row, k.row, '坐标 row 必须与持久事件一致');
      assert.equal(step.col, k.col, '坐标 col 必须与持久事件一致');
      assert.equal(step.seat, k.actorSeat, '执子必须与持久事件一致');
      assert.equal(step.round, k.round);
      assert.equal(k.actorEligible, step.eligiblePlayer === step.seat, '胜权判定必须与引擎一致');
    }
    // 无胜权的手不得被描述成致胜：只有 IMMEDIATE_WIN 才允许 actorEligible=false 之外的情形。
    const won = km.find((k) => k.type === 'IMMEDIATE_WIN');
    assert.ok(won && won.actorEligible === true, '致胜手必然发生在有胜权的回合');
  });

  await check('R03d 无关键片段的局面不编造解释（平局/中止返回空数组）', async () => {
    const empty: PersistedEvent[] = [
      { seq: 1, revision: 1, type: 'move.applied', payload: { seat: 'A', row: 0, col: 0 } },
      { seq: 2, revision: 2, type: 'move.applied', payload: { seat: 'B', row: 1, col: 1 } },
    ];
    const outcome = replayGame(13, empty);
    assert.equal(outcome.ok, true);
    assert.deepEqual(reviewKeyMoves(outcome), [], 'R1 的两手没有任何可证明片段，必须返回空');
  });

  console.log('--- R04 跨轮防守 / R05 多个好动作 ---');

  await check('R04a 从威胁出现到兑现前统计**全部**动作（含第三方、含跨轮）', async () => {
    const events = db.listGameEvents(gameId) as PersistedEvent[];
    const outcome = replayGame(13, events);
    const windows = threatWindows(outcome);
    observed.r04_windows = windows.length;
    // B 的 (6,4)：威胁在 ply 8 出现（B 走成 3 连），ply 20 由 B 自己兑现。
    const w = windows.find((x) => x.threatenedSeat === 'B' && x.row === 6 && x.col === 4);
    assert.ok(w, '必须存在 B 在 (6,4) 的威胁窗口');
    observed.r04_window = { openedAtPly: w.openedAtPly, resolvedAtPly: w.resolvedAtPly, actions: w.actions.length, selfResolved: w.selfResolved };
    assert.equal(w.openedAtPly, 8, '威胁在 ply 8 出现');
    assert.equal(w.resolvedAtPly, 20, 'ply 20 兑现');
    assert.equal(w.resolvedBySeat, 'B');
    assert.equal(w.selfResolved, true, '是受威胁者自己用掉了这个点');
    assert.deepEqual(w.actions, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], '必须收录窗口内每一手，而不是只数受威胁者那几手');
    const seatsInWindow = new Set(w.actions.map((ply) => outcome.steps[ply - 1].seat));
    assert.equal(seatsInWindow.size, 3, '窗口内三方都在动作，第三方也必须计入');
    // C 的 (0,0)：ply 9 出现（C 走成 3 连），ply 16 被 A 占掉 —— 跨越 6 手的遮挡。
    const blocked = windows.find((x) => x.threatenedSeat === 'C' && x.row === 0 && x.col === 0);
    assert.ok(blocked, '必须存在 C 在 (0,0) 的威胁窗口');
    assert.equal(blocked.openedAtPly, 9);
    assert.equal(blocked.resolvedAtPly, 16);
    assert.equal(blocked.resolvedBySeat, 'A');
    assert.equal(blocked.selfResolved, false);
    assert.deepEqual(blocked.actions, [10, 11, 12, 13, 14, 15, 16], '被遮挡前这 7 手全部要计入，不能只数 A 自己那几手');
    // C 的 (0,4)：到终局都没被占 —— 必须如实记为未兑现。
    const open = windows.find((x) => x.threatenedSeat === 'C' && x.row === 0 && x.col === 4);
    assert.ok(open);
    assert.equal(open.openedAtPly, 9);
    assert.equal(open.resolvedAtPly, null, '未兑现的威胁不得假装已解决');
    assert.equal(open.resolvedBySeat, null);
  });

  await check('R04b 联合可防不写成对手必然合作（文案只有事实，无动机定性）', async () => {
    const r = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.B.token);
    const block = r.json.replay.keyMoves.find((k: any) => k.type === 'PREEMPTIVE_BLOCK');
    assert.ok(block.defenseWindow, '遮挡片段必须附上对应的跨轮窗口');
    assert.equal(block.defenseWindow.resolvedBySeat, 'A');
    assert.equal(block.defenseWindow.selfResolved, false);
    assert.deepEqual(Object.keys(block.defenseWindow).sort(), [
      'actions', 'certainty', 'col', 'openedAtPly', 'resolvedAtPly', 'resolvedBySeat', 'row', 'selfResolved', 'threatenedSeat',
    ], '窗口结构里不允许塞入任何动机/推断字段');
    assert.equal(block.defenseWindow.certainty, 'EXACT_ONE_PLY');
  });

  await check('R05a 真实对局：只列此刻仍可用的致胜点（(0,0) 已被占，不列) ', async () => {
    const r = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.B.token);
    const missed = r.json.replay.keyMoves.find((k: any) => k.type === 'MISSED_WIN');
    assert.deepEqual(missed.points.map((p: any) => [p.row, p.col]), [[0, 4]], 'ply 16 之后 C 只剩 (0,4)');
    assert.equal(missed.args.points, 1);
    assert.deepEqual(missed.alternativeLines, [{ row: 0, col: 4, legal: true, winning: true }]);
  });

  await check('R05b 有多个已证明答案时必须全部列出（独立复核每个点都真的成四）', async () => {
    // 18 手合成棋谱：C 在 R6 之前走成 (0,1)(0,2)(0,3) 三连，R6 时 (0,0) 与 (0,4) **都**空着。
    // C 在 R6 下在别处 —— 两个致胜点都必须被列出，任何一个都不能被说成唯一正解。
    const coords: Array<[number, number]> = [
      [5, 5], [6, 1], [0, 1],
      [10, 10], [6, 2], [0, 2],
      [10, 11], [6, 3], [0, 3],
      [10, 12], [11, 11], [12, 12],
      [5, 6], [11, 12], [12, 11],
      [2, 2], [11, 10], [3, 3],
    ];
    const events: PersistedEvent[] = coords.map(([row, col], i) => ({
      seq: i + 1, revision: i + 1, type: 'move.applied', payload: { seat: SEATS[i % 3], row, col },
    }));
    const outcome = replayGame(13, events);
    assert.equal(outcome.ok, true, '合成棋谱必须合法：' + outcome.errors.join(' '));
    const missed = reviewKeyMoves(outcome).find((k) => k.type === 'MISSED_WIN');
    assert.ok(missed, 'C 在 R6 有胜权且有致胜点却下在别处，必须被判为错失');
    assert.equal(missed.actorSeat, 'C');
    assert.equal(missed.round, 6);
    observed.r05_points = missed.points.map((p) => [p.row, p.col]);
    assert.deepEqual(missed.points.map((p) => [p.row, p.col]).sort((a, b) => a[1] - b[1]), [[0, 0], [0, 4]], '两个致胜点都要列出');
    assert.equal(missed.args.points, 2, '文案参数必须诚实报告答案个数');
    assert.equal(missed.alternativeLines.length, 2, '每个已证明答案都要成为可重放的候选变化');
    assert.ok(missed.alternativeLines.every((a) => a.legal && a.winning), '两个候选都必须是合法且致胜的');
    // 独立复核（不信被测模块）：把每个点自己放上去数连线，确认确实形成 >=4 连。
    const beforeBoard = outcome.frames[missed.ply - 1].before.board;
    for (const p of missed.points) {
      assert.equal(beforeBoard[p.row][p.col], null, '答案点必须是空点');
      assert.equal(independentFormsFour(beforeBoard, p.row, p.col, 'C' as any), true, '点 (' + p.row + ',' + p.col + ') 必须真的成四');
    }
    assert.equal(independentFormsFour(beforeBoard, 0, 2, 'C' as any), false, '已被占的点不应被算作答案');
  });

  await check('R05c 启发式第二名不会被说成唯一错误：候选是“集合”而非“唯一正解”', async () => {
    const r = await api('GET', '/api/games/' + gameId + '/replay', undefined, userOfSeat.B.token);
    const blob = JSON.stringify(r.json.replay.keyMoves);
    for (const bad of ['唯一', '只能', '必须下', '最佳', '正解']) {
      assert.equal(blob.indexOf(bad), -1, '关键片段不得宣称唯一/最佳：' + bad);
    }
    const missed = r.json.replay.keyMoves.find((k: any) => k.type === 'MISSED_WIN');
    assert.equal(missed.messageKey, 'KEY_MOVE_MISSED_WIN');
    assert.equal(typeof missed.args.points, 'number', '文案参数必须带答案个数而不是定性结论');
  });

  console.log('--- R06 分享与撤销 ---');

  await check('R06a 只有终局后、由参与者本人才能创建分享链接（7 天 TTL）', async () => {
    const uX = await registerUser('ShareX');
    const notMine = await api('POST', '/api/games/' + gameId + '/share', {}, uX.token);
    assert.equal(notMine.status, 404, '非参与者不得创建分享');
    const anon = await api('POST', '/api/games/' + gameId + '/share', {});
    assert.equal(anon.status, 401, '未登录不得创建分享');
    const ok = await api('POST', '/api/games/' + gameId + '/share', {}, userOfSeat.B.token);
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const s = ok.json.share;
    observed.r06 = { ttlMs: s.ttlMs, path: s.path };
    assert.equal(s.ttlMs, 7 * 24 * 60 * 60 * 1000, 'TTL 必须是 7 天');
    assert.equal(s.expiresAt - s.createdAt, s.ttlMs);
    assert.equal(s.path, '/s/' + s.token);
    assert.ok(/^[0-9a-f]{32}$/.test(s.token), 'token 必须是不可猜的十六进制串');
  });

  await check('R06b 匿名可读，且不泄露内部 ID / 邮箱 / 用户名 / 会话信息', async () => {
    const list = await api('GET', '/api/games/' + gameId + '/share', undefined, userOfSeat.B.token);
    assert.equal(list.status, 200);
    const token = list.json.shares[0].token;
    const pub = await api('GET', '/api/shared/' + token);
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const blob = JSON.stringify(pub.json);
    observed.r06_public_keys = Object.keys(pub.json.shared.seats[0]);
    assert.equal(blob.indexOf(gameId), -1, '公开视图不得包含 gameId');
    for (const u of [uA, uB, uC]) {
      assert.equal(blob.indexOf(u.id), -1, '不得包含用户 id');
      assert.equal(blob.indexOf(u.username), -1, '不得包含用户名');
      assert.equal(blob.indexOf(u.email), -1, '不得包含邮箱');
    }
    for (const bad of ['@', 'token', 'owner_id', 'ownerId', 'password', 'ip']) {
      assert.equal(blob.indexOf(bad), -1, '公开视图不得出现 ' + bad);
    }
    assert.equal(pub.json.shared.mode, 'online');
    assert.equal(pub.json.shared.boardSize, 13);
    assert.equal(pub.json.shared.moveCount, SCRIPT.length);
    assert.equal(pub.json.shared.winnerSeat, 'B');
    assert.equal(pub.json.shared.seats.length, 3);
    assert.deepEqual(pub.json.shared.seats.map((s: any) => [s.seat, s.outcome]), [['A', 'LOSS'], ['B', 'WIN'], ['C', 'LOSS']]);
    assert.equal(pub.json.shared.seatLabels.c, undefined, '座位标签键必须是大写 A/B/C');
    assert.ok(pub.json.shared.seatLabels.C.length > 0, '必须给出棋色标签，白棋要可辨');
    assert.equal(pub.json.shared.demo, false, '全部为真人账号时不得标 DEMO');
    assert.ok(pub.json.shared.keyMoves.length > 0, '分享必须带上已证实的解释');
  });

  await check('R06c 撤销后不可访问（410），且只有创建者能撤销', async () => {
    const list = await api('GET', '/api/games/' + gameId + '/share', undefined, userOfSeat.B.token);
    const token = list.json.shares[0].token;
    const other = await api('DELETE', '/api/share/' + token, undefined, userOfSeat.A.token);
    assert.equal(other.status, 404, '非创建者不得撤销');
    assert.equal((await api('GET', '/api/shared/' + token)).status, 200, '被拒的撤销不得改变状态');
    const rev = await api('DELETE', '/api/share/' + token, undefined, userOfSeat.B.token);
    assert.equal(rev.status, 200);
    assert.equal(rev.json.revoked, true);
    const after = await api('GET', '/api/shared/' + token);
    assert.equal(after.status, 410, '撤销后必须不可访问');
    assert.equal(after.json.error, 'revoked');
    const again = await api('DELETE', '/api/share/' + token, undefined, userOfSeat.B.token);
    assert.equal(again.status, 404, '重复撤销不幂等成功（已撤销）');
    const bad = await api('GET', '/api/shared/deadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(bad.status, 404, '不存在的 token 一律 404');
  });

  await check('R06d 过期链接不可访问（7 天后 410 expired）', async () => {
    const created = await api('POST', '/api/games/' + gameId + '/share', {}, userOfSeat.B.token);
    assert.equal(created.status, 201);
    const token = created.json.share.token;
    assert.equal((await api('GET', '/api/shared/' + token)).status, 200);
    db.raw.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);
    const expired = await api('GET', '/api/shared/' + token);
    assert.equal(expired.status, 410);
    assert.equal(expired.json.error, 'expired');
    // 过期链接也不出现在“有效分享”统计里（历史 hasShare 必须为 false）。
    const h = await api('GET', '/api/history?limit=10', undefined, userOfSeat.B.token);
    const it = h.json.history.find((x: any) => x.gameId === gameId);
    assert.equal(it.hasShare, false, '过期/撤销的链接不算有效分享');
  });

  await check('R06e 进行中的对局不能分享、不能重放（分析只在终局后）', async () => {
    const uSolo = await registerUser('HistSolo');
    const c = await connect(uSolo.token);
    try {
      send(c, { type: 'queue.join' });
      const start = await waitFor(c, 'game.start', 12000);
      const liveId = start.gameId as string;
      const sh = await api('POST', '/api/games/' + liveId + '/share', {}, uSolo.token);
      assert.equal(sh.status, 409, '进行中的对局不得分享');
      assert.equal(sh.json.error, 'SHARE_REQUIRES_SETTLED');
      const rep = await api('GET', '/api/games/' + liveId + '/replay', undefined, uSolo.token);
      assert.equal(rep.status, 409, '进行中的对局不得分析');
      assert.equal(rep.json.error, 'ANALYSIS_REQUIRES_SETTLED');
      assert.equal((await api('GET', '/api/games/' + liveId + '/share', undefined, uSolo.token)).json.shares.length, 0);
      send(c, { type: 'PLAYER_RESIGN' });
      await pollUntil(() => rawRow('SELECT 1 AS x FROM match_results WHERE game_id = ?', liveId));
    } finally { close(c); await sleep(250); }
  });

  await check('R06f 分享链接在数据库中可审计：不含 game_id 的公开发布面之外，行本身可核对', async () => {
    const row = rawRow('SELECT * FROM share_links WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1', userOfSeat.B.id, Date.now());
    assert.ok(row, '链接必须落库');
    assert.equal(row.game_id, gameId);
    assert.equal(row.owner_id, userOfSeat.B.id);
    assert.ok(row.created_at > 0 && row.expires_at > row.created_at);
    assert.equal(Number(row.views) >= 1, true, '公开访问必须计数');
  });

  await check('R06g 公开分享按来源限流（未认证的昂贵重放不能被打满）', async () => {
    const created = await api('POST', '/api/games/' + gameId + '/share', {}, userOfSeat.B.token);
    assert.equal(created.status, 201);
    const token = created.json.share.token;
    let ok = 0;
    let limited = 0;
    let firstLimitedAt = 0;
    for (let i = 0; i < 45; i += 1) {
      const r0 = await api('GET', '/api/shared/' + token);
      if (r0.status === 200) { ok += 1; continue; }
      assert.equal(r0.status, 429, '超出限额必须是 429，实际 ' + r0.status);
      assert.equal(r0.json.code, 'RATE_LIMITED');
      limited += 1;
      firstLimitedAt = ok;
      break;
    }
    observed.r06g = { ok, limited, firstLimitedAt };
    assert.ok(ok > 0, '限额内必须能正常读取');
    assert.equal(limited, 1, '必须真的触发限流');
    const again = await api('GET', '/api/shared/' + token);
    assert.equal(again.status, 429, '触发后短时间内仍应是 429，而不是偶尔放行');
    // 限流只针对公开分享；登录后的本人接口不受影响。
    const mine = await api('GET', '/api/history?limit=1', undefined, userOfSeat.B.token);
    assert.equal(mine.status, 200, '限流不得波及已认证接口');
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  await new Promise<void>((r) => apiServer.close(() => r()));
  await new Promise<void>((r) => wsHttp.close(() => r()));
  await gs.aiHost.close();
  db.close();
  if (failures === 0) console.log('HISTORY REPLAY: ALL PASS 0');
  else console.log('HISTORY REPLAY: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
