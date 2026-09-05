// UI 级验证：Online Match Leave Match（主动离开判负）流程（临时脚本，需 5173/8080/8081 运行）
// 场景：X、Y 两人排队 → 60s 后 2H+1AI 开局 → X 点 Leave Match → 确认弹窗 → Confirm Leave
// 断言：X 结算卡 "You left the match. / Result: Loss"、Y 结算卡 "Opponent left. / You win!"
//       排行 X -10 / Y +30；双方"再来一局"可重新匹配。截图存 results/leave-ui/。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONT = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8080';
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra.slice(0, 220) + ']' : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('   [shot]', file);
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function getJson(url) { const r = await fetch(url); return r.json(); }

async function spawnPage(port) {
  const profile = path.join(os.tmpdir(), `srszq-leave-${port}-` + process.pid);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1500,1000', FRONT,
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(400);
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.url.includes('5173'));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* noop */ }
  }
  if (!wsUrl) throw new Error(`browser ${port} unavailable`);
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { cdp, proc };
}

async function register(name) {
  const r = await fetch(`${API}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}@test.com`, username: name, password: 'secret1' }),
  });
  const j = await r.json();
  await fetch(`${API}/api/tutorial/complete`, { method: 'POST', headers: { Authorization: 'Bearer ' + j.token } });
  return j;
}

async function loginAs(cdp, auth) {
  await cdp.eval(`localStorage.setItem('srszq_token','${auth.token}')`);
  await cdp.eval(`localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(auth.user))})`);
  await cdp.eval(`location.reload()`);
  await sleep(1500);
  await cdp.eval(`window.location.hash='#/online'`);
}

async function waitText(cdp, needle, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await cdp.eval(`document.body.innerText`).catch(() => '');
    if (needle.every((n) => t.replace(/\s+/g, ' ').includes(n))) return t.replace(/\s+/g, ' ');
    await sleep(300);
  }
  const t = (await cdp.eval(`document.body.innerText`).catch(() => '')).replace(/\s+/g, ' ');
  return t;
}

const clickBtn = (cdp, text) =>
  cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim().includes('${text}')); if(!b) return false; b.click(); return true; })()`);

async function main() {
  const dir = path.join(__dirname, 'results', 'leave-ui');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = Date.now().toString(36);
  const x = await register(`LeaveA${suffix}`);
  const y = await register(`LeaveB${suffix}`);
  const { cdp: cx, proc: px } = await spawnPage(9343);
  const { cdp: cy, proc: py } = await spawnPage(9344);
  try {
    await loginAs(cx, x);
    await loginAs(cy, y);
    let t = await waitText(cx, ['Searching players'], 8000);
    check('X 进入匹配队列（Searching players）', t.includes('Searching players'), t.slice(0, 120));
    await cy.eval(`window.location.hash='#/online'`);
    await sleep(1500);
    // 两人同时排队（60s 计时 → 2H+1AI 开局）
    await cx.eval(`window.location.hash='#/online'`);
    t = await waitText(cy, ['Searching players'], 8000);
    check('Y 进入匹配队列（Searching players）', t.includes('Searching players'), t.slice(0, 120));
    t = await waitText(cx, ['Leave Match'], 75000);
    const live1 = t.includes('Leave Match') && t.includes('在线对局');
    check('60s AI 补位后 2H 开局（对局页出现 Leave Match）', live1, t.slice(0, 160));
    await waitText(cy, ['Leave Match'], 15000);
    await cx.shot(path.join(dir, '01-match-live.png'));
    // X 点击 Leave Match → 确认弹窗
    await clickBtn(cx, 'Leave Match');
    await sleep(600);
    t = await cx.eval(`document.body.innerText`).then((s) => s.replace(/\s+/g, ' '));
    const modalOk = t.includes('Are you sure you want to leave? Leaving will count as a loss.') && t.includes('Cancel') && t.includes('Confirm Leave');
    check('确认弹窗文案 + Cancel/Confirm Leave', modalOk, t.slice(0, 200));
    await cx.shot(path.join(dir, '02-leave-confirm-modal.png'));
    // 取消不生效
    await clickBtn(cx, 'Cancel');
    await sleep(400);
    t = await cx.eval(`document.body.innerText`).then((s) => s.replace(/\s+/g, ' '));
    check('Cancel 不判负（仍在对局页）', t.includes('Leave Match') && !t.includes('Result: Loss'), t.slice(0, 120));
    // 确认离开
    await clickBtn(cx, 'Leave Match');
    await sleep(400);
    await clickBtn(cx, 'Confirm Leave');
    t = await waitText(cx, ['You left the match.', 'Result: Loss'], 8000);
    check('X 结算卡：You left the match. / Result: Loss', t.includes('You left the match.') && t.includes('Result: Loss'), t.slice(0, 160));
    await cx.shot(path.join(dir, '03-x-loss-card.png'));
    t = await waitText(cy, ['Opponent left.', 'You win!'], 8000);
    check('Y 结算卡：Opponent left. / You win!', t.includes('Opponent left.') && t.includes('You win!'), t.slice(0, 160));
    await cy.shot(path.join(dir, '04-y-win-card.png'));
    // 排行断言
    const meX = await (await fetch(`${API}/api/me`, { headers: { Authorization: 'Bearer ' + x.token } })).json();
    const meY = await (await fetch(`${API}/api/me`, { headers: { Authorization: 'Bearer ' + y.token } })).json();
    check('排行：离开者 X 1190（-10，games+1）', meX.user.rating === 1190, `rating=${meX.user.rating}`);
    check('排行：获胜者 Y 1230（+30，games+1/wins+1）', meY.user.rating === 1230, `rating=${meY.user.rating}`);
    // 再来一局 → 重新匹配能力
    await clickBtn(cx, '再来一局');
    t = await waitText(cx, ['Searching players'], 8000);
    check('X 离开后立即可再次匹配（Searching）', t.includes('Searching players'), t.slice(0, 120));
    await cx.shot(path.join(dir, '05-x-requeue.png'));
    await clickBtn(cx, '取消并返回');
    await sleep(300);
  } finally {
    cx.close(); cy.close();
    px.kill(); py.kill();
  }
  console.log(failures === 0 ? '\nLEAVE UI CHECK: ALL PASS' : `\nLEAVE UI CHECK: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('LEAVE UI CHECK error:', e.message); process.exit(1); });
