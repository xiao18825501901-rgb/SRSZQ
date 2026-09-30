/**
 * 增量 C：一键创建账号并开始（provisional account）+ 原地领取 + 迁移与安全。
 *
 * 关键纪律：这里的每条断言都对应需求里的一句硬要求（幂等、多标签、不返回密钥、
 * 老登录兼容、迁移幂等、临时账号不进正式排位）。
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
import { isProvisionalEmail } from '../src/quickAccount.js';

let failures = 0;
const observed: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

interface Res { status: number; json: any; setCookie: string[] }

let db: Db;
let apiBase = '';
let wsBase = '';
let closeAll: () => Promise<void> = async () => {};

async function boot(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-qa-'));
  db = openDb(join(dir, 'test.sqlite'));
  const gs = new GameServer(db, { queueTimeoutMs: 300, aiMoveDelayMs: 5, aiTimeBudgetMs: 40, forfeitGraceMs: 400, queueSweepMs: 20 });
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
  closeAll = async () => {
    await new Promise<void>((r) => { wsHttp.close(() => r()); wsHttp.closeAllConnections(); });
    await new Promise<void>((r) => { apiServer.close(() => r()); apiServer.closeAllConnections(); });
    await sleep(200);
    // 同样刻意不关库：迟到的 WS close 回调会 touchOnline，关库会让进程崩在收尾阶段。
    // 每个用例用独立临时库，进程结束时统一退出。
  };
}

/** 带 cookie 的请求：模拟“同一个浏览器”（cookie jar 就是这里的字符串）。 */
async function req(method: string, path: string, body?: unknown, opts: { cookie?: string; token?: string; https?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.https) headers['X-Forwarded-Proto'] = 'https';
  const res = await fetch(apiBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, json, setCookie: raw };
}

/** 从 Set-Cookie 里取出会话 cookie（浏览器会自己干这件事，测试里手工做）。 */
function cookieOf(res: Res): string {
  const one = res.setCookie.find((c) => c.includes('srszq_sid='));
  assert.ok(one, 'Set-Cookie 里必须有会话 cookie：' + JSON.stringify(res.setCookie));
  return one.split(';')[0];
}
function cookieAttrs(res: Res): string {
  const one = res.setCookie.find((c) => c.includes('srszq_sid='));
  assert.ok(one, 'Set-Cookie 里必须有会话 cookie');
  return one;
}

interface Client { ws: WebSocket; msgs: Array<{ type: string; [k: string]: any }>; cookie: string }
/**
 * 连 WS：临时账号用 cookie（不带任何密钥进 URL），老账号仍用 ?token=。
 * 两条路服务端都认，正是增量 C 的兼容口径。
 */
function connect(auth: { cookie?: string; token?: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const qs = '?protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION)
      + (auth.token ? '&token=' + encodeURIComponent(auth.token) : '');
    const ws = new WebSocket(wsBase + qs, auth.cookie ? { headers: { Cookie: auth.cookie } } : undefined);
    const msgs: Client['msgs'] = [];
    const client: Client = { ws, msgs, cookie: auth.cookie ?? '' };
    ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw))); });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
const send = (c: Client, msg: unknown) => c.ws.send(JSON.stringify(msg));
async function waitFor(c: Client, type: string, timeoutMs = 8000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = c.msgs.findIndex((m) => m.type === type);
    if (i >= 0) return c.msgs.splice(i, 1)[0];
    await sleep(10);
  }
  throw new Error('timeout waiting ' + type + '; got ' + c.msgs.map((m) => m.type).join(','));
}
const userCount = (): number => Number((db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);

async function main(): Promise<void> {
  // 本套件会大量建号，先把限流阈值调高；限流本身由 D3 用一个**独立实例**单独验证。
  process.env.SRSZQ_QUICK_START_RATE_LIMIT = '500';
  await boot();
  console.log('--- C 一键创建账号并开始 ---');

  await check('C1 首次访问：一键建号只产生 1 个账号，provisional=true，随机昵称唯一，不要邮箱/密码', async () => {
    const before = userCount();
    const r = await req('POST', '/api/auth/quick-start');
    assert.equal(r.status, 201, 'quick-start -> ' + r.status + ' ' + JSON.stringify(r.json));
    assert.equal(userCount(), before + 1, '必须恰好新建 1 个账号');
    assert.equal(r.json.provisional, true, 'provisional 必须为 true');
    assert.equal(typeof r.json.user.username, 'string');
    assert.ok(r.json.user.username.length >= 2, '必须有随机昵称');
    assert.equal(r.json.user.email, undefined, '不能返回邮箱（占位邮箱不外泄）');
    // 不返回任何密钥
    const body = JSON.stringify(r.json);
    assert.ok(!/password|salt|token|hash/i.test(body), '响应里不得出现 password/salt/token/hash：' + body);
    // 数据库侧：没有可用密码
    const row = db.raw.prepare('SELECT password_hash, account_type, email FROM users WHERE id = ?').get(r.json.user.id) as any;
    assert.equal(row.password_hash, '', '临时账号不得有可用密码哈希');
    assert.equal(row.account_type, 'PROVISIONAL');
    assert.ok(isProvisionalEmail(String(row.email)), '必须是占位邮箱');
    observed.c1 = { username: r.json.user.username, accountType: row.account_type };
  });

  await check('C2 双击/重复提交：仍然只有 1 个账号（幂等），且返回同一个 userId', async () => {
    const first = await req('POST', '/api/auth/quick-start');
    const cookie = cookieOf(first);
    const before = userCount();
    const [a, b] = await Promise.all([
      req('POST', '/api/auth/quick-start', undefined, { cookie }),
      req('POST', '/api/auth/quick-start', undefined, { cookie }),
    ]);
    assert.equal(userCount(), before, '带着已有会话再点两次，不得新建账号');
    assert.equal(a.json.created, false);
    assert.equal(b.json.created, false);
    assert.equal(a.json.user.id, first.json.user.id, '必须还是同一个账号');
    assert.equal(b.json.user.id, first.json.user.id);
    observed.c2 = { userId: first.json.user.id, createdFlags: [a.json.created, b.json.created] };
  });

  await check('C3 多标签页/刷新：同一个 cookie 永远是同一个账号', async () => {
    const first = await req('POST', '/api/auth/quick-start');
    const cookie = cookieOf(first);
    const me1 = await req('GET', '/api/me', undefined, { cookie });
    const me2 = await req('GET', '/api/me', undefined, { cookie });
    assert.equal(me1.status, 200, '/api/me 必须认 cookie 会话');
    assert.equal(me1.json.user.id, first.json.user.id);
    assert.equal(me2.json.user.id, first.json.user.id);
    assert.equal(me1.json.provisional, true, '/api/me 要如实说明这是临时账号');
    observed.c3 = { userId: me1.json.user.id };
  });

  await check('C4 原地领取：设置昵称+密码后仍是同一个 userId，provisional=false，战绩保留', async () => {
    const created = await req('POST', '/api/auth/quick-start');
    const cookie = cookieOf(created);
    const userId = created.json.user.id as string;
    const name = '领取测试' + String(Math.floor(Math.random() * 9000) + 1000);
    const claim = await req('POST', '/api/me/claim-account', { username: name, password: 'Passw0rd!23' }, { cookie });
    assert.equal(claim.status, 200, 'claim -> ' + claim.status + ' ' + JSON.stringify(claim.json));
    assert.equal(claim.json.user.id, userId, '必须还是同一个 userId');
    assert.equal(claim.json.provisional, false);
    const row = db.raw.prepare('SELECT account_type, claimed_at, password_hash, username FROM users WHERE id = ?').get(userId) as any;
    assert.equal(row.account_type, 'CLAIMED');
    assert.ok(Number(row.claimed_at) > 0, 'claimed_at 必须落库');
    assert.ok(String(row.password_hash).length > 0, '领取后必须有密码哈希');
    // 用新昵称 + 新密码走**老登录接口**必须成功（兼容路径）
    const login = await req('POST', '/api/login', { account: name, password: 'Passw0rd!23' });
    assert.equal(login.status, 200, '领取后必须能用老登录接口登入：' + JSON.stringify(login.json));
    assert.equal(login.json.user.id, userId);
    // 重复领取被拒（不是半套改密流程）
    const again = await req('POST', '/api/me/claim-account', { username: name + 'x', password: 'Passw0rd!23' }, { cookie });
    assert.equal(again.status, 409, '已领取账号不允许再走 claim');
    observed.c4 = { userId, claimedAt: Number(row.claimed_at) };
  });

  await check('C5 昵称冲突被拒；老账号注册/登录路径完全不受影响', async () => {
    const created = await req('POST', '/api/auth/quick-start');
    const cookie = cookieOf(created);
    const reg = await req('POST', '/api/register', { email: 'legacy1@t.local', username: 'LegacyOne', password: 'Passw0rd!23' });
    assert.equal(reg.status, 201, '老注册路径必须照常工作：' + JSON.stringify(reg.json));
    const dup = await req('POST', '/api/me/claim-account', { username: 'LegacyOne', password: 'Passw0rd!23' }, { cookie });
    assert.equal(dup.status, 409, '昵称已被占用必须拒绝');
    const bad = await req('POST', '/api/me/claim-account', { username: 'x', password: '123' }, { cookie });
    assert.equal(bad.status, 400, '继续沿用既有 username/password 校验器');
    const login = await req('POST', '/api/login', { account: 'legacy1@t.local', password: 'Passw0rd!23' });
    assert.equal(login.status, 200, '老账号登录必须不受影响');
    assert.ok(typeof login.json.token === 'string' && login.json.token.length > 0, '老流程仍然返回 token');
    observed.c5 = { legacyUserId: reg.json.user.id };
  });

  console.log('--- D 安全 ---');

  await check('D1 会话 cookie：HttpOnly + SameSite + 生产 https 时 Secure；响应不含任何密钥', async () => {
    const local = await req('POST', '/api/auth/quick-start');
    const attrs = cookieAttrs(local);
    assert.ok(/HttpOnly/i.test(attrs), 'cookie 必须 HttpOnly：' + attrs);
    assert.ok(/SameSite=Lax/i.test(attrs), 'cookie 必须显式 SameSite：' + attrs);
    assert.ok(!/Secure/i.test(attrs), '本地 http 不加 Secure（否则浏览器直接丢弃）');
    const https = await req('POST', '/api/auth/quick-start', undefined, { https: true });
    const httpsAttrs = cookieAttrs(https);
    assert.ok(/Secure/i.test(httpsAttrs), '生产 https 必须带 Secure：' + httpsAttrs);
    assert.ok(!JSON.stringify(https.json).includes(cookieOf(https).split('=')[1]), '会话密钥不得出现在 JSON 里');
    observed.d1 = { local: attrs.replace(/=[^;]+/, '=<redacted>'), https: httpsAttrs.replace(/=[^;]+/, '=<redacted>') };
  });

  await check('D2 登出使 cookie 会话立即失效；API 不返回密码哈希', async () => {
    const created = await req('POST', '/api/auth/quick-start');
    const cookie = cookieOf(created);
    const before = await req('GET', '/api/me', undefined, { cookie });
    assert.equal(before.status, 200);
    assert.ok(!/passwordHash|password_hash|salt/i.test(JSON.stringify(before.json)), '不得返回密码哈希/盐');
    const out = await req('POST', '/api/logout', undefined, { cookie });
    assert.equal(out.status, 200);
    assert.ok(/Max-Age=0/i.test(cookieAttrs(out)), '登出必须清 cookie');
    const after = await req('GET', '/api/me', undefined, { cookie });
    assert.equal(after.status, 401, '登出后旧 cookie 必须失效，实际 ' + after.status);
    observed.d2 = { afterLogout: after.status };
  });



  console.log('--- E 迁移与兼容 ---');

  await check('E1 迁移幂等：同一个库连开三次不报错，列齐备且老数据一行不丢', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srszq-qa-mig-'));
    const path = join(dir, 'mig.sqlite');
    const first = openDb(path);
    const legacy = first.createUser({ email: 'old@t.local', username: 'OldTimer', passwordHash: 'deadbeef', salt: 'aa' });
    first.raw.prepare('UPDATE users SET rating = 1337 WHERE id = ?').run(legacy.id);
    first.close();
    // 连续再开两次 = 迁移再跑两遍，必须幂等。
    const second = openDb(path);
    const third = openDb(path);
    assert.ok(second && third, '重复打开同一个库不得报错');
    const cols = third.raw.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    for (const c of ['account_type', 'claimed_at', 'last_seen_at', 'source', 'role']) {
      assert.ok(cols.some((x) => x.name === c), '缺列 ' + c);
    }
    const row = third.raw.prepare('SELECT username, rating, account_type FROM users WHERE email = ?').get('old@t.local') as any;
    assert.equal(row.username, 'OldTimer', '老用户数据不得变');
    assert.equal(Number(row.rating), 1337, '老用户积分不得变');
    assert.equal(row.account_type, 'CLAIMED', '老用户必须自动视为已领取');
    third.close();
    observed.e1 = { columns: cols.length, legacyAccountType: row.account_type };
  });

  await check('E2 闲置清理队列只收“无资产 + 长期未活动”的临时账号，绝不碰有战绩的账号', async () => {
    // 一个闲置临时账号（手工把 last_seen_at 推到 40 天前）
    const idle = await req('POST', '/api/auth/quick-start');
    const idleId = idle.json.user.id as string;
    db.raw.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now() - 40 * 24 * 3600 * 1000, idleId);
    // 一个“有资产”的临时账号：伪造一条参赛记录
    const busy = await req('POST', '/api/auth/quick-start');
    const busyId = busy.json.user.id as string;
    db.raw.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now() - 40 * 24 * 3600 * 1000, busyId);
    // match_participants 的真实列：game_id/seat/kind/user_id/outcome/rating_delta（没有 created_at）。
    db.raw.prepare("INSERT INTO match_participants (game_id, seat, kind, user_id, outcome, rating_delta) VALUES ('g-x', 'A', 'human', ?, 'WIN', 0)").run(busyId);
    const queue = db.listProvisionalCleanupCandidates(Date.now() - 30 * 24 * 3600 * 1000, 500);
    const ids = queue.map((x) => x.id);
    assert.ok(ids.includes(idleId), '闲置无资产的临时账号必须进队列');
    assert.ok(!ids.includes(busyId), '有对局记录的账号不得进队列');
    const summary = db.accountTypeSummary();
    assert.ok(summary.provisional > 0 && summary.claimed > 0, '三类计数必须分开：' + JSON.stringify(summary));
    observed.e2 = { queue: queue.length, summary };
  });

  console.log('--- C/D 追加：临时账号不得进入正式排位 ---');

  await check('C6 3 真人 online 局里只要有未领取的临时账号，本局就不计正式排位（策略 none）', async () => {
    const prov = await req('POST', '/api/auth/quick-start');
    const provCookie = cookieOf(prov);
    await req('POST', '/api/tutorial/complete', undefined, { cookie: provCookie });
    const claimed = await req('POST', '/api/register', { email: 'ranked1@t.local', username: 'RankedOne', password: 'Passw0rd!23' });
    await req('POST', '/api/tutorial/complete', {}, { token: claimed.json.token });
    const claimed2 = await req('POST', '/api/register', { email: 'ranked2@t.local', username: 'RankedTwo', password: 'Passw0rd!23' });
    await req('POST', '/api/tutorial/complete', {}, { token: claimed2.json.token });
    const l1 = await req('POST', '/api/login', { account: 'ranked1@t.local', password: 'Passw0rd!23' });
    const l2 = await req('POST', '/api/login', { account: 'ranked2@t.local', password: 'Passw0rd!23' });
    // 临时账号用 cookie 连（无密钥进 URL）；老账号用既有 token 参数连。
    const a = await connect({ cookie: provCookie });
    const b = await connect({ token: l1.json.token });
    const c = await connect({ token: l2.json.token });
    for (const cl of [a, b, c]) send(cl, { type: 'queue.join' });
    const start = await waitFor(a, 'game.start', 10_000);
    assert.equal(start.seats ? Object.values(start.seats).filter((s: any) => s.kind === 'human').length : 0, 3, '必须是 3 真人局');
    // 一方退出 → 结算（这条路径在既有产品里是合法的终局方式）
    send(b, { type: 'PLAYER_RESIGN' });
    await waitFor(a, 'game.end', 10_000).catch(() => null);
    await sleep(400);
    const settled = db.raw.prepare('SELECT game_id, is_ranked, score_policy FROM match_results ORDER BY settled_at DESC LIMIT 1').get() as any;
    assert.ok(settled, '必须有结算记录');
    assert.equal(Number(settled.is_ranked), 0, '含临时账号的对局不得计入正式排位');
    assert.equal(String(settled.score_policy), 'none', '策略必须是 none，实际 ' + settled.score_policy);
    const rating = db.raw.prepare('SELECT rating FROM users WHERE id = ?').get(prov.json.user.id) as any;
    assert.equal(Number(rating.rating), 1200, '临时账号积分不得变化');
    observed.c6 = { gameId: settled.game_id, isRanked: Number(settled.is_ranked), policy: settled.score_policy };
    for (const cl of [a, b, c]) { try { cl.ws.close(); } catch { /* noop */ } }
  });

  await check('C7 临时账号不进公开排行榜；领取后才可能出现', async () => {
    const before = await req('GET', '/api/ranking?limit=200');
    const names = (before.json.ranking as Array<{ username: string }>).map((r) => r.username);
    const provisionalNames = (db.raw.prepare("SELECT username FROM users WHERE account_type = 'PROVISIONAL'").all() as Array<{ username: string }>).map((r) => r.username);
    const leaked = provisionalNames.filter((n) => names.includes(n));
    assert.equal(leaked.length, 0, '临时账号不得出现在公开排行榜：' + JSON.stringify(leaked.slice(0, 3)));
    observed.c7 = { rankingRows: names.length, provisionalChecked: provisionalNames.length };
  });

  await check('C8 analytics：临时建号 / 领取 / 存量注册三类事件分开记录', async () => {
    const rows = db.raw.prepare('SELECT name, COUNT(*) AS n FROM product_events GROUP BY name').all() as Array<{ name: string; n: number }>;
    const by = Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
    assert.ok((by.provisional_account_created ?? 0) > 0, '必须有临时建号事件：' + JSON.stringify(by));
    assert.ok((by.claimed_account ?? 0) > 0, '必须有领取事件：' + JSON.stringify(by));
    assert.ok((by.registered_existing_flow ?? 0) > 0, '必须有存量注册事件：' + JSON.stringify(by));
    observed.c8 = by;
  });

  await check('D3 限流：同一来源短时间内不能无限建号（独立实例，阈值 3）', async () => {
    const prev = process.env.SRSZQ_QUICK_START_RATE_LIMIT;
    process.env.SRSZQ_QUICK_START_RATE_LIMIT = '3';
    const { server } = createApi(db, {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const codes: number[] = [];
    try {
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(base + '/api/auth/quick-start', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        await res.text();
        codes.push(res.status);
        if (res.status === 429) break;
      }
    } finally {
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      if (prev === undefined) delete process.env.SRSZQ_QUICK_START_RATE_LIMIT;
      else process.env.SRSZQ_QUICK_START_RATE_LIMIT = prev;
    }
    assert.ok(codes.includes(429), '必须出现限流（实际 ' + codes.join(',') + '）');
    assert.equal(codes.filter((c) => c === 201).length, 3, '阈值 3 时恰好放行 3 次建号（窗口是滚动的，不是永久封禁）：' + codes.join(','));
    observed.d3 = { codes };
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));
  await closeAll();
  if (failures === 0) console.log('QUICK ACCOUNT: ALL PASS 0');
  else console.log('QUICK ACCOUNT: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
