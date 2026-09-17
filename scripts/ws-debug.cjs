// Instrumented reproduction of the browser queue flow to capture WS lifecycle.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONT = 'https://srszq.com';
const API = 'https://api.srszq.com';
const PORT = 9335;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => fetch(url).then((r) => r.json());

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result?.value; }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  // QA user via API
  const ts = Date.now().toString(36);
  const r = await fetch(`${API}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `wsdbg.${ts}@srszq.test`, username: `WSDBG_${ts}`, password: 'ws-secret-1' }) });
  const j = await r.json();
  await fetch(`${API}/api/tutorial/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${j.token}` }, body: '{}' });

  const profile = path.join(os.tmpdir(), 'srszq-wsdbg-' + process.pid);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) { await sleep(400); try { const list = await getJson(`http://127.0.0.1:${PORT}/json/list`); const p = list.find((t) => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch {} }
  const cdp = new CDP(wsUrl); await cdp.open();
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');

  // Instrument WebSocket before any page script runs.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      window.__wslog = [];
      const log = (...a) => window.__wslog.push({ t: Date.now(), ...a });
      const RealWS = window.WebSocket;
      function Wrapped(url, protocols) {
        const ws = protocols ? new RealWS(url, protocols) : new RealWS(url);
        const id = Math.random().toString(36).slice(2, 8);
        log({ e: 'create', id, url });
        ws.addEventListener('open', () => log({ e: 'open', id }));
        ws.addEventListener('close', (ev) => log({ e: 'close', id, code: ev.code, reason: ev.reason, clean: ev.wasClean }));
        ws.addEventListener('error', () => log({ e: 'error', id }));
        const orig = ws.addEventListener.bind(ws);
        ws.addEventListener = (type, fn, opts) => {
          if (type === 'message') { const f = (ev) => { try { log({ e: 'msg', id, data: String(ev.data).slice(0, 160) }); } catch {} return fn(ev); }; return orig(type, f, opts); }
          return orig(type, fn, opts);
        };
        return ws;
      }
      Wrapped.prototype = RealWS.prototype;
      window.WebSocket = Wrapped;
    })();
  ` });

  await cdp.send('Page.navigate', { url: FRONT });
  await sleep(4000);
  // Inject session, then fully reload so the app boots logged-in.
  await cdp.eval(`localStorage.setItem('srszq_token', ${JSON.stringify(j.token)}); localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(j.user))}); true`);
  await cdp.send('Page.reload');
  await sleep(5000);
  const body = await cdp.eval(`document.body.innerText`);
  console.log('lobby ok:', String(body).includes('在线匹配'));
  await cdp.eval(`(() => { const el=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').includes('在线匹配')); el && el.click(); return !!el; })()`);
  await sleep(3000);
  console.log('queue page:', String(await cdp.eval(`document.body.innerText`)).slice(0, 120));
  for (let i = 0; i < 15; i++) {
    await sleep(5000);
    const log = await cdp.eval(`window.__wslog`);
    console.log(`t+${(i + 1) * 5}s  wslog entries: ${log.length}`);
  }
  const log = await cdp.eval(`window.__wslog`);
  console.log(JSON.stringify(log, null, 1));
  cdp.close(); proc.kill();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
