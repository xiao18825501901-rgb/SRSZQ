/**
 * 增量 A/B/C 的本地端到端编排：起后端（临时库）→ 起前端静态服务 → 跑真实浏览器验收 → 收尾。
 *
 *   node scripts/dev/run-increment-e2e.mjs [--out evidence/increment-browser]
 *
 * 为什么要一个脚本：这台机器上 shell 嵌套引号极易出错（cmd/PowerShell 混用被坑过多次），
 * 而且端口/清理必须可控——之前的固定端口 + 未清进程树让探针测到了残留进程。
 * 这里统一：独立临时数据目录、独立端口、跑完 taskkill /T 清进程树。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = argOf('--out', 'evidence/increment-browser');
const API_PORT = Number(argOf('--api-port', '8080'));
const WS_PORT = Number(argOf('--ws-port', '8081'));
const SITE_PORT = Number(argOf('--site-port', '4173'));
const DATA = join(tmpdir(), 'srszq-inc-e2e', 'data');
const LOGS = join(tmpdir(), 'srszq-inc-e2e');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(label, cmd, argv, env, logFile) {
  const out = [];
  const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => out.push(String(d)));
  p.stderr.on('data', (d) => out.push(String(d)));
  children.push({ label, p });
  console.log('[stack] started ' + label + ' pid=' + p.pid);
  return { p, out, logFile };
}

async function waitHttp(url, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok || r.status < 500) return true; } catch { /* 还没起来 */ }
    await sleep(400);
  }
  throw new Error(label + ' 未就绪: ' + url);
}

function killAll() {
  for (const { label, p } of children) {
    if (!p.pid) continue;
    // Windows 上 tsx/vite 都会派生子进程：只杀父进程会留下占端口的僵尸。
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* noop */ } } }
    console.log('[stack] stopped ' + label);
  }
}

let exitCode = 1;
try {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  // 用 resolve：--out 允许给绝对路径（join 会把绝对路径拼到仓库后面，创建出畸形目录）。
  mkdirSync(resolve(ROOT, OUT), { recursive: true });

  // 关键：这份 e2e 打的是**本地**前后端，所以必须先用**本地 API 地址**重新构建前端。
  // 否则 dist 里可能装着上一次生产构建（指向 api.srszq.com），页面是 127.0.0.1 就会跨站，
  // HttpOnly cookie 根本不会带上 —— 本地会看到一片 401（本地自检踩到）。
  console.log('[stack] building frontend with local API urls ...');
  const build = spawnSync('cmd', ['/c', 'npm run build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_API_URL: 'http://127.0.0.1:' + API_PORT,
      VITE_WS_URL: 'ws://127.0.0.1:' + WS_PORT + '/ws',
      COMMIT_REF: 'local-e2e',
    },
  });
  if (build.status !== 0) throw new Error('前端本地构建失败，退出码 ' + build.status);
  console.log('[stack] frontend built with local API urls');

  const api = start('backend', 'cmd', ['/c', 'npx tsx backend/src/server.ts'], {
    SRSZQ_DATA_DIR: DATA,
    SRSZQ_ALLOWED_ORIGINS: 'http://127.0.0.1:' + SITE_PORT + ',http://localhost:' + SITE_PORT,
    PORT: String(API_PORT),
    SRSZQ_WS_PORT: String(WS_PORT),
  });
  await waitHttp('http://127.0.0.1:' + API_PORT + '/health', 60000, 'backend');
  console.log('[stack] backend ready');

  const site = start('frontend-preview', 'cmd', ['/c', 'npm run preview -w frontend -- --port ' + SITE_PORT + ' --host 127.0.0.1'], {});
  await waitHttp('http://127.0.0.1:' + SITE_PORT + '/', 60000, 'frontend');
  console.log('[stack] frontend ready');

  // --check 可以换成别的浏览器检查脚本（例如每日一题专项），默认仍是增量总检查。
  const CHECK = argOf('--check', 'scripts/dev/browser-increment-check.mts');
  console.log('[stack] running check: ' + CHECK);
  const e2e = spawn('cmd', ['/c', 'npx tsx ' + CHECK + ' --site http://127.0.0.1:' + SITE_PORT
    + ' --api http://127.0.0.1:' + API_PORT + ' --out ' + OUT], { cwd: ROOT, stdio: 'inherit' });
  exitCode = await new Promise((r) => e2e.on('exit', (c) => r(c ?? 1)));

  if (exitCode !== 0) {
    console.log('--- backend log tail ---');
    console.log(api.out.join('').slice(-1500));
    console.log('--- frontend log tail ---');
    console.log(site.out.join('').slice(-500));
  }
} catch (e) {
  console.error('FATAL ' + (e instanceof Error ? e.message : String(e)));
  for (const c of children) console.error('--- ' + c.label + ' ---\n' + c.out.join('').slice(-1200));
} finally {
  killAll();
}
process.exit(exitCode);
