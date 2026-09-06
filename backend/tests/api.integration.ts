/**
 * SRSZQ backend 集成测试（真实 HTTP + SQLite）。
 * 以独立 tsx 进程运行（vitest worker 沙箱限制回环网络）：
 *   npm run test:backend
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';

let db: Db;
let base = '';
let failures = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}  [${e instanceof Error ? e.message : String(e)}]`);
  }
}

async function request(method: string, path: string, body?: unknown, token?: string, origin?: string): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

const post = (p: string, b?: unknown, t?: string) => request('POST', p, b, t);
const get = (p: string, t?: string) => request('GET', p, undefined, t);

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-api-'));
  db = openDb(join(dir, 'test.sqlite'));
  const { server } = createApi(db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;

  await check('CORS 仅回显生产与回退白名单来源', async () => {
    const production = await request('GET', '/api/ranking', undefined, undefined, 'https://srszq.com');
    assert.equal(production.headers.get('access-control-allow-origin'), 'https://srszq.com');
    assert.equal(production.headers.get('vary'), 'Origin');
    const fallback = await request('GET', '/api/ranking', undefined, undefined, 'https://srszq.netlify.app');
    assert.equal(fallback.headers.get('access-control-allow-origin'), 'https://srszq.netlify.app');
    const untrusted = await request('GET', '/api/ranking', undefined, undefined, 'https://attacker.example');
    assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
  });

  await check('CORS preflight 拒绝非白名单来源', async () => {
    const allowed = await fetch(base + '/api/login', { method: 'OPTIONS', headers: { Origin: 'https://www.srszq.com' } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://www.srszq.com');
    const denied = await fetch(base + '/api/login', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });

  // 1) 注册 → me → 登出
  let token = '';
  await check('注册成功并返回 token/user', async () => {
    const r = await post('/api/register', { email: 'a@test.com', username: 'Alice', password: 'secret1' });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.username, 'Alice');
    assert.equal(r.json.user.tutorialCompleted, false);
    assert.ok(r.json.token);
    token = r.json.token;
  });

  await check('me 返回本人资料', async () => {
    const r = await get('/api/me', token);
    assert.equal(r.status, 200);
    assert.equal(r.json.user.email, 'a@test.com');
    assert.ok(!('passwordHash' in r.json.user), '不得泄露密码哈希');
  });

  await check('登出后 token 失效', async () => {
    assert.equal((await post('/api/logout', {}, token)).status, 200);
    assert.equal((await get('/api/me', token)).status, 401);
  });

  // 2) 登录 / 密码错误
  await check('登录成功', async () => {
    const r = await post('/api/login', { account: 'Alice', password: 'secret1' });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
    token = r.json.token;
  });
  await check('错误密码 → 401', async () => {
    assert.equal((await post('/api/login', { account: 'Alice', password: 'wrong!' })).status, 401);
  });

  // 3) 注册校验与冲突
  await check('非法邮箱/短密码 → 400', async () => {
    assert.equal((await post('/api/register', { email: 'bad', username: 'Xy', password: '123' })).status, 400);
  });
  await check('重复邮箱/用户名 → 409', async () => {
    assert.equal((await post('/api/register', { email: 'A@test.com', username: 'Bob', password: 'secret1' })).status, 409);
    assert.equal((await post('/api/register', { email: 'b@test.com', username: 'Alice', password: 'secret1' })).status, 409);
  });

  // 4) 教学门禁标记
  await check('教学完成标记生效', async () => {
    const r = await post('/api/tutorial/complete', {}, token);
    assert.equal(r.status, 200);
    assert.equal(r.json.user.tutorialCompleted, true);
    const me = await get('/api/me', token);
    assert.equal(me.json.user.tutorialCompleted, true);
  });

  // 5) 排行榜
  await check('排行榜返回注册用户（按 rating 排序）', async () => {
    await post('/api/register', { email: 'p1@test.com', username: 'Player1', password: 'secret1' });
    await post('/api/register', { email: 'p2@test.com', username: 'Player2', password: 'secret1' });
    const r = await get('/api/ranking?limit=10', token);
    assert.equal(r.status, 200);
    assert.equal(r.json.ranking.length, 3);
    const names = r.json.ranking.map((u: { username: string }) => u.username);
    for (const n of ['Alice', 'Player1', 'Player2']) assert.ok(names.includes(n), `missing ${n}`);
    const ratings = r.json.ranking.map((u: { rating: number }) => u.rating);
    assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), 'rating 降序');
  });

  // 6) 邀请拒绝：状态 rejected、无好友关系
  await check('邀请拒绝流程（reject）', async () => {
    const me = await post('/api/register', { email: 'rej@test.com', username: 'Rejecter', password: 'secret1' });
    const other = await post('/api/register', { email: 'rej2@test.com', username: 'Rejectee', password: 'secret1' });
    const inv = await post('/api/invite', { toUsername: 'Rejectee' }, me.json.token);
    assert.equal(inv.status, 201);
    const list = await get('/api/invitations', other.json.token);
    assert.equal(list.json.invitations.length, 1);
    // 发送者不能替接收者接受（403）
    const foreign = await post('/api/invite/accept', { id: list.json.invitations[0].id }, me.json.token);
    assert.equal(foreign.status, 403);
    const rej = await post('/api/invite/reject', { id: list.json.invitations[0].id }, other.json.token);
    assert.equal(rej.status, 200);
    const after = await get('/api/invitations', other.json.token);
    assert.equal(after.json.invitations.length, 0);
    const friends = await get('/api/friends', me.json.token);
    assert.equal(friends.json.friends.length, 0, '拒绝后不应建立好友');
  });

  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nBACKEND API INTEGRATION: ALL PASS' : `\nBACKEND API INTEGRATION: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('integration error:', e);
  process.exit(1);
});
