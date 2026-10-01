/**
 * S04 —— WebSocket 一次性认证票据。
 *   npm run test:product --suite wsticket
 *
 * 规格原文（S04）：30 秒过期 / 单次、重复消费拒绝；**session/ticket 不出现在 URL 或日志**。
 *
 * 本套件全部打真实服务器：真 HTTP 换票、真 WS 握手、真并发抢同一张票。
 * 票据走 WebSocket **子协议头**（Sec-WebSocket-Protocol）而不是查询串 —— 这是这条规格的关键：
 * URL 会进反向代理访问日志、浏览器历史与 Referer。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer } from '../src/ws/gameServer.js';
import { PROTOCOL_VERSION, RULESET_VERSION, WS_TICKET_PROTOCOL_PREFIX, WS_TICKET_TTL_MS } from '../../shared/src/product/protocol.js';

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

async function api(method: string, path: string, body?: unknown, token?: string, cookie?: string) {
  const res = await fetch(apiBase + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = {};
  try { json = await res.json(); } catch { /* 允许空响应 */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') ?? '' };
}

/** 用票据子协议握手；失败时把 HTTP 状态码带出来（未授权升级会直接返回 401）。 */
function connectWithTicket(ticket: string, extra?: { headers?: Record<string, string> }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '?protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION),
      [WS_TICKET_PROTOCOL_PREFIX + ticket], extra);
    const t = setTimeout(() => { ws.terminate(); reject(new Error('handshake timeout')); }, 8000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); reject(new Error('HTTP ' + res.statusCode)); });
  });
}

/** 老路径：\`?token=\`（过渡兼容，S04 的目标是产品前端不再用它）。 */
function connectLegacy(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '?token=' + token + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
    const t = setTimeout(() => { ws.terminate(); reject(new Error('handshake timeout')); }, 8000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); reject(new Error('HTTP ' + res.statusCode)); });
  });
}

/** 一键账号的路径：HttpOnly cookie，URL 里什么都不带。 */
function connectCookie(cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '?protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION),
      { headers: { Cookie: cookie } });
    const t = setTimeout(() => { ws.terminate(); reject(new Error('handshake timeout')); }, 8000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); reject(new Error('HTTP ' + res.statusCode)); });
  });
}

function collect(ws: WebSocket): Array<Record<string, any>> {
  const msgs: Array<Record<string, any>> = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(String(raw))); } catch { /* 忽略非 JSON */ } });
  return msgs;
}
async function waitMsg(msgs: Array<Record<string, any>>, type: string, timeoutMs = 6000): Promise<Record<string, any> | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = msgs.find((m) => m.type === type);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

async function registerUser(name: string) {
  const r = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, cookie: (r.setCookie.match(/srszq_sid=[^;]+/) ?? [''])[0] };
}

const ticketHash = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

async function main(): Promise<void> {
  mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'srszq-wst-'));
  db = openDb(join(dir, 'test.sqlite'));
  const gs = new GameServer(db, {
    queueTimeoutMs: 300, aiMoveDelayMs: 5, forfeitGraceMs: 500, aiTimeBudgetMs: 200,
    queueSweepMs: 20, wsMaxMessageBytes: 1 << 20, wsCommandRateLimit: 120,
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

  const u = await registerUser('WsTicketUser');

  await check('T1 未认证不能换票：POST /api/ws/ticket 必须 401', async () => {
    const r = await api('POST', '/api/ws/ticket');
    assert.equal(r.status, 401, '未认证必须 401，实际 ' + r.status);
    assert.equal(r.json.ticket, undefined, '未认证不得下发票据');
  });

  await check('T2 票据可用于握手，且连接真的可用（能入队收到 queue.joined）', async () => {
    const t = await api('POST', '/api/ws/ticket', {}, u.token);
    assert.equal(t.status, 201, '换票必须 201，实际 ' + t.status);
    observed.t2 = { ttlMs: t.json.ttlMs, ticketLen: String(t.json.ticket).length };
    assert.equal(t.json.ttlMs, WS_TICKET_TTL_MS, 'TTL 必须是 30 秒');
    const ws = await connectWithTicket(t.json.ticket as string);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: 'queue.join' }));
    const joined = await waitMsg(msgs, 'queue.joined');
    assert.ok(joined, '票据连接必须能正常入队');
    assert.equal(joined!.timeoutMs, 300, '排队窗口来自服务器配置');
    ws.close();
    await sleep(150);
  });

  await check('T3 单次消费：同一张票据第二次握手必须被拒绝（401）', async () => {
    const t = await api('POST', '/api/ws/ticket', {}, u.token);
    const ticket = t.json.ticket as string;
    const first = await connectWithTicket(ticket);
    first.close();
    await sleep(200);
    let code = '';
    try { await connectWithTicket(ticket); } catch (e) { code = (e as Error).message; }
    observed.t3 = code;
    assert.match(code, /HTTP 401/, '重复消费必须被拒绝，实际 ' + code);
  });

  await check('T4 过期拒绝：把库里那张票改成过期后，握手必须 401', async () => {
    const t = await api('POST', '/api/ws/ticket', {}, u.token);
    const ticket = t.json.ticket as string;
    db.raw.prepare('UPDATE ws_tickets SET expires_at = ? WHERE ticket_hash = ?').run(Date.now() - 1000, ticketHash(ticket));
    let code = '';
    try { await connectWithTicket(ticket); } catch (e) { code = (e as Error).message; }
    assert.match(code, /HTTP 401/, '过期票据必须被拒绝，实际 ' + code);
  });

  await check('T5 库里只存哈希：ws_tickets 全表不含票据明文', async () => {
    const t = await api('POST', '/api/ws/ticket', {}, u.token);
    const ticket = t.json.ticket as string;
    const rows = db.raw.prepare('SELECT ticket_hash, user_id, expires_at FROM ws_tickets').all() as Array<{ ticket_hash: string }>;
    assert.ok(rows.length > 0, '应当已经写入过票据行');
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes(ticket), false, '数据库里不得出现票据明文');
    assert.ok(rows.some((r) => r.ticket_hash === ticketHash(ticket)), '必须按 sha256 落库');
    // TTL 也要如实落库（30 秒），不是“永不过期”
    const row = rows.find((r) => r.ticket_hash === ticketHash(ticket)) as unknown as { expires_at: number };
    assert.ok(Number(row.expires_at) - Date.now() <= WS_TICKET_TTL_MS, 'TTL 不得超过 30 秒');
  });

  await check('T6 票据与会话都不进日志：全程捕获 console 输出并逐条检查', async () => {
    const lines: string[] = [];
    const origInfo = console.info, origWarn = console.warn, origLog = console.log;
    console.info = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    let ticket = '';
    try {
      const t = await api('POST', '/api/ws/ticket', {}, u.token);
      ticket = t.json.ticket as string;
      const ws = await connectWithTicket(ticket);
      ws.close();
      await sleep(150);
      // 顺便制造一次失败握手：拒绝路径同样不得把凭据写进日志
      try { await connectWithTicket(ticket); } catch { /* 预期 401 */ }
      await sleep(150);
      const bad = await api('POST', '/api/register', { email: 'not-an-email', username: 'x', password: 'short' });
      assert.ok(bad.status >= 400);
    } finally {
      console.info = origInfo; console.warn = origWarn; console.log = origLog;
    }
    const leakedTicket = lines.filter((l) => l.includes(ticket));
    const leakedSession = lines.filter((l) => l.includes(u.token));
    observed.t6 = { captured: lines.length, leakedTicket: leakedTicket.length, leakedSession: leakedSession.length };
    assert.equal(leakedTicket.length, 0, '日志里出现了票据明文：' + leakedTicket.slice(0, 2).join(' | '));
    assert.equal(leakedSession.length, 0, '日志里出现了会话令牌：' + leakedSession.slice(0, 2).join(' | '));
  });

  await check('T7 兼容路径仍然可用：HttpOnly cookie 连接（一键账号）、老 ?token= 连接', async () => {
    // 一键账号这条路**响应里没有令牌**，会话只走 HttpOnly cookie ——
    // 也就是说这条路径的 WS 握手本来就不需要 URL 里带任何凭据。
    const q = await api('POST', '/api/auth/quick-start');
    assert.equal(q.status, 201, '一键建号必须 201，实际 ' + q.status + ' ' + JSON.stringify(q.json));
    assert.equal(q.json.token, undefined, '一键账号不得下发令牌');
    const cookie = (q.setCookie.match(/srszq_sid=[^;]+/) ?? [''])[0];
    assert.ok(cookie.startsWith('srszq_sid='), '一键建号必须下发会话 cookie，实际 ' + q.setCookie);
    // 顺便证明 cookie 会话能调受保护接口（不依赖 Authorization 头），
    // 并把教学标记完成 —— 否则 queue.join 会被教学门禁拦住（那是另一条规则，不是连接问题）。
    const tc = await api('POST', '/api/tutorial/complete', {}, undefined, cookie);
    assert.equal(tc.status, 200, 'cookie 会话必须能完成教学，实际 ' + tc.status);
    const byCookie = await connectCookie(cookie);
    const cMsgs = collect(byCookie);
    let closeInfo = '';
    byCookie.on('close', (code, reason) => { closeInfo = code + ':' + String(reason); });
    byCookie.send(JSON.stringify({ type: 'queue.join' }));
    const joined2 = await waitMsg(cMsgs, 'queue.joined');
    if (!joined2) {
      // 诊断写文件：T6 会临时接管 console，用 console 打诊断在这条路径上不可靠。
      appendFileSync(join(process.cwd(), 'evidence', 't7-diag.log'),
        JSON.stringify({ msgs: cMsgs, closeInfo, state: byCookie.readyState, cookieRaw: q.setCookie, tcStatus: tc.status }) + '\n');
    }
    assert.ok(joined2, 'cookie 会话必须能连（URL 里不带任何凭据）');
    byCookie.close();
    const byLegacy = await connectLegacy(u.token);
    assert.ok(byLegacy, '老 ?token= 路径保持可用（过渡兼容）');
    byLegacy.close();
    await sleep(150);
  });

  await check('T8 并发抢同一张票：恰好一个成功（消费是原子的）', async () => {
    const t = await api('POST', '/api/ws/ticket', {}, u.token);
    const ticket = t.json.ticket as string;
    const results = await Promise.allSettled([connectWithTicket(ticket), connectWithTicket(ticket), connectWithTicket(ticket)]);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    observed.t8 = { ok: okCount, failed: results.length - okCount };
    for (const r of results) if (r.status === 'fulfilled') r.value.close();
    await sleep(150);
    assert.equal(okCount, 1, '同一张票据只能有 1 条连接成功，实际 ' + okCount);
  });

  await check('T9 票据只能换成连接，不能当会话用：把它当 ?token= 提交必须被拒', async () => {
    const t = await api('POST', '/api/ws/ticket', {}, u.token);
    const ticket = t.json.ticket as string;
    let code = '';
    try { await connectLegacy(ticket); } catch (e) { code = (e as Error).message; }
    assert.match(code, /HTTP 401/, '票据不得被当作会话令牌接受，实际 ' + code);
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));
  console.log(failures === 0 ? 'WS TICKET (S04): ALL PASS 0' : 'WS TICKET (S04): ' + failures + ' FAILED 1');
  // 不 await server.close()：还开着的 WS/keep-alive 连接会让 close 回调永不触发，
  // 进程就会挂着不退（现场踩到：套件打完结论却一直不结束，还锁住了输出文件）。
  // 直接退出，由进程结束回收监听与连接。
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
