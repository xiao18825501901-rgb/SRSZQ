/**
 * G16：多标签 / 刷新时“新连接替换旧连接”。
 *
 * 原缺陷（本轮修复）：服务端只做 `clients.set(userId, newClient)` 覆盖 map，
 * **旧 socket 从不关闭** —— 被替换的标签页仍持有已认证的活连接、仍能继续发命令，
 * 一个账号在两处同时操作；而前端又会无条件自动重连，一旦服务端开始关旧连接就会互相顶号抖动。
 *
 * 现在的要求：
 *  1. 新连接建立时，旧连接被服务端关闭，且关闭码是协议约定的 4000；
 *  2. 存活的新连接可正常排队/开局（替换不能把会话弄坏）；
 *  3. 被替换的连接不能再影响服务端（它已经关了，不再是“活着的第二条连接”）。
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
import { GameServer } from '../src/ws/gameServer.js';
import { PROTOCOL_VERSION, RULESET_VERSION } from '../../shared/src/product/protocol.js';

// 常量写死成字面量：这样“修复前”的代码（没有导出这个常量）也能跑这份测试，
// 从而可以先证明测试抓得住缺陷，再证明修复有效。
const WS_CLOSE_REPLACED = 4000;

let failures = 0;
const observed: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

let db: Db;
let apiBase = '';
let wsBase = '';

interface Client { ws: WebSocket; msgs: Array<{ type: string; [k: string]: any }>; closedCode: number | null; closeReason: string; }

/** 已建立的连接都记下来：收尾时要显式关掉（WS 升级后的 socket 不再被 http server 跟踪）。 */
const openClients: Client[] = [];

function connect(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '?token=' + encodeURIComponent(token) + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
    const msgs: Client['msgs'] = [];
    const client: Client = { ws, msgs, closedCode: null, closeReason: '' };
    ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw))); });
    ws.on('close', (code, reason) => { client.closedCode = code; client.closeReason = String(reason); });
    ws.on('open', () => { openClients.push(client); resolve(client); });
    ws.on('error', reject);
  });
}
const send = (c: Client, m: unknown) => { try { c.ws.send(JSON.stringify(m)); } catch { /* 已关闭 */ } };
async function waitFor(c: Client, type: string, timeoutMs = 8000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = c.msgs.findIndex((m) => m.type === type);
    if (i >= 0) return c.msgs.splice(i, 1)[0];
    await sleep(15);
  }
  throw new Error('timeout waiting ' + type);
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
  return { id: r.json.user.id as string, token: r.json.token as string };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-multitab-'));
  db = openDb(join(dir, 'test.sqlite'));
  const gs = new GameServer(db, { queueTimeoutMs: 300, aiMoveDelayMs: 5, aiTimeBudgetMs: 40, queueSweepMs: 20 });
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

  await check('G16-1 同一账号第二个连接建立后，旧连接被服务端关闭且关闭码为 4000', async () => {
    const u = await registerUser('MultiTabA');
    const a = await connect(u.token);
    await waitFor(a, 'hello', 5000);
    assert.equal(a.closedCode, null, '此时旧连接应当是打开的');
    const b = await connect(u.token);
    await waitFor(b, 'hello', 5000);
    // 给服务端一点时间执行关闭
    for (let i = 0; i < 40 && a.closedCode === null; i += 1) await sleep(50);
    assert.equal(a.closedCode, WS_CLOSE_REPLACED, '旧连接必须被关闭（实际 closedCode=' + a.closedCode + '）');
    assert.ok(String(a.closeReason).includes('replaced'), '关闭原因要说明被替换：' + a.closeReason);
    observed.g16_1 = { oldCloseCode: a.closedCode, reason: a.closeReason };
    try { b.ws.close(); } catch { /* noop */ }
  });

  await check('G16-2 存活的新连接仍然可用：能排队并正常开局（替换不破坏会话）', async () => {
    const u = await registerUser('MultiTabB');
    const a = await connect(u.token);
    await waitFor(a, 'hello', 5000);
    const b = await connect(u.token);
    await waitFor(b, 'hello', 5000);
    for (let i = 0; i < 40 && a.closedCode === null; i += 1) await sleep(50);
    assert.equal(a.closedCode, WS_CLOSE_REPLACED, '前置条件：旧连接已被替换');
    send(b, { type: 'queue.join' });
    const joined = await waitFor(b, 'queue.joined', 8000);
    assert.ok(joined.queueId, '新连接必须能入队');
    const start = await waitFor(b, 'game.start', 10_000);
    assert.ok(start.gameId, '新连接必须能收到开局');
    observed.g16_2 = { queueId: joined.queueId, gameId: start.gameId };
    try { b.ws.close(); } catch { /* noop */ }
  });

  await check('G16-3 被替换的连接已经彻底失效（不再是“活着的第二条连接”）', async () => {
    const u = await registerUser('MultiTabC');
    const a = await connect(u.token);
    await waitFor(a, 'hello', 5000);
    const b = await connect(u.token);
    await waitFor(b, 'hello', 5000);
    for (let i = 0; i < 40 && a.closedCode === null; i += 1) await sleep(50);
    assert.equal(a.ws.readyState, WebSocket.CLOSED, '旧连接的底层 socket 必须已关闭（实际 ' + a.ws.readyState + '）');
    const before = a.msgs.length;
    send(a, { type: 'queue.leave' });
    send(a, { type: 'queue.join' });
    await sleep(300);
    assert.equal(a.msgs.length, before, '旧连接不得再收到任何服务端消息');
    // 新连接仍然clean：它没有因为旧连接的动静被踢
    assert.equal(b.closedCode, null, '新连接不得受影响');
    observed.g16_3 = { oldReadyState: a.ws.readyState, newStillOpen: b.closedCode === null };
    try { b.ws.close(); } catch { /* noop */ }
  });

  await check('G16-4 被替换连接的 close 事件不会把新连接的注册删掉（陈旧 close 不得影响新会话）', async () => {
    const u = await registerUser('MultiTabD');
    const a = await connect(u.token);
    await waitFor(a, 'hello', 5000);
    const b = await connect(u.token);
    await waitFor(b, 'hello', 5000);
    for (let i = 0; i < 40 && a.closedCode === null; i += 1) await sleep(50);
    // 旧连接此刻已在服务端触发过 close 清理；新连接必须仍能正常排队并收到广播
    await sleep(200);
    send(b, { type: 'queue.join' });
    const joined = await waitFor(b, 'queue.joined', 8000);
    assert.ok(joined.queueId, '新连接必须仍然在广播表里（否则收不到 queue.joined）');
    observed.g16_4 = { stillRegistered: true };
    try { b.ws.close(); } catch { /* noop */ }
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));
  // 收尾必须有界：WS 升级后的 socket 不属于 http server 的连接表，
  // 只调 close()/closeAllConnections() 会永远等不到回调（本地自检踩到，整轮挂住）。
  const bounded = async (label: string, fn: () => Promise<void>): Promise<void> => {
    const t0 = Date.now();
    await Promise.race([fn(), sleep(3000)]);
    if (Date.now() - t0 >= 3000) console.log('  [close-timeout] ' + label + ' 3s 内未结束，跳过等待');
  };
  await bounded('clients', async () => {
    for (const c of openClients) { try { c.ws.close(); } catch { /* 已关 */ } }
    await sleep(150);
  });
  await bounded('wsHttp', () => new Promise<void>((r) => { wsHttp.close(() => r()); wsHttp.closeAllConnections(); }));
  await bounded('apiServer', () => new Promise<void>((r) => { apiServer.close(() => r()); apiServer.closeAllConnections(); }));
  if (failures === 0) console.log('MULTITAB: ALL PASS 0');
  else console.log('MULTITAB: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
