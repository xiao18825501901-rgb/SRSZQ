/**
 * 增量 B：Online Match 真人等待 60 秒 → 20 秒（服务器权威）。
 *
 * 这里做三件事，缺一不算过：
 *  1. 断言**真实默认值**就是 20000（不是只有测试环境才 20 秒）；
 *  2. 在真实默认配置下**真的等一次 20 秒**，记录 start / AI 补位 / elapsed；
 *  3. 顺便把“没碰 30 秒落子与 10 秒断线宽限”变成机器可断言的事实。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer, type GameServerOptions } from '../src/ws/gameServer.js';
import { DEFAULT_QUEUE_TIMEOUT_MS, resolveQueueTimeoutMs } from '../../shared/src/product/queuePolicy.js';
import { PROTOCOL_VERSION, RULESET_VERSION } from '../../shared/src/product/protocol.js';

let failures = 0;
const observed: Record<string, unknown> = {};

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx { db: Db; gs: GameServer; wsBase: string; apiBase: string; clients: TestClient[]; close: () => Promise<void> }

async function boot(opts: GameServerOptions = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-mm-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const gs = new GameServer(db, { aiMoveDelayMs: 5, aiTimeBudgetMs: 40, queueSweepMs: 50, ...opts });
  const wsHttp = createServer();
  gs.attach(wsHttp, '/ws');
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', r));
  const wsBase = 'ws://127.0.0.1:' + (wsHttp.address() as AddressInfo).port + '/ws';
  const { server: apiServer } = createApi(db, {
    onInviteCreated: (a, b) => gs.registerInvitation(a, b),
    onInviteAccepted: (a, b) => gs.handleInviteAccept(a, b),
    onInviteRejected: (a, b) => gs.onInviteRejected(a, b),
    onSessionRevoked: (uid, reason) => gs.revokeUserSession(uid, reason),
  });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  const apiBase = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;
  const clients: TestClient[] = [];
  return {
    db, gs, wsBase, apiBase, clients,
    close: async () => {
      // close() 会等所有连接结束，而 fetch 的 keep-alive 与 WS 长连接不会自己断。
      // 本地自检踩到过：不给上限就永久挂住——连 30 秒落子超时都触发了，Q2 的结论还没打印。
      // 所以收尾一律**有界**：超时就如实记一行继续，测试结论不能被收尾拖死。
      const bounded = async (label: string, fn: () => Promise<void>): Promise<void> => {
        const t0 = Date.now();
        await Promise.race([fn(), sleep(3000)]);
        if (Date.now() - t0 >= 3000) console.log('  [close-timeout] ' + label + ' 3s 内未结束，跳过等待');
      };
      // 顺序很关键：先关客户端 → 再关服务器 → 等收尾回调跑完 → **最后**关库。
      // 反过来会踩到：DB 先关，迟到的 WS close 事件触发 GameServer.onClose -> db.touchOnline，
      // 撞上已关闭的库抛 ERR_INVALID_STATE 把整个进程带走（本地自检踩到，整轮套件 FAIL）。
      await bounded('clients', async () => {
        for (const c of clients) { try { c.ws.close(); } catch { /* 已断开 */ } }
        await sleep(80);
      });
      await bounded('wsHttp', () => new Promise<void>((r) => { wsHttp.close(() => r()); wsHttp.closeAllConnections(); }));
      await bounded('apiServer', () => new Promise<void>((r) => { apiServer.close(() => r()); apiServer.closeAllConnections(); }));
      await sleep(200); // 给 onClose / touchOnline 这类收尾回调留出执行时间
      // 刻意**不关库**：AI 任务的回调可能还会写库（touchOnline/结算），
      // 关掉就会以 "database is not open" 把整个进程带走（本地自检踩到，整轮套件 FAIL）。
      // 每个用例用独立临时库，进程结束时统一退出即可。
      void db;
    },
  };
}

async function api(base: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

async function registerUser(base: string, name: string) {
  const r = await api(base, 'POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api(base, 'POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name };
}

interface TestClient { ws: WebSocket; msgs: Array<{ type: string; [k: string]: any }> }
function connect(ctx: Ctx, token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ctx.wsBase + '?token=' + token + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
    const msgs: TestClient['msgs'] = [];
    const client: TestClient = { ws, msgs };
    ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw))); });
    ctx.clients.push(client);
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
const send = (c: TestClient, msg: unknown) => c.ws.send(JSON.stringify(msg));
const closeClient = (c: TestClient) => { try { c.ws.close(); } catch { /* noop */ } };
async function waitFor(c: TestClient, type: string, timeoutMs = 8000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = c.msgs.findIndex((m) => m.type === type);
    if (i >= 0) return c.msgs.splice(i, 1)[0];
    await sleep(10);
  }
  throw new Error('timeout waiting ' + type + ' after ' + timeoutMs + 'ms; got ' + c.msgs.map((m) => m.type).join(','));
}
const seatKinds = (start: any): string[] => Object.values(start.seats as Record<string, { kind: string }>).map((s) => s.kind);
const countKind = (start: any, kind: string): number => seatKinds(start).filter((k) => k === kind).length;

async function main(): Promise<void> {
  console.log('--- Q1 默认值与解析规则 ---');

  await check('Q1 生产默认排队超时就是 20000ms（不是 60000，也不是只在测试里生效）', () => {
    assert.equal(DEFAULT_QUEUE_TIMEOUT_MS, 20_000, 'DEFAULT_QUEUE_TIMEOUT_MS 必须是 20000');
    assert.equal(resolveQueueTimeoutMs(undefined), 20_000, '没有环境变量时必须回落 20000');
    assert.equal(resolveQueueTimeoutMs(''), 20_000, '空字符串必须回落 20000');
    assert.equal(resolveQueueTimeoutMs('300'), 300, 'CI 可以用环境变量缩短');
    assert.equal(resolveQueueTimeoutMs('abc'), 20_000, '非法值必须回落默认，不能变成 NaN/0');
    assert.equal(resolveQueueTimeoutMs('-5'), 20_000, '负数必须回落默认');
    assert.equal(resolveQueueTimeoutMs(0), 20_000, '0 必须回落默认（否则排队窗口为 0）');
    const gs = new GameServer(openDb(join(mkdtempSync(join(tmpdir(), 'srszq-mm0-')), 't.sqlite')), {});
    assert.equal(gs.policySnapshot().queueTimeoutMs, 20_000, 'GameServer 默认必须是 20000');
    observed.q1 = gs.policySnapshot();
  });

  await check('Q6 30 秒落子倒计时与 10 秒断线宽限没有被这次改动碰到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srszq-mm6-'));
    const db = openDb(join(dir, 't.sqlite'));
    const gs = new GameServer(db, {});
    const snap = gs.policySnapshot();
    observed.q6 = snap;
    assert.equal(snap.turnTimeoutMs, 30_000, '落子倒计时必须仍是 30 秒');
    assert.equal(snap.forfeitGraceMs, 10_000, '断线宽限必须仍是 10 秒');
    assert.equal(snap.queueTimeoutMs, 20_000, '排队超时是 20 秒');
    assert.equal(snap.recoveryGraceMs, 60_000, '进程恢复窗口（另一个概念）保持 60 秒');
  });

  console.log('--- Q2 真实默认配置下的 20 秒冒烟（会真的等 20 秒） ---');

  await check('Q2 真实默认 20 秒：1 真人等待 → 超时后 2 AI 补位开局（记录 start/AI fill/elapsed）', async () => {
    const ctx = await boot(); // 不传 queueTimeoutMs：用真实默认
    try {
      const u = await registerUser(ctx.apiBase, 'QTimeSolo');
      const c = await connect(ctx, u.token);
      const t0 = Date.now();
      send(c, { type: 'queue.join' });
      const joined = await waitFor(c, 'queue.joined', 5000);
      const tJoined = Date.now();
      assert.equal(joined.timeoutMs, 20_000, '服务器下发的 timeoutMs 必须是 20000，实际 ' + joined.timeoutMs);
      const declared = Number(joined.deadlineAt) - Number(joined.enqueuedAt);
      assert.ok(Math.abs(declared - 20_000) <= 250, 'deadlineAt-enqueuedAt 必须是 20 秒，实际 ' + declared);
      const start = await waitFor(c, 'game.start', 30_000);
      const tStart = Date.now();
      const aiCount = countKind(start, 'ai');
      const humanCount = countKind(start, 'human');
      const elapsed = tStart - t0;
      observed.q2 = {
        declaredTimeoutMs: joined.timeoutMs, declaredWindowMs: declared,
        joinAckMs: tJoined - t0, aiFillAndStartMs: elapsed,
        humanCount, aiCount,
      };
      assert.equal(humanCount, 1, '只有 1 名真人');
      assert.equal(aiCount, 2, '1 真人必须补 2 AI，实际 ' + aiCount);
      assert.ok(elapsed >= 19_000, '必须真的等到约 20 秒才补位，实际 ' + elapsed + 'ms');
      assert.ok(elapsed <= 26_000, '不能在 20 秒之外还拖着，实际 ' + elapsed + 'ms');
      // 落子倒计时仍是 30 秒：这里**不能**无条件断言。
      // 座位是随机的，人类若不是第一个行动的人，game.start 时 turnDeadlineAt 合法地为 null
      // （倒计时是从轮到人类那一刻开始算的）。30 秒口径由 Q6 的策略快照确定性地断言。
      const turnMs = start.turnDeadlineAt == null ? null : Number(start.turnDeadlineAt) - Number(start.serverNow);
      if (turnMs !== null) assert.ok(Math.abs(turnMs - 30_000) <= 1500, '落子倒计时必须约 30 秒，实际 ' + turnMs);
      (observed.q2 as Record<string, unknown>).turnDeadlineMs = turnMs;
      // 收尾前主动离队，避免留一个等落子的房间拖住进程。
      try { send(c, { type: 'queue.leave' }); } catch { /* 已断开 */ }
      closeClient(c);
    } finally { await ctx.close(); }
  });

  console.log('--- Q3/Q4/Q5 匹配编排（CI 用短 override） ---');

  await check('Q3 2 真人 + 超时 → 1 AI 补位（CI 用 300ms override）', async () => {
    const ctx = await boot({ queueTimeoutMs: 300 });
    try {
      assert.equal(ctx.gs.policySnapshot().queueTimeoutMs, 300, 'override 必须生效');
      const a = await registerUser(ctx.apiBase, 'QTimeA');
      const b = await registerUser(ctx.apiBase, 'QTimeB');
      const ca = await connect(ctx, a.token);
      const cb = await connect(ctx, b.token);
      const t0 = Date.now();
      send(ca, { type: 'queue.join' });
      await waitFor(ca, 'queue.joined', 5000);
      send(cb, { type: 'queue.join' });
      const startA = await waitFor(ca, 'game.start', 10_000);
      const startB = await waitFor(cb, 'game.start', 10_000);
      assert.equal(countKind(startA, 'human'), 2, '2 真人必须同局');
      assert.equal(countKind(startA, 'ai'), 1, '2 真人补 1 AI');
      assert.equal(startA.gameId, startB.gameId, '两名真人必须在同一局');
      observed.q3 = { humanCount: countKind(startA, 'human'), aiCount: countKind(startA, 'ai'), elapsedMs: Date.now() - t0 };
      closeClient(ca); closeClient(cb);
    } finally { await ctx.close(); }
  });

  await check('Q4 3 真人到齐立即开局，不等超时（超时设 5 秒，开局必须远早于它）', async () => {
    const ctx = await boot({ queueTimeoutMs: 5000 });
    try {
      const us = [await registerUser(ctx.apiBase, 'QTimeX'), await registerUser(ctx.apiBase, 'QTimeY'), await registerUser(ctx.apiBase, 'QTimeZ')];
      const cs = [await connect(ctx, us[0].token), await connect(ctx, us[1].token), await connect(ctx, us[2].token)];
      const t0 = Date.now();
      for (const c of cs) send(c, { type: 'queue.join' });
      const start = await waitFor(cs[0], 'game.start', 8000);
      const elapsed = Date.now() - t0;
      assert.equal(countKind(start, 'human'), 3, '3 真人必须全真人开局');
      assert.equal(countKind(start, 'ai'), 0, '3 真人不应有 AI');
      assert.ok(elapsed < 4000, '3 真人到齐必须立即开局，实际 ' + elapsed + 'ms（超时设的是 5000ms）');
      observed.q4 = { humanCount: 3, aiCount: 0, elapsedMs: elapsed };
      for (const c of cs) closeClient(c);
    } finally { await ctx.close(); }
  });

  await check('Q5 退出排队不算弃权：没有开局、没有结算，且可以重新排队', async () => {
    const ctx = await boot({ queueTimeoutMs: 400 });
    try {
      const u = await registerUser(ctx.apiBase, 'QTimeLeave');
      const c = await connect(ctx, u.token);
      send(c, { type: 'queue.join' });
      await waitFor(c, 'queue.joined', 5000);
      send(c, { type: 'queue.leave' });
      await sleep(900); // 超过 400ms 的排队超时：留在队列里的话这会儿已经开局了
      assert.equal(c.msgs.filter((m) => m.type === 'game.start').length, 0, '退出排队后不得开局');
      assert.equal(c.msgs.filter((m) => m.type === 'game.end').length, 0, '退出排队不得产生终局/弃权');
      const live = ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM live_games').get() as { n: number };
      const results = ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM match_results').get() as { n: number };
      assert.equal(Number(live.n), 0, '不应存在进行中的对局');
      assert.equal(Number(results.n), 0, '不应存在结算记录（退出排队不是弃权）');
      const rating = ctx.db.raw.prepare('SELECT rating FROM users WHERE id = ?').get(u.id) as { rating: number };
      assert.equal(Number(rating.rating), 1200, '退出排队不得扣分');
      // 重新排队仍然正常（没有把自己锁死）
      send(c, { type: 'queue.join' });
      const rejoined = await waitFor(c, 'queue.joined', 5000);
      assert.ok(rejoined.queueId, '重新排队必须成功');
      const start = await waitFor(c, 'game.start', 8000);
      assert.equal(countKind(start, 'ai'), 2, '重新排队后仍然按 1 真人补 2 AI');
      observed.q5 = { liveGames: Number(live.n), results: Number(results.n), ratingAfterLeave: Number(rating.rating), requeueOk: true };
      closeClient(c);
    } finally { await ctx.close(); }
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));
  if (failures === 0) console.log('MATCHMAKING: ALL PASS 0');
  else console.log('MATCHMAKING: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
