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
      const ca = seatOf.get('A')!;
      const seatB = seatOf.get('B')!;
      const seatC = seatOf.get('C')!;
      const which = (c: TestClient) => (ca === c ? 'A' : seatB === c ? 'B' : 'C');
      send(ca, { type: 'PLAYER_RESIGN' });
      // 全员（含离开者本人）都收到 MATCH_ENDED：reason=PLAYER_FORFEIT
      const [mA, mB, mC] = await Promise.all([
        waitFor(ca, 'MATCH_ENDED', 3000),
        waitFor(seatB, 'MATCH_ENDED', 3000),
        waitFor(seatC, 'MATCH_ENDED', 3000),
      ]);
      assert.equal(mA.reason, 'PLAYER_FORFEIT');
      assert.equal(mB.reason, 'PLAYER_FORFEIT');
      assert.equal(mC.reason, 'PLAYER_FORFEIT');
      assert.equal(mA.matchId, gameId);
      const leftSeat = which(ca);
      assert.deepEqual(mA.loserSeats, [leftSeat], '只有离开者是败者');
      assert.ok(mA.winnerSeats.length === 2 && !mA.winnerSeats.includes(leftSeat), '其余两个人类座位获胜');
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
      const seatA = seatOf.get('A')!;
      const seatB = seatOf.get('B')!;
      const seatC = seatOf.get('C')!;
      // A 先走一手
      const m0 = getLegalMoves(state)[5];
      send(seatA, { type: 'move', row: m0.row, col: m0.col });
      const [stB] = await Promise.all([waitFor(seatB, 'game.state', 3000), waitFor(seatC, 'game.state', 3000)]);
      assert.equal(stB.state.moves.length, 1);
      // A 掉线（此时轮到 B）→ 进入宽限期，B/C 收到 player.status
      close(seatA);
      const [awayB, awayC] = await Promise.all([
        waitFor(seatB, 'player.status', 3000),
        waitFor(seatC, 'player.status', 3000),
      ]);
      assert.equal(awayB.status, 'disconnected');
      assert.equal(awayC.status, 'disconnected');
      // B、C 各走一手后轮到 A（A 不在 → 暂停推进，不自动跳过）
      assert.equal(currentPlayerOf(stB.state), 'B');
      const bMove = getLegalMoves(stB.state)[0];
      send(seatB, { type: 'move', row: bMove.row, col: bMove.col });
      const stAfterB = await waitFor(seatC, 'game.state', 3000);
      const cMove = getLegalMoves(stAfterB.state)[0];
      send(seatC, { type: 'move', row: cMove.row, col: cMove.col });
      const stAfterC = await drainUntil(seatB, 'game.state', (s) => currentPlayerOf(s.state) === 'A', 4000);
      assert.ok(stAfterC, '应轮到断线的 A（暂停等待）');
      // 宽限内（350ms）A 重连 + resume
      cA2 = await connect(a.token);
      send(cA2, { type: 'resume', gameId });
      const resumed = await waitFor(cA2, 'game.start', 3000);
      assert.equal(resumed.gameId, gameId);
      assert.ok(resumed.state.moves.length > 0);
      // B/C 收到重连提示；宽限期已过也无判负
      const [backB, backC] = await Promise.all([waitFor(seatB, 'player.status', 3000), waitFor(seatC, 'player.status', 3000)]);
      assert.equal(backB.status, 'reconnected');
      assert.equal(backC.status, 'reconnected');
      await sleep(500); // 越过原宽限时刻
      const ended = seatB.msgs.some((m) => m.type === 'MATCH_ENDED') || seatC.msgs.some((m) => m.type === 'MATCH_ENDED');
      assert.ok(!ended, '宽限内重连不应判负');
      assert.ok(!matchRowOf(gameId), '不应有判负落盘');
      const after = await rankOf(a.id);
      assert.equal(after.games, before.games, 'resume 恢复不应计分');
      // 恢复后可继续：轮到 A 时 A 走一手，B/C 收到广播
      if (currentPlayerOf(resumed.state) === 'A') {
        const m = getLegalMoves(resumed.state)[0];
        send(cA2, { type: 'move', row: m.row, col: m.col });
        const st = await waitFor(seatB, 'game.state', 3000);
        assert.ok(st.state.moves.length > resumed.state.moves.length);
      }
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
      const seats = Object.values(s1.seats) as Array<{ kind: string }>;
      assert.equal(seats.filter((s) => s.kind === 'human').length, 2);
      assert.equal(seats.filter((s) => s.kind === 'ai').length, 1);
      // 找到两位人类各自的客户端并让 A 退出
      const humans = ['A', 'B', 'C'].filter((s) => (s1.seats as any)[s].kind === 'human');
      const leaverSeat = humans[0];
      const winnerSeat = humans[1];
      const leaver = leaverSeat === s1.yourSeat ? c1 : c2;
      const winner = winnerSeat === s1.yourSeat ? c1 : c2;
      send(leaver, { type: 'PLAYER_RESIGN' });
      const [endL, endW] = await Promise.all([waitFor(leaver, 'MATCH_ENDED', 3000), waitFor(winner, 'MATCH_ENDED', 3000)]);
      assert.equal(endL.reason, 'PLAYER_FORFEIT');
      assert.equal(endW.reason, 'PLAYER_FORFEIT');
      assert.deepEqual(endL.loserSeats, [leaverSeat]);
      assert.deepEqual(endL.winnerSeats, [winnerSeat]);
      assert.deepEqual(endL.winnerIds, [b.id], '另一位人类胜（此测试 leaver 恒为 Alice）');
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
