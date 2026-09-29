
/**
 * 公网行为验收：AI 补位的在线快速局**不得**改真人竞技分。
 * 这是 P1 的核心修复（规格 4.1 / 55 / 142），必须在真实域名上验证，
 * 而不是只在本地测试里成立。
 *
 * 流程：注册 DEMO 账号 -> 读排行榜里的初始分 -> 打一局 1H+2AI 并退出
 *      -> 再读一次分数 -> 断言完全相同。
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const WS = process.env.SRSZQ_WS_URL ?? 'wss://api.srszq.com/ws';
const stamp = Date.now().toString(36);
const username = ('dshp1' + stamp).slice(0, 16);
const email = ('dsh.p1.' + stamp + '@example.invalid').toLowerCase();
const password = 'Demo-P1-' + stamp + '!3';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS ' + m); else { failures++; console.log('  FAIL ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function ratingInLeaderboard(userId) {
  const r = await api('GET', '/api/ranking');
  return r.json?.ranking?.find((x) => x.id === userId)?.rating ?? null;
}

const main = async () => {
  console.log('=== 公网版本 ===');
  const v = await api('GET', '/api/version');
  ok(v.json?.protocol?.protocolVersion === 2, 'protocolVersion=2，release=' + v.json?.protocol?.releaseId);

  console.log('=== 注册 DEMO 账号 ===');
  const reg = await api('POST', '/api/register', { email, username, password });
  ok(reg.status === 201, 'register http=' + reg.status);
  const token = reg.json?.token;
  const userId = reg.json?.user?.id;
  if (!token || !userId) { console.log('FATAL: 无法继续'); process.exit(1); }
  await api('POST', '/api/tutorial/complete', {}, token);

  const r0 = await ratingInLeaderboard(userId);
  ok(typeof r0 === 'number', '排行榜可读到初始分 ' + r0);

  console.log('=== 打一局 1H+2AI 快速局并退出 ===');
  const ws = new WebSocket(WS + '?protocol=2&ruleset=formal-rules-v2&token=' + encodeURIComponent(token));
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'queue.join' }));

  const grab = async (type, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = msgs.findIndex((m) => m.type === type);
      if (i >= 0) return msgs.splice(i, 1)[0];
      await sleep(100);
    }
    return null;
  };

  // 生产队列超时 60s，1 真人需等 AI 补位
  const start = await grab('game.start', 90000);
  ok(!!start, '匹配成功（等待 AI 补位）');
  if (!start) { ws.close(); process.exit(1); }
  const aiCount = Object.values(start.seats).filter((s) => s.kind === 'ai').length;
  ok(aiCount === 2, '1H+2AI 快速局，ai=' + aiCount);
  ok(start.protocol?.releaseId === v.json?.protocol?.releaseId, 'game.start 的 releaseId 与 /api/version 一致');

  ws.send(JSON.stringify({ type: 'PLAYER_RESIGN' }));
  const ended = await grab('MATCH_ENDED', 15000);
  ok(!!ended, '终局：reason=' + ended?.reason + ' status=' + ended?.status);
  await sleep(1500);
  ws.close();

  console.log('=== 核心断言：分数必须没变 ===');
  const r1 = await ratingInLeaderboard(userId);
  ok(r1 === r0, 'AI 补位快速局不得改真人竞技分：' + r0 + ' -> ' + r1);

  const parts = ended?.participants ?? [];
  ok(parts.every((p) => p.ratingDelta === 0), '广播的参与者分差必须全为 0，实际 ' + JSON.stringify(parts.map((p) => p.ratingDelta)));

  console.log('=== 观测 ===');
  console.log('  DEMO_USER=' + username + ' rating ' + r0 + ' -> ' + r1);
  console.log(failures === 0 ? 'PUBLIC RATING CHECK: ALL PASS 0' : 'PUBLIC RATING CHECK: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
