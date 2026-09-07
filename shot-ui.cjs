// SRSZQ UI 截图工具（headless Edge + CDP）
// 用法：
//   SRSZQ_FRONTEND_URL=http://127.0.0.1:5173 node shot-ui.cjs results/ui-before 1440x900
// 页面集（SRSZQ_SHOT_PAGES，竖线分隔）：landing|auth|local|game|lobby|tutorial|rules|vsai|online|ranking|friends
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
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.events = []; }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
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

async function register(suffix, completeTutorial = true) {
  const r = await fetch(`${API}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `shot${suffix}@test.com`, username: `Shot${suffix}`, password: 'secret1' }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('register failed: ' + JSON.stringify(j));
  if (completeTutorial) {
    await fetch(`${API}/api/tutorial/complete`, { method: 'POST', headers: { Authorization: 'Bearer ' + j.token } });
    j.user.tutorialCompleted = true;
  }
  return j;
}

async function main() {
  const [w, h] = VIEWPORT.split('x').map(Number);
  const profile = path.join(os.tmpdir(), `srszq-shot-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const browserArgs = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
    '--remote-debugging-port=9351', `--user-data-dir=${profile}`, `--window-size=${w},${h}`, FRONT,
  ];
  if (process.env.SRSZQ_DISABLE_WEB_SECURITY === '1') browserArgs.splice(1, 0, '--disable-web-security');
  const proc = spawn(EDGE, browserArgs, { stdio: 'ignore' });
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
  await cdp.send('Log.enable');
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
      if (name === 'landing') { await go('/'); await sleep(2500); }
      else if (name === 'auth') { await go('/auth'); }
      else if (name === 'local') { await go('/local'); await sleep(1200); }
      else if (name === 'game') { await go('/local'); await sleep(1200); await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/START|开始/.test(x.textContent||'')); if(b) b.click(); return true; })()`); await sleep(700); }
      else if (name === 'vsai') { await go('/vsai'); await sleep(1000); }
      else if (name === 'tutorial' || name === 'lobby' || name === 'online' || name === 'rules' || name === 'ranking' || name === 'friends') {
        const account = await register(pageSuffix, name !== 'tutorial');
        await cdp.eval(`localStorage.setItem('srszq_token','${account.token}')`);
        await cdp.eval(`localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(account.user))})`);
        await cdp.eval(`location.reload()`);
        await sleep(1600);
        const target = name === 'tutorial' ? '/tutorial' : name === 'rules' ? '/rules' : name === 'lobby' ? '/lobby' : name === 'ranking' ? '/ranking' : name === 'friends' ? '/friends' : '/online';
        await go(target, name === 'ranking' ? 2500 : name === 'online' ? 1500 : 900);
      }
      const audit = await cdp.eval(`(() => {
        const controls = [...document.querySelectorAll('input, select, textarea')];
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const hasLabel = (el) => !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')));
        const nameless = buttons.filter((el) => !((el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim())).length;
        const unlabeled = controls.filter((el) => !hasLabel(el)).length;
        const offenders = [...document.querySelectorAll('body *')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > innerWidth + 2 || r.left < -2;
        }).slice(0, 8).map((el) => el.className || el.tagName);
        const boardCell = document.querySelector('.board .cell')?.getBoundingClientRect();
        return {
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          offenders,
          nameless,
          unlabeled,
          boardCell: boardCell ? [Math.round(boardCell.width), Math.round(boardCell.height)] : null
        };
      })()`);
      console.log(`[audit ${name}]`, JSON.stringify(audit));
      await cdp.shot(path.join(base, `${name}.png`));
    } catch (e) {
      console.error(`[shot ${name}] ERR`, e.message);
    }
  }
  const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'));
  console.log(errors.length === 0 ? 'BROWSER CONSOLE: CLEAN' : `BROWSER CONSOLE: ${errors.length} ERROR(S)`);
  if (errors.length) console.error(JSON.stringify(errors.slice(0, 3), null, 2).slice(0, 2400));
  cdp.close();
  proc.kill();
  console.log('SHOTS DONE ->', base);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
