/**
 * SRSZQ WebSocket 在线对局集成测试（真实 WS 多客户端）：
 *   npm run test:ws
 *
 * 覆盖（Player Leave System 版）：
 *  - Test1 正常终局（1H+2AI）：MATCH_ENDED reason=NORMAL_WIN，matches 落盘
 *    end_reason/winner_ids/loser_ids，排行只按结果 ±30/±10 入账
 *  - Test2 A 主动 Leave（PLAYER_RESIGN）→ 立即判负：A loss，B/C win，房间清理
 *  - Test3 浏览器关闭/掉线 → 宽限期后判负（PLAYER_DISCONNECT），AI 不继续
 *  - Test4 宽限内 resume → 恢复对局（不判负、不掉分）
 *  - Test5 结束后可再次 Online Match（无僵尸房间/绑定）
 *  - Test6 排行仅 Online 变化：好友局拒绝 PLAYER_RESIGN，不计入排位
 *  - Test7 AI 补位局人类退出 → 立即终局（AI 不继续），其他人类胜
 * 另保留：教学门禁 / 3H 匹配 / 邀请状态机（2H+1AI / 3H / GATHER 超时 / 离线接受）。
 * AI 走子由服务器执行（共享引擎 + 共享 AI）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer } from '../src/ws/gameServer.js';
import { getLegalMoves, currentPlayerOf } from '../../shared/src/game/legalMoves.js';

let db: Db;
let apiBase = '';
let wsBase = '';
let failures = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}  [${e instanceof Error ? e.message : String(e)}]`);
  }
}

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

interface TestClient {
  ws: WebSocket;
  msgs: Array<{ type: string; [k: string]: any }>;
}

function connect(token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}?token=${token}`);
    const msgs: TestClient['msgs'] = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      msgs.push(m);
      if (process.env.SRSZQ_WS_DEBUG) console.log(`  [cli:${token.slice(0, 4)}] << ${m.type}`);
    });
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
  });
}

const send = (c: TestClient, msg: unknown) => c.ws.send(JSON.stringify(msg));
const close = (c: TestClient) => {
  try {
    c.ws.close();
  } catch {
    /* noop */
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(c: TestClient, type: string, timeoutMs = 5000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const idx = c.msgs.findIndex((m) => m.type === type);
    if (idx >= 0) return c.msgs.splice(idx, 1)[0];
    await sleep(20);
  }
  throw new Error(`timeout waiting ${type}; got ${c.msgs.map((m) => m.type).join(',')}`);
}

/** 轮询消费事件直到谓词满足，返回满足条件的事件或 null（超时） */
async function drainUntil(c: TestClient, type: string, pred: (msg: any) => boolean, timeoutMs = 4000): Promise<any | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const idx = c.msgs.findIndex((m) => m.type === type);
    if (idx >= 0) {
      const msg = c.msgs.splice(idx, 1)[0];
      if (pred(msg)) return msg;
      continue;
    }
    await sleep(20);
  }
  return null;
}

/** 轮询外部条件（如 DB 行 / 排行），返回 truthy 结果或 null */
async function pollUntil(fn: () => any, timeoutMs = 4000): Promise<any> {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < timeoutMs) {
    v = fn();
    if (v) return v;
    await sleep(25);
  }
  return null;
}

async function registerUser(name: string): Promise<{ token: string; id: string }> {
  const r = await api('POST', '/api/register', { email: `${name}@test.com`, username: name, password: 'secret1' });
  assert.equal(r.status, 201);
  return { token: r.json.token, id: r.json.user.id };
}

async function rankOf(id: string): Promise<{ rating: number; wins: number; games: number }> {
  const r = await api('GET', '/api/ranking');
  const row = r.json.ranking.find((u: any) => u.id === id);
  return { rating: row?.rating ?? 0, wins: row?.wins ?? 0, games: row?.games ?? 0 };
}

/** 读取某局 matches 落盘行（含 Player Leave System 字段） */
function matchRowOf(gameId: string): any {
  const r = db.raw.prepare('SELECT * FROM matches WHERE game_id = ? ORDER BY created_at DESC LIMIT 1').get(gameId) as Record<string, unknown> | undefined;
  return r ?? null;
}

/** 真人客户端在轮到自己的回合随机落一个合法点（用共享引擎计算） */
function maybeMove(c: TestClient, state: any, seat: string): void {
  if (state.status !== 'playing') return;
  if (currentPlayerOf(state) !== seat) return;
  const legal = getLegalMoves(state);
  if (legal.length === 0) return;
  const m = legal[Math.floor(Math.random() * Math.min(8, legal.length))];
  send(c, { type: 'move', row: m.row, col: m.col });
}

/** 3 真人入队开局，返回 {gameId, seatOf, state}（state 为开局状态） */
async function start3H(clients: TestClient[]): Promise<{ gameId: string; seatOf: Map<string, TestClient>; state: any }> {
  for (const c of clients) send(c, { type: 'queue.join' });
  const starts = await Promise.all(clients.map((c) => waitFor(c, 'game.start', 5000)));
  const gameId = starts[0].gameId;
  assert.equal(starts[1].gameId, gameId);
  assert.equal(starts[2].gameId, gameId);
  const seatOf = new Map<string, TestClient>();
  starts.forEach((s, i) => seatOf.set(s.yourSeat as string, clients[i]));
  return { gameId, seatOf, state: starts[0].state };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-ws-'));
  db = openDb(join(dir, 'test.sqlite'));

  const wsHttp = createServer();
  const gs = new GameServer(db, {
    queueTimeoutMs: 250,
    aiMoveDelayMs: 10,
    disconnectSkipMs: 250,
    aiTimeBudgetMs: 60,
    inviteGatherMs: 800,
    forfeitGraceMs: 350, // 判负宽限（生产默认 10s）
  });
  gs.attach(wsHttp, '/ws');
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', r));
  wsBase = `ws://127.0.0.1:${(wsHttp.address() as AddressInfo).port}/ws`;

  const { server: apiServer } = createApi(db, {
    onInviteCreated: (x, y) => gs.registerInvitation(x, y),
    onInviteAccepted: (x, y) => gs.handleInviteAccept(x, y),
    onInviteRejected: (x, y) => gs.onInviteRejected(x, y),
  });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  const a = await registerUser('Alice');
  const b = await registerUser('Bob');
  const cTut = await registerUser('Carol');
  await api('POST', '/api/tutorial/complete', {}, a.token);
  await api('POST', '/api/tutorial/complete', {}, b.token);

  // 1) 教学门禁
  await check('未完成教学不能匹配（tutorial required）', async () => {
    const c1 = await connect(cTut.token);
    send(c1, { type: 'queue.join' });
    const err = await waitFor(c1, 'error');
    assert.match(err.error, /tutorial/i);
    close(c1);
    await api('POST', '/api/tutorial/complete', {}, cTut.token);
  });

  // 2) Test1：正常终局（1H+2AI）→ NORMAL_WIN 落盘 + 排行按结果入账
  await check('Test1 正常终局：MATCH_ENDED NORMAL_WIN + 排行 ±30/-10 + matches 落盘', async () => {
    const c1 = await connect(a.token);
    let gameId = '';
    try {
      const before = await rankOf(a.id);
      send(c1, { type: 'queue.join' });
      const start = await waitFor(c1, 'game.start', 5000);
      gameId = start.gameId;
      const seats = Object.values(start.seats) as Array<{ kind: string; stars?: number; aiLevel?: string }>;
      assert.equal(seats.filter((s) => s.kind === 'human').length, 1);
      const ais = seats.filter((s) => s.kind === 'ai');
      assert.equal(ais.length, 2);
      assert.ok(ais.every((s) => typeof s.stars === 'number' && s.stars >= 1 && s.stars <= 5));
      assert.ok(ais.every((s) => [2, 3, 4, 5].includes(s.stars!)), 'Online 1H+2AI 补位只允许 2★/3★/4★/5★');
      assert.ok(ais.every((s) => !('aiLevel' in s)), '客户端不得见到真实 AI 档位');
      assert.equal(start.mode, 'online');
      const me = start.yourSeat as string;
      const endedMsg: any = await (async () => {
        maybeMove(c1, start.state, me); // 若先手是自己（seat A），立即落子
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const idx = c1.msgs.findIndex((m) => m.type === 'game.end' || m.type === 'MATCH_ENDED');
          if (idx >= 0) return c1.msgs.splice(idx, 1)[0];
          const stIdx = c1.msgs.findIndex((m) => m.type === 'game.state');
          if (stIdx >= 0) {
            const msg = c1.msgs.splice(stIdx, 1)[0];
            maybeMove(c1, msg.state, me);
          } else {
            await sleep(20);
          }
        }
        return null;
      })();
      assert.ok(endedMsg, '1H 对局应在时限内结束');
      assert.equal(endedMsg.reason, 'NORMAL_WIN');
      assert.equal(endedMsg.matchId, gameId);
      assert.ok(typeof endedMsg.timestamp === 'number');
      const row = await pollUntil(() => matchRowOf(gameId));
      assert.ok(row, 'matches 应落盘');
      assert.equal(row.end_reason, 'NORMAL_WIN');
      const winnerIds = JSON.parse(row.winner_ids as string) as string[];
      const loserIds = JSON.parse(row.loser_ids as string) as string[];
      const humanWin = row.result === (start.yourSeat as string);
      const after = await rankOf(a.id);
      assert.equal(after.games, before.games + 1, '排位对局应计入 games');
      assert.equal(after.rating, before.rating + (humanWin ? 30 : -10), '胜 +30 / 负 -10');
      assert.equal(after.wins, before.wins + (humanWin ? 1 : 0), '胜利场次');
      assert.equal(winnerIds.includes(a.id), humanWin, 'winner_ids 与胜负一致');
      assert.equal(loserIds.includes(a.id), !humanWin, 'loser_ids 与胜负一致');
    } finally {
      close(c1);
      await sleep(150);
    }
  });

  // 3) Test2：A 主动 Leave（PLAYER_RESIGN）→ 立即判负：A loss，B/C win
  await check('Test2 主动离开判负：A loss / B,C win（PLAYER_FORFEIT）', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    const c3 = await connect(cTut.token);
    try {
      const [beforeA, beforeB, beforeC] = await Promise.all([rankOf(a.id), rankOf(b.id), rankOf(cTut.id)]);
      const { gameId, seatOf } = await start3H([c1, c2, c3]);
      // 座位已随机：Alice 的真实座位不再固定为 A
      const aliceSeat = [...seatOf.entries()].find(([, cl]) => cl === c1)![0];
      const ca = c1;
      const others = [c2, c3];
      const otherSeats = [...seatOf.entries()].filter(([, cl]) => cl !== c1).map(([s]) => s);
      send(ca, { type: 'PLAYER_RESIGN' });
      // 全员（含离开者本人）都收到 MATCH_ENDED：reason=PLAYER_FORFEIT
      const [mA, mB, mC] = await Promise.all([
        waitFor(ca, 'MATCH_ENDED', 3000),
        waitFor(others[0], 'MATCH_ENDED', 3000),
        waitFor(others[1], 'MATCH_ENDED', 3000),
      ]);
      assert.equal(mA.reason, 'PLAYER_FORFEIT');
      assert.equal(mB.reason, 'PLAYER_FORFEIT');
      assert.equal(mC.reason, 'PLAYER_FORFEIT');
      assert.equal(mA.matchId, gameId);
      assert.deepEqual(mA.loserSeats, [aliceSeat], '只有离开者是败者');
      assert.ok(mA.winnerSeats.length === 2 && !mA.winnerSeats.includes(aliceSeat), '其余两个人类座位获胜');
      assert.deepEqual([...mA.winnerSeats].sort(), [...otherSeats].sort(), '胜者座位 = 其余两人类座位');
      assert.deepEqual(mA.winnerIds.sort(), [b.id, cTut.id].sort(), 'winner_ids 为 B/C');
      assert.deepEqual(mA.loserIds, [a.id], 'loser_ids 为 A');
      // 落盘 end_reason
      const row = await pollUntil(() => matchRowOf(gameId));
      assert.ok(row);
      assert.equal(row.end_reason, 'PLAYER_FORFEIT');
      assert.deepEqual(JSON.parse(row.loser_ids as string), [a.id]);
      // 排行：A -10 败；B/C +30 胜
      const [afterA, afterB, afterC] = await Promise.all([rankOf(a.id), rankOf(b.id), rankOf(cTut.id)]);
      assert.equal(afterA.rating, beforeA.rating - 10);
      assert.equal(afterA.games, beforeA.games + 1);
      assert.equal(afterA.wins, beforeA.wins, '离开者不加胜场');
      assert.equal(afterB.rating, beforeB.rating + 30);
      assert.equal(afterB.games, beforeB.games + 1);
      assert.equal(afterB.wins, beforeB.wins + 1);
      assert.equal(afterC.rating, beforeC.rating + 30);
      assert.equal(afterC.games, beforeC.games + 1);
      assert.equal(afterC.wins, beforeC.wins + 1);
    } finally {
      close(c1);
      close(c2);
      close(c3);
      await sleep(200);
    }
  });

  // 4) Test5：结束后立即可再次 Online Match（房间/绑定已清理）
  await check('Test5 结束后可再次匹配（A 重新入队得到新局）', async () => {
    const c1 = await connect(a.token);
    try {
      send(c1, { type: 'queue.join' });
      const start = await waitFor(c1, 'game.start', 5000);
      assert.equal(Object.values(start.seats).filter((s: any) => s.kind === 'human').length, 1, '未被僵尸房间占用');
    } finally {
      close(c1);
      await sleep(150);
    }
  });

  // 5) Test3：浏览器关闭/掉线 → 宽限期后判负（PLAYER_DISCONNECT），AI 不继续
  await check('Test3 掉线超宽限判负：PLAYER_DISCONNECT，AI 不继续，可重匹配', async () => {
    const c1 = await connect(a.token);
    let gameId = '';
    try {
      const before = await rankOf(a.id);
      send(c1, { type: 'queue.join' });
      const start = await waitFor(c1, 'game.start', 5000);
      gameId = start.gameId;
      assert.equal(Object.values(start.seats).filter((s: any) => s.kind === 'human').length, 1, '1H+2AI');
      close(c1); // 模拟关标签/刷新（服务器收到 close）
      const row = await pollUntil(() => {
        const r = matchRowOf(gameId);
        return r && r.end_reason !== 'NORMAL_WIN' ? r : null;
      }, 4000);
      assert.ok(row, '宽限后应终局');
      assert.equal(row.end_reason, 'PLAYER_DISCONNECT', '掉线超时 → PLAYER_DISCONNECT');
      assert.deepEqual(JSON.parse(row.loser_ids as string), [a.id]);
      assert.deepEqual(JSON.parse(row.winner_ids as string), [], 'AI 不获胜、不继续');
      const after = await rankOf(a.id);
      assert.equal(after.rating, before.rating - 10, '掉线判负 -10');
      assert.equal(after.games, before.games + 1);
      assert.equal(after.wins, before.wins);
      // 人类已离开 → AI 不应继续推进（无新 game 落盘）—— match 唯一行即判负行
      const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM games WHERE id = ?').get(gameId) as { n: number };
      assert.equal(rows.n, 1);
    } finally {
      await sleep(300);
    }
  });

  // 6) Test4：宽限内 resume → 恢复对局（不判负不掉分）
  await check('Test4 宽限内重连恢复：resume 续局不判负', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    const c3 = await connect(cTut.token);
    let cA2: TestClient | null = null;
    try {
      const before = await rankOf(a.id);
      const { gameId, seatOf, state } = await start3H([c1, c2, c3]);
      const aliceSeat = [...seatOf.entries()].find(([, cl]) => cl === c1)![0];
      const aliceClient = c1;
      const others = [...seatOf.entries()].filter(([, cl]) => cl !== c1).map(([, cl]) => cl);
      // 行动顺序恒为 A→B→C：先由座位 A 走一手（无论 A 是谁）
      const seatA = seatOf.get('A')!;
      const m0 = getLegalMoves(state)[5];
      send(seatA, { type: 'move', row: m0.row, col: m0.col });
      await Promise.all(others.map((c) => waitFor(c, 'game.state', 3000)));
      // Alice（无论其在 A/B/C）掉线 → 其他人收到 player.status
      close(aliceClient);
      const away = await Promise.all(others.map((c) => waitFor(c, 'player.status', 3000)));
      assert.ok(away.every((m) => m.status === 'disconnected'));
      // 宽限内（350ms）Alice 重连 + resume → 恢复对局，不判负
      cA2 = await connect(a.token);
      send(cA2, { type: 'resume', gameId });
      const resumed = await waitFor(cA2, 'game.start', 3000);
      assert.equal(resumed.gameId, gameId);
      assert.equal(resumed.yourSeat, aliceSeat);
      assert.ok(resumed.state.moves.length >= 1);
      assert.ok(resumed.qualification, 'resume 应携带 qualification');
      // 其他人收到 reconnected
      const back = await Promise.all(others.map((c) => waitFor(c, 'player.status', 3000)));
      assert.ok(back.every((m) => m.status === 'reconnected'));
      await sleep(500); // 越过原宽限时刻
      const ended = others.some((c) => c.msgs.some((m) => m.type === 'MATCH_ENDED'));
      assert.ok(!ended, '宽限内重连不应判负');
      assert.ok(!matchRowOf(gameId), '不应有判负落盘');
      const after = await rankOf(a.id);
      assert.equal(after.games, before.games, 'resume 恢复不应计分');
    } finally {
      close(c1);
      close(c2);
      close(c3);
      if (cA2) close(cA2);
      await sleep(600); // 全员关闭 → 宽限终局清理
    }
  });

  // 7) 3H 全员关闭 → 宽限终局清理后可再次匹配（替代旧「中止」语义）
  await check('3H 全员关闭：宽限后终局清理，用户可再次匹配', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    const c3 = await connect(cTut.token);
    try {
      await start3H([c1, c2, c3]);
      close(c1);
      close(c2);
      close(c3);
      await sleep(800); // > 宽限 350ms：首名离场者触发判负并清理全房间
    } finally {
      // 全员可再次匹配
      const cA = await connect(a.token);
      send(cA, { type: 'queue.join' });
      const start = await waitFor(cA, 'game.start', 5000);
      assert.equal(Object.values(start.seats).filter((s: any) => s.kind === 'human').length, 1);
      close(cA);
      await sleep(400);
    }
  });

  // 7.5) W4-T1/T2：game.start / game.state 携带 BAC qualification（服务器权威）
  await check('W4 BAC payload：开局 R1 NONE + 未来8轮；随回合推进自动更新', async () => {
    const c1 = await connect(a.token);
    try {
      send(c1, { type: 'queue.join' });
      const start = await waitFor(c1, 'game.start', 5000);
      const q0 = start.qualification as any;
      assert.ok(q0, 'game.start 应包含 qualification');
      assert.equal(q0.currentRound, 1);
      assert.equal(q0.currentEligible, null); // R1：NONE
      assert.equal(q0.upcoming.length, 8, '当前 + 未来 8 轮');
      assert.deepEqual(q0.upcoming[0], { round: 2, player: null });
      assert.deepEqual(q0.upcoming[4], { round: 6, player: 'C' }, '引擎真实输出：R6=C');
      assert.deepEqual(q0.upcoming[5], { round: 7, player: 'B' });
      assert.deepEqual(q0.upcoming[6], { round: 8, player: 'A' });
      // 推到 Round 6（turnIndex>=15）：每次 game.state 都带最新 qualification
      const me = start.yourSeat as string;
      maybeMove(c1, start.state, me); // 若先手是自己（seat A），用开局状态立即落子（否则无广播可驱动）
      const deadline = Date.now() + 40000;
      let reached: any = null;
      while (Date.now() < deadline && !reached) {
        const idx = c1.msgs.findIndex((m) => m.type === 'game.state');
        if (idx >= 0) {
          const msg = c1.msgs.splice(idx, 1)[0];
          if (msg.state.turnIndex >= 15) {
            reached = msg;
            break;
          }
          if (currentPlayerOf(msg.state) === me) maybeMove(c1, msg.state, me);
        } else {
          await sleep(20);
        }
      }
      assert.ok(reached, '应推进到 Round 6');
      assert.equal(reached.qualification.currentRound, 6);
      assert.equal(reached.qualification.currentEligible, 'C');
      assert.equal(reached.qualification.upcoming[0].round, 7);
      assert.equal(reached.qualification.upcoming[0].player, 'B');
    } finally {
      close(c1);
      await sleep(400); // 1H 局：离开宽限后判负清理
    }
  });

  // 7.6) W4-T3/T4/T6/T7：三玩家视角一致（多人同步）+ 断线重连后 qualification 恢复
  await check('W4 BAC 多人同步：三方 qualification 一致；resume 恢复 timeline', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    const c3 = await connect(cTut.token);
    let cA2: TestClient | null = null;
    try {
      const { gameId, seatOf, state } = await start3H([c1, c2, c3]);
      const seats = [seatOf.get('A')!, seatOf.get('B')!, seatOf.get('C')!];
      // 开局首手：A 用 game.start 状态落子（此后各回合由 game.state 广播驱动）
      maybeMove(seatOf.get('A')!, state, 'A');
      // 三方各自推进到 Round 6（自己回合才落子；turnIndex>=15 后停止）
      const seen = new Map<TestClient, any>();
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline && seen.size < 3) {
        for (const c of seats) {
          const owner = [...seatOf.entries()].find(([, cl]) => cl === c)?.[0];
          const idx = c.msgs.findIndex((m) => m.type === 'game.state');
          if (idx < 0) continue;
          const msg = c.msgs.splice(idx, 1)[0];
          if (msg.state.turnIndex >= 15) seen.set(c, msg);
          else if (owner && currentPlayerOf(msg.state) === owner) maybeMove(c, msg.state, owner);
        }
        await sleep(15);
      }
      assert.equal(seen.size, 3, '三方都应到达 Round 6');
      const quals = [...seen.values()].map((m) => m.qualification);
      assert.ok(quals.every((q) => q && q.currentRound === 6 && q.currentEligible === 'C'), '三方 qualification 一致（R6=C）');
      const q0 = quals[0];
      assert.ok(quals.every((q) => JSON.stringify(q) === JSON.stringify(q0)), '三方 payload 完全相同');
      // 断线 → 宽限内 resume → game.start 携带 qualification（刷新页面后 timeline 恢复）
      const aliceClient = [...seatOf.entries()].find(([, cl]) => cl === c1)![1];
      close(aliceClient);
      await sleep(120);
      cA2 = await connect(a.token);
      send(cA2, { type: 'resume', gameId });
      const resumed = await waitFor(cA2, 'game.start', 3000).catch((e) => {
        console.log('[diag] resume err msgs:', cA2?.msgs.map((m) => m.type + ':' + (m.error ?? '')).join(','));
        throw e;
      });
      assert.equal(resumed.gameId, gameId);
      assert.ok(resumed.qualification, 'resume 应恢复 qualification');
      assert.equal(resumed.qualification.currentRound, 6);
      assert.equal(resumed.qualification.currentEligible, 'C');
    } finally {
      close(c1);
      close(c2);
      close(c3);
      if (cA2) close(cA2);
      await sleep(700);
    }
  });

  // 7.7) Online 座位随机分配 + 全端一致（O1/O2/O3/O10/O11）
  await check('Online 座位随机分配 + 全端一致（3H 座位互异且 seats 完全一致）', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    const c3 = await connect(cTut.token);
    try {
      send(c1, { type: 'queue.join' });
      send(c2, { type: 'queue.join' });
      send(c3, { type: 'queue.join' });
      const [s1, s2, s3] = await Promise.all([waitFor(c1, 'game.start', 5000), waitFor(c2, 'game.start', 5000), waitFor(c3, 'game.start', 5000)]);
      assert.equal(s1.gameId, s2.gameId);
      assert.equal(s2.gameId, s3.gameId);
      const mySeats = [s1.yourSeat, s2.yourSeat, s3.yourSeat];
      assert.equal(new Set(mySeats).size, 3, '三个真人座位互异');
      assert.ok(mySeats.every((s) => ['A', 'B', 'C'].includes(s)), '座位 ∈ {A,B,C}');
      assert.deepEqual(s1.seats, s2.seats, '全端 seats 一致');
      assert.deepEqual(s2.seats, s3.seats, '全端 seats 一致');
    } finally {
      close(c1);
      close(c2);
      close(c3);
      await sleep(700);
    }
  });

  // 8) Test6：排行仅 Online 变化 — 好友局拒绝 PLAYER_RESIGN 且不计排位
  await check('Test6 好友局：PLAYER_RESIGN 被拒；不计排位（排行仅 Online）', async () => {
    const before = (await api('GET', '/api/ranking')).json.ranking.find((u: any) => u.id === a.id);
    const gamesBefore = before?.games ?? 0;
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    const inv = await api('POST', '/api/invite', { toUsername: 'Bob' }, a.token);
    assert.equal(inv.status, 201);
    const list = await api('GET', '/api/invitations', undefined, b.token);
    assert.equal(list.json.invitations.length, 1);
    const acc = await api('POST', '/api/invite/accept', { id: list.json.invitations[0].id }, b.token);
    assert.equal(acc.status, 200);
    const [gsA, gsB] = await Promise.all([waitFor(ca, 'game.start', 4000), waitFor(cb, 'game.start', 4000)]);
    assert.equal(gsA.mode, 'invite');
    assert.equal(gsA.gameId, gsB.gameId);
    const seats = Object.values(gsA.seats) as Array<{ kind: string }>;
    assert.equal(seats.filter((s) => s.kind === 'human').length, 2);
    assert.equal(seats.filter((s) => s.kind === 'ai').length, 1);
    const friends = await api('GET', '/api/friends', undefined, a.token);
    assert.ok(friends.json.friends.some((f: any) => f.username === 'Bob'));
    // 好友局不允许主动判负（无排位概念）
    send(ca, { type: 'PLAYER_RESIGN' });
    const err = await waitFor(ca, 'error', 3000);
    assert.match(err.error, /resign/i);
    const noEnd = ca.msgs.some((m) => m.type === 'MATCH_ENDED') || cb.msgs.some((m) => m.type === 'MATCH_ENDED');
    assert.ok(!noEnd, '好友局不应终局');
    close(ca);
    close(cb);
    await sleep(200);
    // 邀请局非排位：games 不应增加
    const after = (await api('GET', '/api/ranking')).json.ranking.find((u: any) => u.id === a.id);
    assert.equal(after?.games ?? 0, gamesBefore, '邀请局不计入排位 games');
  });

  // 9) Test7：AI 补位局人类退出 → 立即终局（AI 不继续），其他人类胜
  await check('Test7 AI 补位（2H+1AI）：A 退出即终局，B 胜、AI 不继续', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    try {
      const [beforeA, beforeB] = await Promise.all([rankOf(a.id), rankOf(b.id)]);
      send(c1, { type: 'queue.join' });
      send(c2, { type: 'queue.join' });
      const [s1, s2] = await Promise.all([waitFor(c1, 'game.start', 5000), waitFor(c2, 'game.start', 5000)]);
      assert.equal(s1.gameId, s2.gameId);
      const gameId = s1.gameId;
      const seats = Object.values(s1.seats) as Array<{ kind: string; stars?: number }>;
      assert.equal(seats.filter((s) => s.kind === 'human').length, 2);
      assert.equal(seats.filter((s) => s.kind === 'ai').length, 1);
      const aiSeat = seats.find((s) => s.kind === 'ai')!;
      assert.ok(aiSeat.stars === 4 || aiSeat.stars === 5, 'Online 2H+1AI 补位只允许 4★/5★');
      // 座位随机：以真实 yourSeat 定位 Alice（leaver）与 Bob（winner）
      const leaver = c1; // Alice
      const winner = c2; // Bob
      const leaverSeat = s1.yourSeat as string;
      const winnerSeat = s2.yourSeat as string;
      assert.notEqual(leaverSeat, winnerSeat);
      send(leaver, { type: 'PLAYER_RESIGN' });
      const [endL, endW] = await Promise.all([waitFor(leaver, 'MATCH_ENDED', 3000), waitFor(winner, 'MATCH_ENDED', 3000)]);
      assert.equal(endL.reason, 'PLAYER_FORFEIT');
      assert.equal(endW.reason, 'PLAYER_FORFEIT');
      assert.deepEqual(endL.loserSeats, [leaverSeat]);
      assert.deepEqual(endL.winnerSeats, [winnerSeat]);
      assert.deepEqual(endL.winnerIds, [b.id], '另一位人类胜（Bob）');
      assert.deepEqual(endL.loserIds, [a.id], '离场者 Alice');
      const row = await pollUntil(() => matchRowOf(gameId));
      assert.ok(row);
      assert.equal(row.end_reason, 'PLAYER_FORFEIT');
      // AI 不继续：终局后无任何 game.state/AI 落子
      const st = await drainUntil(winner, 'game.state', () => true, 500);
      assert.ok(!st, '人类退出后 AI 不应继续推进');
      const [afterA, afterB] = await Promise.all([rankOf(a.id), rankOf(b.id)]);
      assert.equal(afterA.rating, beforeA.rating - 10);
      assert.equal(afterA.games, beforeA.games + 1);
      assert.equal(afterB.rating, beforeB.rating + 30);
      assert.equal(afterB.games, beforeB.games + 1);
      assert.equal(afterB.wins, beforeB.wins + 1);
      // 胜者立即可再匹配（Test5 补充）
      send(winner, { type: 'queue.join' });
      const again = await waitFor(winner, 'game.start', 5000);
      assert.notEqual(again.gameId, gameId, '新对局应使用新 room');
    } finally {
      close(c1);
      close(c2);
      await sleep(600);
    }
  });

  // 10) 两个好友邀请：第二位接受后 → 三真人（无 AI）
  await check('两个好友接受 → 3 真人开局（无 AI）', async () => {
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    const cc = await connect(cTut.token);
    try {
      await api('POST', '/api/invite', { toUsername: 'Bob' }, a.token);
      await api('POST', '/api/invite', { toUsername: 'Carol' }, a.token);
      const listB = await api('GET', '/api/invitations', undefined, b.token);
      const listC = await api('GET', '/api/invitations', undefined, cTut.token);
      assert.equal(listB.json.invitations.length, 1);
      assert.equal(listC.json.invitations.length, 1);
      // 第一位接受 → 不应立即开局（GATHER 窗口 800ms）
      const accB = await api('POST', '/api/invite/accept', { id: listB.json.invitations[0].id }, b.token);
      assert.equal(accB.status, 200);
      await sleep(300);
      const early = ca.msgs.filter((m) => m.type === 'game.start');
      assert.equal(early.length, 0, '第一位接受后应进入 GATHER 等待，而非立即开局');
      // 第二位接受 → 3 真人开局
      const accC = await api('POST', '/api/invite/accept', { id: listC.json.invitations[0].id }, cTut.token);
      assert.equal(accC.status, 200);
      const [gsA, gsB, gsC] = await Promise.all([
        waitFor(ca, 'game.start', 4000),
        waitFor(cb, 'game.start', 4000),
        waitFor(cc, 'game.start', 4000),
      ]);
      assert.equal(gsA.gameId, gsB.gameId);
      assert.equal(gsB.gameId, gsC.gameId);
      const seats = Object.values(gsA.seats) as Array<{ kind: string }>;
      assert.ok(seats.every((s) => s.kind === 'human'), '两好友接受应为三真人');
      assert.equal(gsA.mode, 'invite');
    } finally {
      close(ca);
      close(cb);
      close(cc);
      await sleep(250);
    }
  });

  // 11) 两好友邀请但只来一位：等待窗超时 → 2H+1AI
  await check('两好友邀请仅 1 人接受：GATHER 超时后 2H+1AI', async () => {
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    try {
      await api('POST', '/api/invite', { toUsername: 'Bob' }, a.token);
      await api('POST', '/api/invite', { toUsername: 'Carol' }, a.token);
      const listB = await api('GET', '/api/invitations', undefined, b.token);
      await api('POST', '/api/invite/accept', { id: listB.json.invitations[0].id }, b.token);
      const gsA = await waitFor(ca, 'game.start', 5000);
      await waitFor(cb, 'game.start', 5000);
      const seats = Object.values(gsA.seats) as Array<{ kind: string }>;
      assert.equal(seats.filter((s) => s.kind === 'human').length, 2);
      assert.equal(seats.filter((s) => s.kind === 'ai').length, 1, '超时后补 AI');
    } finally {
      close(ca);
      close(cb);
      await sleep(250);
    }
  });

  // 12) 接受时双方未连接 WS：不应空转占用用户（可再次匹配）
  await check('离线接受邀请不产生空转房间（用户可再匹配）', async () => {
    // 不连接任何 WS 直接 accept
    const inv = await api('POST', '/api/invite', { toUsername: 'Bob' }, a.token);
    assert.equal(inv.status, 201);
    const listB = await api('GET', '/api/invitations', undefined, b.token);
    const acc = await api('POST', '/api/invite/accept', { id: listB.json.invitations[0].id }, b.token);
    assert.equal(acc.status, 200);
    await sleep(300);
    const c1 = await connect(a.token);
    send(c1, { type: 'queue.join' });
    const start = await waitFor(c1, 'game.start', 5000);
    assert.equal(Object.values(start.seats).filter((s: any) => s.kind === 'human').length, 1, '用户未被空转房间占用');
    close(c1);
    await sleep(200);
  });

  await sleep(200);
  wsHttp.close();
  apiServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nWS INTEGRATION: ALL PASS' : `\nWS INTEGRATION: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ws integration error:', e);
  process.exit(1);
});
