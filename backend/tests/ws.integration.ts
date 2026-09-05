/**
 * SRSZQ WebSocket 在线对局集成测试（真实 WS 多客户端）：
 *   npm run test:ws
 *
 * 覆盖：教学门禁 / 1H+2AI 补位（AI 星级隐藏）/ 权威落子与广播 / 断线重连 /
 *       3H 匹配 / 终局排位入账 / 邀请接受开局（2H+1AI、非排位）。
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

async function waitFor(c: TestClient, type: string, timeoutMs = 5000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const idx = c.msgs.findIndex((m) => m.type === type);
    if (idx >= 0) return c.msgs.splice(idx, 1)[0];
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

async function registerUser(name: string): Promise<{ token: string; id: string }> {
  const r = await api('POST', '/api/register', { email: `${name}@test.com`, username: name, password: 'secret1' });
  assert.equal(r.status, 201);
  return { token: r.json.token, id: r.json.user.id };
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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-ws-'));
  db = openDb(join(dir, 'test.sqlite'));

  const wsHttp = createServer();
  const gs = new GameServer(db, { queueTimeoutMs: 250, aiMoveDelayMs: 10, disconnectSkipMs: 250, aiTimeBudgetMs: 60 });
  gs.attach(wsHttp, '/ws');
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', r));
  wsBase = `ws://127.0.0.1:${(wsHttp.address() as AddressInfo).port}/ws`;

  const { server: apiServer } = createApi(db, { onInviteAccepted: (x, y) => gs.startInviteGame(x, y) });
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

  // 2) 1H + 2AI：开局校验（星级隐藏）→ 下到终局 → 排位入账
  await check('1H+2AI 补位开局：AI 只显示星级；终局排行入账', async () => {
    const c1 = await connect(a.token);
    try {
      send(c1, { type: 'queue.join' });
      const start = await waitFor(c1, 'game.start', 5000);
      const seats = Object.values(start.seats) as Array<{ kind: string; stars?: number; aiLevel?: string }>;
      assert.equal(seats.filter((s) => s.kind === 'human').length, 1);
      const ais = seats.filter((s) => s.kind === 'ai');
      assert.equal(ais.length, 2);
      assert.ok(ais.every((s) => typeof s.stars === 'number' && s.stars >= 1 && s.stars <= 5));
      assert.ok(ais.every((s) => !('aiLevel' in s)), '客户端不得见到真实 AI 档位');
      assert.equal(start.state.boardSize, 13);
      assert.equal(start.mode, 'online');
      const me = start.yourSeat as string;
      maybeMove(c1, start.state, me); // 若先手是自己（seat A），立即落子
      const deadline = Date.now() + 60000;
      let ended = false;
      while (Date.now() < deadline) {
        const idx = c1.msgs.findIndex((m) => m.type === 'game.end');
        if (idx >= 0) {
          c1.msgs.splice(idx, 1);
          ended = true;
          break;
        }
        const stIdx = c1.msgs.findIndex((m) => m.type === 'game.state');
        if (stIdx >= 0) {
          const msg = c1.msgs.splice(stIdx, 1)[0];
          maybeMove(c1, msg.state, me);
        } else {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      assert.ok(ended, '1H 对局应在时限内结束');
      const meInfo = await api('GET', '/api/me', undefined, a.token);
      const ranking = await api('GET', '/api/ranking');
      const row = ranking.json.ranking.find((u: any) => u.id === meInfo.json.user.id);
      assert.ok(row && row.games >= 1, '排位对局应计入 games');
    } finally {
      close(c1);
      await new Promise((r) => setTimeout(r, 150));
    }
  });

  // 3) 3H 匹配（无 AI 座位）
  await check('3 真人匹配开局（无 AI 座位）', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    const c3 = await connect(cTut.token);
    send(c1, { type: 'queue.join' });
    send(c2, { type: 'queue.join' });
    send(c3, { type: 'queue.join' });
    const [s1, s2, s3] = await Promise.all([
      waitFor(c1, 'game.start', 5000),
      waitFor(c2, 'game.start', 5000),
      waitFor(c3, 'game.start', 5000),
    ]);
    assert.equal(s1.gameId, s2.gameId);
    assert.equal(s2.gameId, s3.gameId);
    const seats = Object.values(s1.seats) as Array<{ kind: string }>;
    assert.ok(seats.every((s) => s.kind === 'human'));
    assert.equal(new Set([s1.yourSeat, s2.yourSeat, s3.yourSeat]).size, 3);
    // 全员退出 → 房间中止 → 用户可再次匹配
    close(c1);
    close(c2);
    close(c3);
    await new Promise((r) => setTimeout(r, 200));
  });

  // 4) 中止后可重新入队（证明状态清理）
  await check('房间中止后用户可再次匹配', async () => {
    const c1 = await connect(a.token);
    send(c1, { type: 'queue.join' });
    const start = await waitFor(c1, 'game.start', 5000);
    assert.equal(Object.values(start.seats).filter((s: any) => s.kind === 'human').length, 1);
    close(c1);
    await new Promise((r) => setTimeout(r, 150));
  });

  // 5) 权威落子与广播 + 断线自动跳过 + resume
  await check('落子广播；断线自动跳过；resume 续局', async () => {
    const c1 = await connect(a.token);
    const c2 = await connect(b.token);
    const c3 = await connect(cTut.token);
    let cA2: TestClient | null = null;
    try {
      send(c1, { type: 'queue.join' });
      send(c2, { type: 'queue.join' });
      send(c3, { type: 'queue.join' });
      const [s1, s2, s3] = await Promise.all([
        waitFor(c1, 'game.start', 5000),
        waitFor(c2, 'game.start', 5000),
        waitFor(c3, 'game.start', 5000),
      ]);
      const gameId = s1.gameId;
      const seatA = s1.yourSeat === 'A' ? c1 : s2.yourSeat === 'A' ? c2 : c3;
      const seatB = s1.yourSeat === 'B' ? c1 : s2.yourSeat === 'B' ? c2 : c3;
      const seatC = s1.yourSeat === 'C' ? c1 : s2.yourSeat === 'C' ? c2 : c3;
      assert.equal(s1.gameId, s2.gameId);
      assert.equal(s2.gameId, s3.gameId);
      const m0 = getLegalMoves(s1.state)[5];
      send(seatA, { type: 'move', row: m0.row, col: m0.col });
      const [stB, stC] = await Promise.all([waitFor(seatB, 'game.state', 3000), waitFor(seatC, 'game.state', 3000)]);
      assert.equal(stB.state.moves.length, 1);
      assert.equal(stC.state.moves.length, 1);
      // A 断线；当前轮到 B —— B、C 各走一手后轮到 A，触发自动跳过（disconnectSkipMs=250）
      close(seatA);
      assert.equal(currentPlayerOf(stB.state), 'B');
      const bMove = getLegalMoves(stB.state)[0];
      send(seatB, { type: 'move', row: bMove.row, col: bMove.col });
      const stAfterB = await waitFor(seatC, 'game.state', 3000);
      const cMove = getLegalMoves(stAfterB.state)[0];
      send(seatC, { type: 'move', row: cMove.row, col: cMove.col });
      // 消费 seatB 上的回显，直到轮到断线的 A
      const stAfterC = await drainUntil(seatB, 'game.state', (s) => currentPlayerOf(s.state) === 'A', 4000);
      assert.ok(stAfterC, '应轮到断线的 A');
      if (process.env.SRSZQ_WS_DEBUG) console.log('  [probe] seatB queued:', seatB.msgs.map((m) => `${m.type}${m.state ? `(m${m.state.moves.length})` : ''}`).join(','));
      // A 自动跳过（disconnectSkipMs=250）→ 出现 pass 推进状态
      const stSkipped = await drainUntil(seatB, 'game.state', (s) => s.state.moves.length > stAfterC.state.moves.length, 4000);
      assert.ok(stSkipped, 'A 应被自动跳过');
      // A resume 续局
      cA2 = await connect(a.token);
      send(cA2, { type: 'resume', gameId });
      const resumed = await waitFor(cA2, 'game.start', 3000);
      assert.equal(resumed.gameId, gameId);
      assert.ok(resumed.state.moves.length > 0);
    } finally {
      close(c1);
      close(c2);
      close(c3);
      if (cA2) close(cA2);
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  // 6) 邀请：发送 → 接受 → 2H+1AI 开局（非排位，好友关系建立）
  await check('邀请 accept 后开局（2H+1AI，非排位）', async () => {
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
    assert.equal(gsA.gameId, gsB.gameId);
    const seats = Object.values(gsA.seats) as Array<{ kind: string }>;
    assert.equal(seats.filter((s) => s.kind === 'human').length, 2);
    assert.equal(seats.filter((s) => s.kind === 'ai').length, 1);
    assert.equal(gsA.mode, 'invite');
    const friends = await api('GET', '/api/friends', undefined, a.token);
    assert.ok(friends.json.friends.some((f: any) => f.username === 'Bob'));
    close(ca);
    close(cb);
    await new Promise((r) => setTimeout(r, 200));
    // 邀请局非排位：games 不应增加
    const after = (await api('GET', '/api/ranking')).json.ranking.find((u: any) => u.id === a.id);
    assert.equal(after?.games ?? 0, gamesBefore, '邀请局不计入排位 games');
  });

  await new Promise((r) => setTimeout(r, 200));
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
