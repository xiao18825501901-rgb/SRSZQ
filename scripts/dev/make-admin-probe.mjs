/**
 * 在生产注册一个**明确标记为测试**的管理员探针账号（用户名以 dsh 开头 => source=TEST，页面会标 DEMO）。
 *
 *   node scripts/dev/make-admin-probe.mjs            # 注册/登录探针账号并打印凭据（不授予管理员）
 *
 * 只做注册或登录，不做权限变更：授予 ADMIN 必须用受控 CLI（scripts/ops/grant-admin.mts）在服务器上执行。
 * 输出 JSON：{ username, password, token, userId, source }
 */
import { randomBytes } from 'node:crypto';

const API = process.argv.includes('--api') ? process.argv[process.argv.indexOf('--api') + 1] : 'https://api.srszq.com';
const username = process.argv.includes('--user') ? process.argv[process.argv.indexOf('--user') + 1] : ('dshadmin' + randomBytes(3).toString('hex'))  // <=16 位（注册接口限制），且以 dsh 开头 => source=TEST;
const password = process.argv.includes('--pass') ? process.argv[process.argv.indexOf('--pass') + 1] : randomBytes(18).toString('base64url');

const post = async (path, body) => {
  const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

let r = await post('/api/register', { email: username + '@example.invalid', username, password });
const registerResult = { status: r.status, body: JSON.stringify(r.json) };
let created = true;
if (r.status !== 200 && r.status !== 201) {
  created = false;
  r = await post('/api/login', { account: username, password });
}
if (!r.json?.token) console.log('register: ' + JSON.stringify(registerResult) + ' login: ' + r.status + ' ' + JSON.stringify(r.json));
if (!r.json?.token) { console.log('FAIL: 注册/登录失败 ' + r.status + ' ' + JSON.stringify(r.json)); process.exit(1); }
console.log(JSON.stringify({
  api: API, created, username, password, token: r.json.token,
  userId: r.json.user?.id ?? null, source: r.json.user?.source ?? null, role: r.json.user?.role ?? null,
}));
