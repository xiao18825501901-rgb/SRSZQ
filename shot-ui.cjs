// SRSZQ UI 截图工具（headless Edge + CDP）
// 用法：
//   SRSZQ_FRONTEND_URL=http://127.0.0.1:5173 node shot-ui.cjs results/ui-before 1440x900
// 页面集（SRSZQ_SHOT_PAGES，竖线分隔）：landing|auth|local|lobby|tutorial|rules|vsai|online|ranking
// 自动注册临时用户：lobby/tutorial 需登录（tutorial 用户未完成教学；lobby 用户已完成）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONT = process.env.SRSZQ_FRONTEND_URL ?? 'http://127.0.0.1:5173';
const API = process.env.SRSZQ_API_URL ?? 'http://127.0.0.1:8080';
const OUT_DIR = process.argv[2] ?? 'results/ui-shots';
const VIEWPORT = process.argv[3] ?? '1440x900';
const PAGES = (process.env.SRSZQ_SHOT_PAGES ?? 'landing|auth|local|rules').split('|');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => (await fetch(url)).json();

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('[shot]', file);
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function register(suffix) {
  const r = await fetch(`${API}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `shot${suffix}@test.com`, username: `Shot${suffix}`, password: 'secret1' }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('register failed: ' + JSON.stringify(j));
  await fetch(`${API}/api/tutorial/complete`, { method: 'POST', headers: { Authorization: 'Bearer ' + j.token } });
  return j;
}

async function main() {
  const [w, h] = VIEWPORT.split('x').map(Number);
  const profile = path.join(os.tmpdir(), `srszq-shot-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
    '--remote-debugging-port=9351', `--user-data-dir=${profile}`, `--window-size=${w},${h}`, FRONT,
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(400);
    try {
      const list = await getJson('http://127.0.0.1:9351/json/list');
      const page = list.find((t) => t.type === 'page' && (t.url.includes('localhost') || t.url.includes('127.0.0.1') || t.url.includes('srszq')));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* noop */ }
  }
  if (!wsUrl) { console.error('browser unavailable'); proc.kill(); process.exit(1); }
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  // 等首屏
  for (let i = 0; i < 40; i++) { try { if (await cdp.eval(`!!document.querySelector('#root')`)) break; } catch {} await sleep(300); }
  await sleep(800);

  const suffix = Date.now().toString(36);
  const base = path.join(OUT_DIR, `${w}x${h}`);
  const go = async (hash, wait = 900) => {
    await cdp.eval(`window.location.hash='${hash}'`);
    await sleep(wait);
  };

  for (const name of PAGES) {
    try {
      const pageSuffix = suffix + name.slice(0, 2);
      if (name === 'landing') { await go('/'); await sleep(1200); }
      else if (name === 'auth') { await go('/auth'); }
      else if (name === 'local') { await go('/local'); await sleep(1200); await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/START|开始/.test(x.textContent||'')); if(b) b.click(); return true; })()`); await sleep(700); }
      else if (name === 'vsai') { await go('/vsai'); await sleep(1000); }
      else if (name === 'ranking') { await go('/ranking'); await sleep(900); }
      else if (name === 'tutorial' || name === 'lobby' || name === 'online' || name === 'rules') {
        const fresh = await register(pageSuffix);
        const completeTut = name !== 'tutorial';
        if (completeTut) {
          // 已完成的用户
          const done = await register(pageSuffix + 'x');
          await cdp.eval(`localStorage.setItem('srszq_token','${done.token}')`);
          await cdp.eval(`localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(done.user))})`);
        } else {
          await cdp.eval(`localStorage.setItem('srszq_token','${fresh.token}')`);
          await cdp.eval(`localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(fresh.user))})`);
        }
        await cdp.eval(`location.reload()`);
        await sleep(1600);
        await go(name === 'tutorial' ? '/tutorial' : name === 'rules' ? '/rules' : name === 'lobby' ? '/lobby' : '/online', name === 'online' ? 1500 : 900);
      }
      await cdp.shot(path.join(base, `${name}.png`));
    } catch (e) {
      console.error(`[shot ${name}] ERR`, e.message);
    }
  }
  cdp.close();
  proc.kill();
  console.log('SHOTS DONE ->', base);
}

main().catch((e) => { console.error(e); process.exit(1); });
