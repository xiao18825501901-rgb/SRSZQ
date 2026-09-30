/**
 * 定向探针：在真实浏览器里跑一键建号，并**捕获控制台/网络/存储**，用来定位“生产上 localStorage 被清空”的真实原因。
 *
 *   npx tsx scripts/dev/prod-quickstart-probe.mts --site https://srszq.com --api https://api.srszq.com
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'https://srszq.com');
const API = argOf('--api', 'https://api.srszq.com');
const OUT = argOf('--out', 'evidence/prod-probe');
const PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BROWSERS = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];

const bin = BROWSERS.find((b) => existsSync(b))!;
mkdirSync(OUT, { recursive: true });
const profile = join(tmpdir(), 'srszq-probe-' + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

const waitJson = async (url: string): Promise<any> => {
  for (let i = 0; i < 80; i += 1) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* 等待 */ } await sleep(250); }
  throw new Error('CDP 未就绪');
};

try {
  const info = await waitJson('http://127.0.0.1:' + PORT + '/json/version');
  const ws = new WebSocket(info.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const events: Array<Record<string, any>> = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); return; }
    if (m.method) events.push({ method: m.method, params: m.params });
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
    const myId = ++id;
    return new Promise((resolve) => { pending.set(myId, resolve); ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) })); });
  };
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const S = attached.sessionId as string;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Log.enable', {}, S);
  await send('Network.enable', {}, S);
  const evalIn = async (expr: string): Promise<any> => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    return r.exceptionDetails ? { __exception: JSON.stringify(r.exceptionDetails).slice(0, 300) } : r.result?.value;
  };

  await send('Page.navigate', { url: SITE + '/' }, S);
  await sleep(2500);
  console.log('BEFORE cta: user=' + JSON.stringify(await evalIn('localStorage.getItem("srszq_user")')));
  await evalIn('document.querySelector("[data-testid=cta-quick-start]").click()');
  for (let i = 0; i < 12; i += 1) {
    await sleep(1000);
    const u = await evalIn('localStorage.getItem("srszq_user")');
    const tok = await evalIn('localStorage.getItem("srszq_token")');
    const url = await evalIn('location.href');
    console.log('t+' + (i + 1) + 's url=' + url + ' user=' + String(u).slice(0, 80) + ' token=' + String(tok));
  }
  console.log('--- page fetch /api/me ---');
  console.log(JSON.stringify(await evalIn('fetch(' + JSON.stringify(API + '/api/me') + ', { credentials: "include" }).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 200) })).catch(e => ({ err: String(e.message) }))')));
  console.log('--- console/network events ---');
  for (const e of events.filter((x) => /exception|console|loadingFailed|responseReceived/.test(x.method)).slice(-25)) {
    const p: any = e.params;
    if (e.method === 'Runtime.consoleAPICalled') console.log('console.' + p.type + ' ' + JSON.stringify(p.args?.map((a: any) => a.value ?? a.description)).slice(0, 200));
    else if (e.method === 'Runtime.exceptionThrown') console.log('EXCEPTION ' + String(p.exceptionDetails?.exception?.description ?? '').slice(0, 200));
    else if (e.method === 'Network.loadingFailed') console.log('NETFAIL ' + p.errorText + ' ' + String(p.blockedReason ?? ''));
    else if (e.method === 'Network.responseReceived' && /srszq/.test(String(p.response?.url))) console.log('RESP ' + p.response.status + ' ' + String(p.response.url).slice(0, 110));
  }
  ws.close();
} finally {
  if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
// 必须显式退出：CDP 的 WebSocket 与子进程句柄会让 node 一直挂在事件循环里（本地自检踩到，
// 结果整个探针把上层 10 分钟的上限顶掉了）。
process.exit(0);
