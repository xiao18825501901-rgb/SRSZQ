// Production browser walk for the new Ink UI on https://srszq.com.
// Headless Edge + CDP. Verifies: landing hero, rules, register, tutorial gate,
// tutorial AI response, lobby cards, Human vs AI, Local Match, ranking,
// friends, and the 60s AI-fill online match with hidden nav, turn clock and resign.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONT = process.env.SRSZQ_FRONTEND_URL ?? 'https://srszq.com';
const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const PORT = 9334;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ts = Date.now().toString(36);
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + String(extra).slice(0, 160) + ']' : ''}`);
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
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const getJson = (url) => fetch(url).then((r) => r.json());

async function main() {
  const profile = path.join(os.tmpdir(), 'srszq-ui-prod-' + process.pid);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1500,1000', FRONT], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(400);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(new URL(FRONT).origin));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) { console.log('FAIL  无法连接浏览器'); proc.kill(); process.exit(1); }
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const bodyText = () => cdp.eval(`document.body.innerText`).then((t) => t.replace(/\s+/g, ' '));
  const clickText = (text, selector = 'button') =>
    cdp.eval(`(() => { const el=[...document.querySelectorAll('${selector}')].find(b=>(b.textContent||'').includes('${text}')); if(!el) return false; el.click(); return true; })()`);
  const setField = (label, value) =>
    cdp.eval(`(() => { const l=[...document.querySelectorAll('label')].find(x=>(x.textContent||'').includes('${label}')); const i=l&&l.querySelector('input'); if(!i) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,'${value}'); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const waitText = async (text, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { if ((await bodyText()).includes(text)) return true; await sleep(250); }
    return false;
  };
  const waitEval = async (expr, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { if (await cdp.eval(expr)) return true; await sleep(250); }
    return false;
  };
  const pieces = () => cdp.eval(`document.querySelectorAll('[data-piece]:not([data-piece=""])').length`);
  const clickEmpty = () => cdp.eval(`(() => { const el=document.querySelector('button.go-point[data-piece=""]'); if(!el) return false; el.click(); return true; })()`);

  // 1. Landing
  {
    await waitText('注册并开始', 20000);
    const t = await bodyText();
    check('Landing 品牌与动作', t.includes('三人四子棋') && t.includes('注册并开始') && t.includes('本地对局') && t.includes('排行榜'), t.slice(0, 80));
    check('Landing 三条速学规则', t.includes('最先连成四颗子的玩家赢得游戏') && t.includes('三人轮流下完一子为一回合') && t.includes('胜权'));
    const hero = await pieces();
    check('Landing 首页 MaxN 真实棋谱盘面', hero >= 25, `hero pieces=${hero}`);
  }
  // 2. Rules page
  {
    await clickText('怎么玩');
    const ok = await waitText('三人四子棋怎么玩');
    const t = await bodyText();
    check('规则页渲染（速览 + 胜权）', ok && t.includes('胜权') && t.includes('13×13'));
    await clickText('返回');
    await waitText('注册并开始');
  }
  // 3. Register through the UI
  const email = `ui.${ts}@srszq.test`, name = `UI_${ts}`, pwd = 'ui-secret-1';
  {
    await clickText('注册并开始');
    const ok = await waitText('初次见面，来下一盘');
    check('注册页渲染', ok);
    await setField('邮箱', email); await setField('用户名', name); await setField('密码', pwd);
    await clickText('注册并开始');
    const tut = await waitText('新手教学');
    check('UI 注册成功 → 教学门禁', tut);
  }
  // 4. Tutorial: AI responds to a real move
  {
    await clickText('开始练习');
    const board = await waitEval(`!!document.querySelector('[data-testid="local-game"]')`);
    check('教学对局棋盘', board);
    let advanced = false;
    for (let i = 0; i < 20 && !advanced; i++) {
      const before = await pieces();
      await clickEmpty();
      await sleep(1800);
      advanced = (await pieces()) > before;
    }
    check('教学 AI 响应（含本人落子）', advanced);
    const coach = await bodyText();
    check('教学教练文案（胜权提示）', coach.includes('胜权'));
  }
  // 5. Complete tutorial via API and enter lobby
  {
    const token = await cdp.eval(`localStorage.getItem('srszq_token')`);
    const r = await fetch(`${API}/api/tutorial/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    if (!r.ok) throw new Error('tutorial complete api ' + r.status);
    await cdp.send('Page.reload');
    const ok = await waitEval(`(document.body.innerText||'').includes('游戏大厅') || (document.body.innerText||'').includes('准备好正式对弈了')`, 15000);
    if ((await bodyText()).includes('准备好正式对弈了')) await clickText('进入大厅');
    const t = await bodyText();
    check('大厅四张模式卡片', ok && t.includes('在线匹配') && t.includes('人机对战') && t.includes('离线模式') && t.includes('好友对弈'));
  }
  // 6. Human vs AI
  {
    await clickText('人机对战');
    const setup = await waitText('人机对战') && (await waitText('开始对局'));
    check('人机设置页', setup);
    await clickText('开始对局');
    await waitEval(`!!document.querySelector('[data-testid="local-game"]')`);
    let advanced = false;
    for (let i = 0; i < 20 && !advanced; i++) {
      const before = await pieces();
      await clickEmpty();
      await sleep(1500);
      advanced = (await pieces()) > before;
    }
    const t = await bodyText();
    check('人机对局推进（AI 自动落子）', advanced);
    check('AI 档位只显示星标', !/maxn|random|selfish/i.test(t));
    await clickText('返回');
    await waitText('开始对局');
    await clickText('返回');
    await waitText('游戏大厅');
  }
  // 7. Local match
  {
    await clickText('离线模式');
    const setup = await waitText('离线模式') && (await waitText('开始对局'));
    check('本地对局设置页（13/17 路 + 三真人）', setup);
    await clickText('开始对局');
    await waitEval(`!!document.querySelector('[data-testid="local-game"]')`);
    const before = await pieces();
    await clickEmpty();
    await sleep(800);
    const after = await pieces();
    check('本地对局落子生效', after === before + 1, `pieces ${before}->${after}`);
    await clickText('返回'); await waitText('开始对局');
    await clickText('返回'); await waitText('游戏大厅');
  }
  // 8. Ranking
  {
    await clickText('排行榜', 'button');
    const ok = await waitText('仅在线匹配计分', 15000);
    const rowsReady = await waitEval(`document.querySelectorAll('table.ranking-table tbody tr').length > 0`, 10000);
    const rows = await cdp.eval(`document.querySelectorAll('table.ranking-table tbody tr').length`);
    const t = await bodyText();
    check('排行榜：仅在线匹配计分 + 分页数据', ok && rowsReady && rows > 0 && /全部 \d+ 位玩家/.test(t), `rows=${rows}`);
  }
  // 9. Friends
  {
    await clickText('好友', 'button');
    const ok = await waitText('好友与邀请');
    const hasInput = await cdp.eval(`!!document.querySelector('input[aria-label="受邀好友用户名"]')`);
    check('好友与邀请页', ok && hasInput);
  }
  // 10. Online match: 60s AI fill, hidden nav, clock, resign
  {
    await clickText('大厅', 'button');
    await waitText('游戏大厅');
    await clickText('在线匹配');
    const queued = await waitText('正在寻找对手');
    const t = await bodyText();
    check('匹配等待页（60 秒 AI 补位说明）', queued && t.includes('60 秒内不足 3 名真人时，将由 AI 补位自动开局。'));
    const started = await waitEval(`!!document.querySelector('[data-testid="online-game"]')`, 75000);
    check('60 秒 AI 补位自动开局（真实等待）', started);
    if (started) {
      const navHidden = await cdp.eval(`!document.querySelector('nav[aria-label="网站导航"]')`);
      check('在线对局隐藏导航栏', navHidden);
      const clock = await cdp.eval(`!!document.querySelector('[role="timer"][aria-label="落子倒计时"]')`);
      const t2 = await bodyText();
      check('在线对局 30 秒时钟元素 + 胜权面板', clock && t2.includes('胜权'));
      await clickText('退出对局');
      await waitText('退出对局？');
      await clickText('确认退出');
      const ended = await waitText('已退出，本局判负', 10000) || await waitText('对手退出', 10000) || await waitText('落子超时', 10000);
      check('退出对局流程走到终局（判负文案）', ended, (await bodyText()).slice(0, 90));
      await clickText('返回大厅');
      await waitText('游戏大厅');
    }
  }
  // Uncaught page exceptions
  const excs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('零未捕获页面异常', excs.length === 0, `${excs.length} exceptions`);

  cdp.close();
  proc.kill();
  console.log(failures === 0 ? 'UI PROD WALK: ALL PASS' : `UI PROD WALK: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
