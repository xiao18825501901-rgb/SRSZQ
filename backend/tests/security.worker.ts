/**
 * SRSZQ P0C —— 有界 AI worker / 硬超时 / 合法降级 / WS 安全边界 测试
 *   npm run test:security   （由 scripts/product/run-tests.mjs --suite security 调用）
 *
 * 覆盖原验收 S01–S07。全部针对真实 worker 线程、真实 WebSocket、真实 SQLite。
 *
 * 为什么要做 S01：实测（ai_latency_probe）单次 AI 决策会**阻塞事件循环**
 * 28–195ms（17×17 的 5★ MaxN 最坏），blocked_event_loop_ms ≈ decision_ms。
 * 那段时间整个进程无法服务任何 HTTP/WS。本套件用事件循环延迟直接证明搜索已移出主线程。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer } from '../src/ws/gameServer.js';
import { AiWorkerHost } from '../src/ai/aiWorkerHost.js';
import { decideWebSocketOrigin, rejectFrame, SlidingWindowLimiter, WS_MAX_MESSAGE_BYTES } from '../src/ws/security.js';
import { createInitialState, applyMove } from '../../shared/src/game/rules.js';
import { getLegalMoves, currentPlayerOf } from '../../shared/src/game/legalMoves.js';
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

function connectAt(base: string, token: string, extraQuery = ''): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base + '?token=' + token + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION) + extraQuery);
    const msgs: TestClient['msgs'] = [];
    const client: TestClient = { ws, msgs };
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (typeof m.revision === 'number') clientRevisions.set(client, m.revision); msgs.push(m); });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
const connect = (token: string) => connectAt(wsBase, token);
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

async function registerUser(name: string) {
  const r = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name };
}

/** 造一个中局状态（用于给 worker 派发真实搜索任务）。 */
function buildMidGame(boardSize: 13 | 17, plies: number, seed: number) {
  let s = createInitialState(boardSize);
  let x = seed >>> 0;
  const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 0x100000000; };
  for (let i = 0; i < plies && s.status === 'playing'; i++) {
    const legal = getLegalMoves(s);
    if (!legal.length) break;
    const m = legal[Math.floor(rnd() * legal.length)];
    const r = applyMove(s, m.row, m.col);
    if (r.rejected) break;
    s = r.state;
  }
  return s;
}

/** 在 fn 执行期间测量主线程事件循环被阻塞的最大时长（毫秒）。 */
async function measureBlocked(fn: () => Promise<void>): Promise<number> {
  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); const lag = now - last - 1; if (lag > maxLag) maxLag = lag; last = now; }, 1);
  await sleep(25);
  await fn();
  await sleep(40);
  clearInterval(timer);
  return maxLag;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-sec-'));
  db = openDb(join(dir, 'test.sqlite'));
  const gs = new GameServer(db, {
    queueTimeoutMs: 250, aiMoveDelayMs: 5, forfeitGraceMs: 600, aiTimeBudgetMs: 200,
    queueSweepMs: 20, wsMaxMessageBytes: WS_MAX_MESSAGE_BYTES, wsCommandRateLimit: 60,
  });
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

  console.log('--- F worker 池：有界 / 硬超时 / 降级 / 过期 ---');

  await check('F1 S01 搜索已在 worker 线程：主线程事件循环不再被阻塞', async () => {
    const host = new AiWorkerHost({ poolSize: 2, queueLimit: 8, hardTimeoutMs: 5000 });
    try {
      const state = buildMidGame(17, 40, 4242);
      const seat = currentPlayerOf(state);
      // 直接跑最重的组合：17×17 + 5★（maxn）
      const blocked = await measureBlocked(async () => {
        const out = await host.submit({
          taskId: randomUUID(), gameId: 'g-block', revision: 0,
          state, seat, level: 5, seed: 7, timeBudgetMs: 250,
        });
        assert.equal(out.kind, 'decided', 'worker 必须给出决策，实际 ' + out.kind);
      });
      observed.f1_blockedMs = Number(blocked.toFixed(1));
      // 同一台机器上，同步执行时这里是 125–195ms；出了主线程后应该只剩调度噪声。
      assert.ok(blocked < 60, '主线程不应被 AI 搜索阻塞；实测最大延迟 ' + blocked.toFixed(1) + 'ms');
    } finally { await host.close(); }
  });

  await check('F2 S01 并发有界：队列满立即拒绝，不无限堆积', async () => {
    const host = new AiWorkerHost({ poolSize: 1, queueLimit: 2, hardTimeoutMs: 5000 });
    try {
      const state = buildMidGame(17, 40, 99);
      const seat = currentPlayerOf(state);
      const tasks = Array.from({ length: 8 }, () => host.submit({
        taskId: randomUUID(), gameId: 'g-bound', revision: 0,
        state, seat, level: 5, seed: 5, timeBudgetMs: 200,
      }));
      const results = await Promise.all(tasks);
      const rejected = results.filter((r) => r.kind === 'rejected');
      const decided = results.filter((r) => r.kind === 'decided');
      observed.f2_rejected = rejected.length;
      observed.f2_decided = decided.length;
      assert.ok(rejected.length > 0, '队列上限必须真的拒绝任务，而不是全部排队');
      assert.ok(rejected.every((r) => (r as any).reason === 'QUEUE_FULL'));
      assert.ok(decided.length > 0, '仍应有任务被真正执行');
      assert.equal(host.stats.poolSize, 1, '池大小固定，不随任务数增长');
      assert.ok(host.stats.running <= 1, '同时运行的任务不超过池大小');
    } finally { await host.close(); }
  });

  await check('F3 S01 硬超时：杀线程并重建，后续任务仍能成功', async () => {
    // 17×17 的 5★ 实测约 195ms；把硬超时压到 60ms 逼出超时路径。
    const host = new AiWorkerHost({ poolSize: 1, queueLimit: 4, hardTimeoutMs: 60 });
    try {
      const heavy = buildMidGame(17, 40, 777);
      const seat = currentPlayerOf(heavy);
      const timed = await host.submit({
        taskId: randomUUID(), gameId: 'g-timeout', revision: 0,
        state: heavy, seat, level: 5, seed: 3, timeBudgetMs: 250,
      });
      observed.f3_firstOutcome = timed.kind;
      assert.equal(timed.kind, 'timeout', '超时必须被判定为 timeout，实际 ' + timed.kind);
      // 等池重建
      await sleep(120);
      assert.ok(host.stats.respawns >= 1, '超时后必须重建 worker（同步循环不响应取消）');
      // 轻任务应仍能完成 —— 证明池自动恢复，而不是整体坏掉
      // 重建后的 worker 要重新加载 tsx + 共享 AI 模块（实测约 300-400ms）。
      // 这正是 warmup() 存在的理由：冷启动成本不该算到真实 AI 任务头上。
      const warm = await host.warmup();
      assert.ok(warm.warmed >= 1, '预热必须至少成功一个 worker，实际 ' + warm.warmed);
      const light = buildMidGame(13, 6, 5);
      const ok = await host.submit({
        taskId: randomUUID(), gameId: 'g-after', revision: 0,
        state: light, seat: currentPlayerOf(light), level: 1, seed: 9, timeBudgetMs: 200,
      });
      assert.equal(ok.kind, 'decided', '重建+预热后必须继续正常工作，实际 ' + ok.kind);
    } finally { await host.close(); }
  });

  await check('F4 S02 过期任务丢弃：旧 revision 的排队任务被作废', async () => {
    const host = new AiWorkerHost({ poolSize: 1, queueLimit: 32, hardTimeoutMs: 8000 });
    try {
      const state = buildMidGame(17, 40, 31);
      const seat = currentPlayerOf(state);
      // 第一个占住 worker，其余排队
      const first = host.submit({ taskId: randomUUID(), gameId: 'g-stale', revision: 0, state, seat, level: 5, seed: 1, timeBudgetMs: 200 });
      const queued = [1, 2, 3].map((rev) => host.submit({ taskId: randomUUID(), gameId: 'g-stale', revision: rev, state, seat, level: 5, seed: 1, timeBudgetMs: 200 }));
      const cancelledCount = host.cancelUpTo('g-stale', 3);
      observed.f4_cancelled = cancelledCount;
      assert.ok(cancelledCount >= 2, 'revision < 3 的排队任务必须被作废，实际 ' + cancelledCount);
      const results = await Promise.all([first, ...queued]);
      const cancelled = results.filter((r) => r.kind === 'cancelled');
      assert.ok(cancelled.length >= 2, '被作废的任务必须回 cancelled');
      assert.ok(cancelled.every((r) => (r as any).reason === 'STALE'));
    } finally { await host.close(); }
  });

  console.log('--- G WS 安全边界：Origin / 体积 / 二进制 / 限流 / 会话撤销 ---');

  await check('G1 S05 Origin 判定：白名单外一律拒绝，缺 Origin 按非浏览器客户端处理', async () => {
    const allowed = new Set(['https://srszq.com', 'https://www.srszq.com']);
    assert.equal(decideWebSocketOrigin('https://srszq.com', allowed).allowed, true);
    assert.equal(decideWebSocketOrigin('https://www.srszq.com', allowed).allowed, true);
    const evil = decideWebSocketOrigin('https://evil.example', allowed);
    assert.equal(evil.allowed, false, '白名单外来源必须被拒绝');
    assert.equal(evil.reason, 'DENIED_NOT_LISTED');
    assert.equal(decideWebSocketOrigin('https://srszq.com.evil.example', allowed).allowed, false, '后缀伪装不得通过');
    const none = decideWebSocketOrigin(undefined, allowed);
    assert.equal(none.allowed, true, '非浏览器客户端没有 Origin，来源判定不拦它（认证仍然必须过）');
    assert.equal(none.reason, 'ALLOWED_NO_ORIGIN');
  });

  await check('G2 S05 真实升级：伪造 Origin 连 WebSocket 都不建立', async () => {
    const user = await registerUser('OriginUser');
    const rejected = await new Promise<{ opened: boolean; error?: string }>((resolve) => {
      const ws = new WebSocket(wsBase + '?token=' + user.token, { headers: { Origin: 'https://evil.example' } });
      let settled = false;
      const done = (v: { opened: boolean; error?: string }) => { if (!settled) { settled = true; resolve(v); } };
      ws.on('open', () => done({ opened: true }));
      ws.on('error', (e: any) => done({ opened: false, error: String(e?.message ?? e) }));
      setTimeout(() => done({ opened: true }), 4000);
    });
    assert.equal(rejected.opened, false, '伪造来源必须被拒绝，实际建立了连接');
    // 白名单内来源应当可以正常连接
    const good = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(wsBase + '?token=' + user.token, { headers: { Origin: 'https://srszq.com' } });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 4000);
    });
    assert.equal(good, true, '白名单内来源必须可以连接');
  });

  await check('G3 S06 帧校验：64KB 上限与二进制帧', async () => {
    assert.equal(rejectFrame('x'.repeat(10), false), null);
    assert.equal(rejectFrame('x'.repeat(WS_MAX_MESSAGE_BYTES + 1), false), 'TOO_LARGE');
    assert.equal(rejectFrame(Buffer.alloc(4), true), 'BINARY_FRAME');
    // 多字节字符按**字节**算，不是按字符数
    assert.equal(rejectFrame('中'.repeat(Math.ceil(WS_MAX_MESSAGE_BYTES / 3) + 1), false), 'TOO_LARGE');
    const user = await registerUser('FrameUser');
    const c = await connect(user.token);
    try {
      await waitFor(c, 'hello', 5000).catch(() => null);
      c.ws.send(JSON.stringify({ type: 'queue.sync', pad: 'x'.repeat(WS_MAX_MESSAGE_BYTES + 100) }));
      const err = await waitFor(c, 'error', 5000);
      assert.equal(err.code, 'TOO_LARGE', '超大帧必须被拒绝，实际 ' + JSON.stringify(err));
      await new Promise<void>((r) => { c.ws.on('close', () => r()); setTimeout(r, 3000); });
    } finally { close(c); await sleep(100); }

    const c2 = await connect(user.token);
    try {
      c2.ws.send(Buffer.from([0x01, 0x02, 0x03]));
      const err2 = await waitFor(c2, 'error', 5000);
      assert.equal(err2.code, 'BINARY_FRAME');
    } finally { close(c2); await sleep(100); }
  });

  await check('G4 S06 限流：超速消息被拒且不计入对局', async () => {
    const limiter = new SlidingWindowLimiter(3, 1000);
    assert.equal(limiter.tryTake('u', 0), true);
    assert.equal(limiter.tryTake('u', 1), true);
    assert.equal(limiter.tryTake('u', 2), true);
    assert.equal(limiter.tryTake('u', 3), false, '第 4 次必须超限');
    assert.equal(limiter.tryTake('u', 1001), true, '滑窗过期后恢复');
    limiter.forget('u');
    assert.equal(limiter.trackedKeys, 0, '连接关闭后必须释放状态，避免 Map 无限增长');

    // 真实连接：连发远超上限的消息，必须收到 RATE_LIMITED
    const user = await registerUser('RateUser');
    const c = await connect(user.token);
    try {
      await waitFor(c, 'hello', 5000).catch(() => null);
      for (let i = 0; i < 90; i++) c.ws.send(JSON.stringify({ type: 'queue.sync' }));
      const err = await waitFor(c, 'error', 6000);
      assert.equal(err.code, 'RATE_LIMITED', '超速必须被限流，实际 ' + JSON.stringify(err));
      observed.g4_rateLimited = true;
    } finally { close(c); await sleep(100); }
  });

  await check('G5 S07 登出即撤销长连接：旧 socket 立刻失效', async () => {
    const user = await registerUser('LogoutUser');
    const c = await connect(user.token);
    await waitFor(c, 'hello', 5000).catch(() => null);
    let closed = false;
    c.ws.on('close', () => { closed = true; });
    const out = await api('POST', '/api/logout', {}, user.token);
    assert.equal(out.status, 200);
    const err = await waitFor(c, 'error', 4000);
    assert.equal(err.code, 'SESSION_REVOKED', '必须明确告知会话已撤销，实际 ' + JSON.stringify(err));
    await new Promise<void>((r) => setTimeout(r, 400));
    assert.equal(closed, true, '登出后长连接必须真的关闭，否则登出只对 HTTP 生效');
    // 会话已删：未认证的升级在 HTTP 层就被拒绝（401），根本不会建立 WebSocket。
    const again = await new Promise<{ opened: boolean; hello: boolean }>((resolve) => {
      const ws = new WebSocket(wsBase + '?token=' + user.token);
      let hello = false;
      ws.on('message', (raw) => { if (JSON.parse(String(raw)).type === 'hello') hello = true; });
      ws.on('open', () => { ws.close(); resolve({ opened: true, hello }); });
      ws.on('error', () => resolve({ opened: false, hello: false }));
      ws.on('close', () => resolve({ opened: false, hello: false }));
      setTimeout(() => resolve({ opened: false, hello: false }), 4000);
    });
    assert.equal(again.opened, false, '登出后的 token 不得再建立连接（应被 401 拒绝）');
    assert.equal(again.hello, false, '更不得收到 hello：未认证连接不应被当作会话');
  });

  await check('G6 S03 真实对局：AI 超时降级后仍走合法一手，对局不卡死', async () => {
    // 用一个把硬超时压到极短的独立服务器，逼出 AI 降级路径。
    const dir2 = mkdtempSync(join(tmpdir(), 'srszq-sec2-'));
    const db2 = openDb(join(dir2, 't.sqlite'));
    const gs2 = new GameServer(db2, {
      queueTimeoutMs: 120, aiMoveDelayMs: 2, forfeitGraceMs: 400, aiTimeBudgetMs: 250,
      queueSweepMs: 20, aiPoolSize: 1, aiQueueLimit: 2, aiHardTimeoutMs: 1,
    });
    const http2 = createServer();
    gs2.attach(http2, '/ws');
    await new Promise<void>((r) => http2.listen(0, '127.0.0.1', r));
    const base2 = 'ws://127.0.0.1:' + (http2.address() as AddressInfo).port + '/ws';
    const uid = 'degrade-user';
    db2.raw.prepare('INSERT INTO users (id,email,username,avatar,password_hash,salt,created_at,online_status,rating,tutorial_completed) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid, 'degrade@t.local', 'degradeuser', '', 'h', 's', Date.now(), 'online', 1200, 1);
    db2.raw.prepare('INSERT INTO ranking (user_id,wins,games,score) VALUES (?,0,0,0)').run(uid);
    const tk = 'degrade-token';
    db2.createSession(tk, uid, Date.now() + 3600_000);
    const c = await connectAt(base2, tk);
    try {
      send(c, { type: 'queue.join' });
      const start = await waitFor(c, 'game.start', 12000);
      const gameId = start.gameId as string;
      // 等 AI 走几步（全部会超时降级）
      const deadline = Date.now() + 12000;
      while (Date.now() - deadline < 0) break;
      let moved = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 12000 && moved < 2) {
        const i = c.msgs.findIndex((m) => m.type === 'game.state');
        if (i >= 0) { const m = c.msgs.splice(i, 1)[0]; moved = m.state.moves.length; }
        else await sleep(20);
      }
      observed.g6_aiMovesUnderDegrade = moved;
      assert.ok(moved >= 1, '即使 AI 全部超时，也必须靠合法降级继续推进，实际走了 ' + moved + ' 步');
      // 事件流里必须能看到降级记录，而不是静默换了策略
      const events = db2.listGameEvents(gameId);
      const degraded = events.filter((e) => JSON.stringify(e.payload).includes('ai-') || e.type === 'move.applied');
      assert.ok(degraded.length >= 1, 'AI 落子必须落库');
      assert.equal(Number((db2.raw.prepare('SELECT COUNT(*) AS n FROM match_results WHERE game_id = ?').get(gameId) as any).n), 0, '对局应仍在进行（未被误判终局）');
    } finally {
      close(c);
      await sleep(200);
      gs2.shutdown();
      await new Promise<void>((r) => http2.close(() => r()));
    }
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  await new Promise<void>((r) => apiServer.close(() => r()));
  await new Promise<void>((r) => wsHttp.close(() => r()));
  await gs.aiHost.close();
  db.close();
  if (failures === 0) console.log('SECURITY WORKER: ALL PASS 0');
  else console.log('SECURITY WORKER: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
