// W10 browser gate: real Online Match AI fill plus responsive mobile/desktop geometry.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONT = process.env.SRSZQ_W10_FRONT_URL ?? 'http://127.0.0.1:5180/';
const API = process.env.SRSZQ_W10_API_URL ?? 'http://127.0.0.1:8090';
const DEBUG_PORT = 9600 + (process.pid % 200);
const BROWSER = process.env.BROWSER_PATH
  || (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const OUT = path.join(__dirname, 'results', 'w10');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
}

class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    };
    this.ws.onclose = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'));
      this.pending.clear();
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }
  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

async function registerUser() {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const response = await fetch(`${API}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `w10-${suffix}@test.com`, username: `W10${suffix.slice(-8)}`, password: 'secret1' }),
  });
  const auth = await response.json();
  if (!response.ok) throw new Error(`register failed: ${JSON.stringify(auth)}`);
  const done = await fetch(`${API}/api/tutorial/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const completed = await done.json();
  if (!done.ok) throw new Error(`tutorial completion failed: ${JSON.stringify(completed)}`);
  return { token: auth.token, user: completed.user };
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
    screenOrientation: { type: width < height ? 'portraitPrimary' : 'landscapePrimary', angle: 0 },
  });
  await sleep(180);
}

async function metrics(cdp) {
  return cdp.eval(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, display: getComputedStyle(element).display };
    };
    return {
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      board: rect('.online-board-col .board'),
      timeline: rect('[data-testid="mobile-victory-timeline"]'),
      players: rect('.online-mobile-players'),
      desktopBac: rect('.online-desktop-bac .bac-panel'),
      cells: document.querySelectorAll('.online-board-col .board .cell').length,
      seatTexts: [...document.querySelectorAll('.online-mobile-seat')].map((seat) => seat.innerText.replace(/\\s+/g, ' ')),
      timelineText: document.querySelector('[data-testid="mobile-victory-timeline"]')?.innerText.replace(/\\s+/g, ' ') ?? '',
    };
  })()`);
}

async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));
}

async function main() {
  const auth = await registerUser();
  const profile = path.join(os.tmpdir(), `srszq-w10-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  const browser = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-dev-shm-usage', '--disable-site-isolation-trials',
    '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=390,844', FRONT,
  ], { stdio: 'ignore' });

  let cdp;
  try {
    let target;
    for (let i = 0; i < 80 && !target; i++) {
      await sleep(250);
      try {
        const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        target = pages.find((page) => page.type === 'page' && (page.url.startsWith(new URL(FRONT).origin) || page.url === 'about:blank'));
      } catch { /* browser starting */ }
    }
    if (!target) throw new Error('headless Edge target unavailable');
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    console.log('INFO  isolated headless browser connected');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await setViewport(cdp, 390, 844);

    await cdp.eval(`localStorage.setItem('srszq_token', ${JSON.stringify(auth.token)}); localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(auth.user))}); location.hash = '#/online'; location.reload();`);

    let sawQueue = false;
    let reachedBoard = false;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const state = await cdp.eval(`({ text: document.body.innerText, cells: document.querySelectorAll('.online-board-col .board .cell').length })`).catch(() => ({ text: '', cells: 0 }));
      sawQueue ||= state.text.includes('Searching players') || state.text.includes('即将匹配完成');
      if (state.cells === 169) {
        reachedBoard = true;
        break;
      }
      await sleep(25);
    }
    check('1H shows server-backed matchmaking state', sawQueue);
    check('1H 400ms timeout → 2AI → real 13×13 board', reachedBoard);
    const initial = await metrics(cdp);
    const aiSeats = initial.seatTexts.filter((seatText) => /AI\s+★{1,5}/.test(seatText));
    const hiddenTactics = !initial.seatTexts.some((seatText) => /Random|Tactical|Selfish|3-?Ply|MaxN/i.test(seatText));
    check('authoritative room exposes exactly three seats with two AI', initial.seatTexts.length === 3 && aiSeats.length === 2, initial.seatTexts.join(' | '));
    check('public Online Match seats expose stars without tactic names', hiddenTactics, initial.seatTexts.join(' | '));

    const sizes = [[360, 800], [375, 812], [390, 844], [393, 873], [412, 915], [430, 932]];
    for (const [width, height] of sizes) {
      await setViewport(cdp, width, height);
      const m = await metrics(cdp);
      const ratio = m.board ? m.board.width / m.width : 0;
      const gap = m.board && m.timeline ? m.board.top - m.timeline.bottom : 999;
      const good = m.cells === 169
        && ratio >= 0.92
        && Math.abs(m.board.width - m.board.height) <= 1
        && m.board.top < m.height * 0.46
        && m.board.bottom <= m.height + 1
        && m.timeline?.display !== 'none'
        && m.timeline.top < m.board.top
        && gap >= 0 && gap <= 10
        && m.players?.display !== 'none'
        && (!m.desktopBac || m.desktopBac.width === 0)
        && m.scrollWidth <= m.width + 1;
      check(`${width}×${height} mobile layout`, good, `board=${ratio.toFixed(3)} gap=${gap.toFixed(1)} scroll=${m.scrollWidth}/${m.width}`);
      check(`${width}×${height} timeline data`, /R1 · TURN [ABC]/.test(m.timelineText) && m.timelineText.includes('当前胜权 无') && m.timelineText.includes('NEXT · R2 无') && /你\([ABC]\)下一次胜权：R[678]/.test(m.timelineText), m.timelineText.slice(0, 130));
      if (width === 360 || width === 390) await screenshot(cdp, `online-${width}x${height}.png`);
    }

    let moved = false;
    const moveStart = Date.now();
    while (Date.now() - moveStart < 5000 && !moved) {
      moved = await cdp.eval(`(() => { const cell = document.querySelector('.online-board-col .cell.legal'); if (!cell) return false; const before = document.querySelectorAll('.online-board-col .stone').length; cell.click(); return new Promise((resolve) => setTimeout(() => resolve(document.querySelectorAll('.online-board-col .stone').length > before), 180)); })()`);
      if (!moved) await sleep(80);
    }
    check('mobile board legal-cell hitbox remains clickable', moved);

    let advanced = '';
    const timelineStart = Date.now();
    while (Date.now() - timelineStart < 4000) {
      advanced = await cdp.eval(`document.querySelector('[data-testid="mobile-victory-timeline"]')?.innerText.replace(/\\s+/g, ' ') ?? ''`);
      if (/R2 · TURN [ABC]/.test(advanced)) break;
      await sleep(80);
    }
    check('mobile timeline advances with server game state', /R2 · TURN [ABC]/.test(advanced), advanced.slice(0, 100));

    for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
      await setViewport(cdp, width, height);
      const desktop = await metrics(cdp);
      check(`${width}×${height} desktop keeps full BAC side panel`, desktop.desktopBac?.display !== 'none' && desktop.timeline?.display === 'none' && desktop.board?.width > 400, `board=${desktop.board?.width ?? 0}`);
      check(`${width}×${height} has no horizontal overflow`, desktop.scrollWidth <= desktop.width + 1, `${desktop.scrollWidth}/${desktop.width}`);
      if (width === 1440) await screenshot(cdp, 'online-1440x900.png');
    }

    await cdp.send('Page.navigate', { url: `${FRONT}?debug=1#/local` });
    let localReady = false;
    for (let i = 0; i < 80 && !localReady; i++) {
      await sleep(50);
      localReady = await cdp.eval(`!!document.querySelector('.local-setup')`).catch(() => false);
    }
    await cdp.eval(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('开始对局')); button?.click(); return !!button; })()`);
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval(`typeof window.__tcf?.newGame === 'function'`).catch(() => false)) break;
      await sleep(50);
    }
    await cdp.eval(`window.__tcf.newGame(17)`);
    await setViewport(cdp, 390, 844);
    const board17 = await cdp.eval(`(() => { const board=document.querySelector('.board'); const r=board.getBoundingClientRect(); return { cells:document.querySelectorAll('.board .cell').length, width:r.width, height:r.height, viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth }; })()`);
    check('390×844 shared 17×17 board remains square and full-width', localReady && board17.cells === 289 && board17.width / board17.viewport >= 0.90 && Math.abs(board17.width - board17.height) <= 1 && board17.scrollWidth <= board17.viewport + 1, `cells=${board17.cells} ratio=${(board17.width / board17.viewport).toFixed(3)}`);

    const errors = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'));
    check('browser has no JavaScript exceptions', errors.length === 0, `errors=${errors.length}`);
    if (errors.length) console.log(JSON.stringify(errors.slice(0, 6), null, 2));
  } finally {
    cdp?.close();
    browser.kill();
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Windows may hold a browser profile lock briefly after process termination.
    }
  }

  console.log(failures ? `\nW10 E2E: ${failures} FAILURE(S)` : '\nW10 E2E: ALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('W10 E2E ERROR:', error);
  process.exit(1);
});
