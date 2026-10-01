/**
 * 规格 4.2「第 4 局起不计竞技分**且开局前提示**」的浏览器级证据。
 *
 *   npx tsx scripts/dev/browser-rating-notice-check.mts --site http://127.0.0.1:4173 --api http://127.0.0.1:8080
 *
 * 为什么必须用真实浏览器：这条规格的失败方式就是“分数没错、但玩家根本不知道” ——
 * 纯接口断言查不出提示有没有真的渲染出来。这里让真人真的排一局（20 秒后 AI 补位开局），
 * 然后断言页面上出现了「不计竞技分」的提示，并截图留证。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'http://127.0.0.1:4173');
const API = argOf('--api', 'http://127.0.0.1:8080');
const OUT = argOf('--out', 'evidence/rating-notice');
const PORT = 9900 + Math.floor(Math.random() * 90);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket, private sessionId: string) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const pr = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) pr.reject(new Error(msg.error.message)); else pr.resolve(msg.result);
      }
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId: string | null = this.sessionId): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 240));
    return r.result?.value;
  }
  async waitFor(selector: string, timeoutMs = 20000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')')) return true; } catch { /* 重试 */ }
      await sleep(200);
    }
    return false;
  }
  async shot(path: string): Promise<{ bytes: number; width: number; height: number }> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(path, buf);
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) throw new Error('不是 PNG: ' + path);
    return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const name = ('dshrn' + stamp).slice(0, 16);
  const reg = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  if (reg.status !== 201) { console.log('FAIL 注册测试账号 status=' + reg.status); process.exit(1); }
  const token = reg.json.token as string;
  await api('POST', '/api/tutorial/complete', {}, token);
  const me = await api('GET', '/api/me', undefined, token);
  const user = me.json.user;
  console.log('测试账号：' + name + '（已通过 API 完成教学）');

  const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((b) => existsSync(b))!;
  const profile = join(tmpdir(), 'srszq-rn-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  try {
    let info: any = null;
    for (let i = 0; i < 80 && !info; i += 1) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) info = await r.json(); } catch { /* 等 */ } if (!info) await sleep(250); }
    const ws = new WebSocket(info.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const cdp = new Cdp(ws, '');
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    const page = new Cdp(ws, attached.sessionId as string);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        'try {',
        '  localStorage.setItem("srszq_token", ' + JSON.stringify(token) + ');',
        '  localStorage.setItem("srszq_user", ' + JSON.stringify(JSON.stringify(user)) + ');',
        '} catch (e) {}',
      ].join('\n'),
    });

    console.log('=== 1. 进匹配队列（20 秒后 AI 补位） ===');
    await page.send('Page.navigate', { url: SITE + '/#/online' });
    const queued = await page.waitFor('.matchmaking-card', 25000);
    ok(queued, '进入匹配页');
    if (!queued) {
      const diag = { url: await page.evaluate('location.href'), body: String(await page.evaluate('document.body.innerText')).slice(0, 300) };
      console.log('  DIAG ' + JSON.stringify(diag));
      process.exit(1);
    }

    console.log('=== 2. 开局后必须出现「不计竞技分」的提示（规格 4.2 开局前提示） ===');
    const started = await page.waitFor('[data-testid=online-game]', 40000);
    ok(started, '对局开始（1 真人 + 2 AI 补位）');
    if (!started) {
      const body = String(await page.evaluate('document.body.innerText')).slice(0, 300);
      console.log('  DIAG 未开局：' + body);
      process.exit(1);
    }
    const noticeShown = await page.waitFor('[data-testid=rating-notice]', 10000);
    ok(noticeShown, '页面上出现了计分提示（data-testid=rating-notice）');
    const notice = String(await page.evaluate('document.querySelector("[data-testid=rating-notice]")?.innerText ?? ""'));
    console.log('  提示文案：' + notice);
    ok(/不计竞技分/.test(notice), '提示明确说了“不计竞技分”');
    ok(/AI 补位/.test(notice), '提示说清了原因（AI 补位）');
    // 逆断言：既然本局不计分，就不该出现任何“本局计分”的暗示
    const body = String(await page.evaluate('document.body.innerText'));
    ok(!/本局计(入)?竞技分/.test(body), '没有任何“本局计竞技分”的相反暗示');

    console.log('=== 3. 截图 ===');
    const shot = await page.shot(join(OUT, 'rating-notice-1440x900.png'));
    ok(shot.width === 1440 && shot.height === 900, '截图 1440x900（' + shot.bytes + ' bytes）');
    ws.close();
  } finally {
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  console.log('RATING NOTICE BROWSER CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
