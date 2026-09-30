/**
 * 每日一题「点棋盘弹 Not Found」的取证脚本（先复现，再修）。
 *
 *   node scripts/dev/puzzles-attempt-probe.mjs
 *
 * 起一个真实后端（临时库），把两种 URL 形态都打一遍：
 *   A) 原始 puzzleId（含冒号）      —— 产品测试里就是这么调的
 *   B) encodeURIComponent 之后的 id —— 前端 api.ts 是这么调的
 * 用真实响应判断 404 到底出在哪一层。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 8099;
const WS = 8098;
const DATA = join(mkdtempSync(join(tmpdir(), 'srszq-puzzle-probe-')), 'data');
mkdirSync(DATA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const be = spawn('cmd', ['/c', 'npx tsx backend/src/server.ts'], {
  cwd: ROOT,
  env: { ...process.env, SRSZQ_DATA_DIR: DATA, PORT: String(PORT), SRSZQ_WS_PORT: String(WS) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
be.stdout.on('data', (d) => log.push(String(d)));
be.stderr.on('data', (d) => log.push(String(d)));

const API = 'http://127.0.0.1:' + PORT;
const out = { api: API };
try {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(API + '/health'); if (r.ok) break; } catch { /* 等 */ }
    await sleep(400);
  }
  const reg = await fetch(API + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'probe@t.local', username: 'ProbeUser', password: 'Passw0rd!23' }) });
  const regJson = await reg.json();
  const token = regJson.token;
  await fetch(API + '/api/tutorial/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
  const daily = await (await fetch(API + '/api/puzzles/daily', { headers: { Authorization: 'Bearer ' + token } })).json();
  const pz = daily.puzzle;
  out.puzzleId = pz.puzzleId;
  out.puzzleIdHasColon = pz.puzzleId.includes(':');
  out.encodedId = encodeURIComponent(pz.puzzleId);
  out.encodedDiffers = out.encodedId !== pz.puzzleId;
  const attempt = async (label, idInUrl) => {
    const r = await fetch(API + '/api/puzzles/' + idInUrl + '/attempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ attemptId: 'probe-' + label + '-' + Date.now(), row: 0, col: 0 }),
    });
    const t = await r.text();
    return { label, url: '/api/puzzles/' + idInUrl + '/attempt', status: r.status, body: t.slice(0, 220) };
  };
  out.rawId = await attempt('raw', pz.puzzleId);
  out.encodedIdCall = await attempt('encoded', out.encodedId);
  out.getByRawId = (await fetch(API + '/api/puzzles/' + pz.puzzleId, { headers: { Authorization: 'Bearer ' + token } })).status;
  out.getByEncodedId = (await fetch(API + '/api/puzzles/' + out.encodedId, { headers: { Authorization: 'Bearer ' + token } })).status;
} catch (e) {
  out.error = String(e);
} finally {
  if (be.pid) spawnSync('taskkill', ['/PID', String(be.pid), '/T', '/F'], { stdio: 'ignore' });
}
console.log(JSON.stringify(out, null, 2));
console.log('--- backend log tail ---');
console.log(log.join('').slice(-400));
process.exit(0);