// SRSZQ.com 平台 E2E（headless Edge + CDP）：Landing / 注册登录 / 教学门禁 / 大厅 /
// 排行 / 好友 / 本地对局 / 在线排队。默认要求本地 frontend 5173 + backend 8080/8081，
// 也可通过 SRSZQ_FRONTEND_URL / SRSZQ_API_URL 验收已部署环境。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONT = process.env.SRSZQ_FRONTEND_URL ?? 'http://127.0.0.1:5173';
const API = process.env.SRSZQ_API_URL ?? 'http://127.0.0.1:8080';
const FRONT_ORIGIN = new URL(FRONT).origin;
const PORT = 9333;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
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
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function getJson(url) { const r = await fetch(url); return r.json(); }

async function main() {
  const profile = path.join(os.tmpdir(), 'srszq-e2e-' + process.pid);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1500,1000', FRONT,
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(400);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(FRONT_ORIGIN));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* noop */ }
  }
  if (!wsUrl) { console.log('FAIL 无法连接浏览器'); proc.kill(); process.exit(1); }
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  const bodyText = () => cdp.eval(`document.body.innerText`).then((t) => t.replace(/\s+/g, ' '));
  const click = (selector, text) =>
    cdp.eval(`(() => { const el=[...document.querySelectorAll('${selector}')].find(b=>(b.textContent||'').includes('${text}')); if(!el) return false; el.click(); return true; })()`);
  const setVal = async (selector, value) => {
    await cdp.eval(`(() => { const el=document.querySelector('${selector}'); if(!el) return false; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(el,'${value}'); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  };
  const goto = async (hash) => { await cdp.eval(`window.location.hash='${hash}'`); await sleep(400); };

  for (let i = 0; i < 40; i++) { try { if ((await cdp.eval(`!!document.querySelector('.hero, .landing, .app')`))) break; } catch {} await sleep(400); }

  const suffix = Date.now().toString(36);
  const email = `e2e${suffix}@test.com`;
  const username = `E2E${suffix}`;

  // 1) Landing
  let txt = await bodyText();
  check('Landing 渲染（Hero SRSZQ）', /SRSZQ/.test(txt) && /Play Online|注册并开始/.test(txt), txt.slice(0, 120));
  check('Landing 无真实 AI 档位名', !/Random|Tactical|Selfish|3-Ply|MaxN/.test(txt), '');
  check('Landing 规则速览 above the fold（含胜权摘要）', txt.includes('怎么玩') && txt.includes('胜权') && txt.includes('C → B → A'), txt.slice(0, 150));

  // 1b) 规则页（TEST1/TEST2/TEST3：入口明显、胜权完整解释、时间线与引擎一致）
  await goto('/rules');
  await sleep(600);
  txt = await bodyText();
  check('规则页：标题 三人四子棋怎么玩 + 速览', txt.includes('三人四子棋怎么玩') && txt.includes('规则速览'), txt.slice(0, 150));
  check('规则页：胜权完整解释（七问）', txt.includes('什么是「胜权」') && txt.includes('只有当前拥有「胜权」的玩家') && txt.includes('禁手'), txt.slice(0, 200));
  check('规则页：胜权时间线 R6=C/R7=B/R8=A 与引擎一致', txt.includes('R6') && txt.includes('C → B → A') && txt.includes('Round 1–5'), txt.slice(0, 220));
  await goto('/');
  await sleep(400);

  // 2) 注册
  await goto('/auth');
  await sleep(300);
  txt = await bodyText();
  check('Auth 页可访问', txt.includes('注册 SRSZQ'), '');
  await setVal('input[type=email]', email);
  await setVal('input[placeholder^="2-16"]', username);
  await setVal('input[type=password]', 'secret1');
  await click('button[type=submit]', '注册并开始');
  await sleep(3200);
  txt = await bodyText();
  check('新用户注册后进入教学（门禁）', txt.includes('新手教学') || txt.includes('与 AI 练习'), txt.slice(0, 150));
  // 新教程 = 1 真人(A) + 2 AI(B/C)，AI 来自真实 registry 且互不相同（身份栏显示真实档位名）
  const tutAi = (txt.match(/(Random|Tactical|Selfish|3-Ply|MaxN)/g) || []);
  check('教程身份：1 真人(A) + 2 随机 AI（真实 registry、互不相同）', txt.includes('玩家 A（真人）') && txt.includes('对手 · 玩家 B') && txt.includes('对手 · 玩家 C') && new Set(tutAi).size === 2, `${txt.slice(0, 160)} | ai=${[...new Set(tutAi)].join(',')}`);
  check('教程页规则速览可展开（胜权一句话）', txt.includes('规则速览') && txt.includes('胜权'), '');

  // 3) 未完成教学不能进大厅/在线
  await goto('/lobby');
  await sleep(400);
  txt = await bodyText();
  check('未完成教学访问大厅被重定向回教学', txt.includes('新手教学'), txt.slice(0, 120));
  await goto('/online');
  await sleep(400);
  txt = await bodyText();
  check('未完成教学访问在线被重定向', txt.includes('新手教学'), txt.slice(0, 120));

  // 3b) 教学首局可玩：人类落子 → 隐藏 AI 自动应手（仅 ★）
  await cdp.eval(`(() => { const el=document.querySelector('.cell.legal'); if(el) el.click(); return true; })()`);
  const tt0 = Date.now();
  let tLines = 0;
  while (Date.now() - tt0 < 12000) {
    tLines = await cdp.eval(`document.querySelectorAll('.history-line').length`);
    if (tLines >= 2) break;
    await sleep(150);
  }
  check('教学首局 AI 自动应手（★ 隐藏档位）', tLines >= 2, `lines=${tLines}`);
  const tutCards = await cdp.eval(`[...document.querySelectorAll('.players-row .player-card')].map(c=>c.innerText.replace(/\\s+/g,' '))`);
  const aiCard = tutCards.find((c) => c.includes('🤖 AI'));
  check('教学 AI 座位为 ★ 显示', !!aiCard && /AI · ★+/.test(aiCard ?? '') && !/Random|Tactical|Selfish/.test(aiCard ?? ''), (aiCard ?? '').slice(0, 60));
  await click('button', '返回');
  await sleep(500);
  txt = await bodyText();
  check('教学中返回仍被门禁拦截', txt.includes('新手教学'), txt.slice(0, 120));

  // 4) 直接调用后端完成教学 → 重载同步会话 → 大厅解锁
  await cdp.eval(`(async () => {
    const t = localStorage.getItem('srszq_token');
    await fetch(${JSON.stringify(API + '/api/tutorial/complete')}, { method: 'POST', headers: { Authorization: 'Bearer ' + t } });
  })()`);
  await cdp.eval(`location.reload()`);
  await sleep(1500);
  await click('button', '进入大厅');
  await sleep(500);
  await goto('/lobby');
  await sleep(600);
  txt = await bodyText();
  check('大厅显示三入口 + 好友', txt.includes('Online Match') && txt.includes('Human vs AI') && txt.includes('Local Match') && txt.includes('好友邀请'), txt.slice(0, 160));

  // 5) Human vs AI：选 AI 座位与 ★ 难度 → 开局 → AI 自动应手（只显示星级）
  await goto('/vsai');
  await sleep(500);
  await click('button', '开始对局');
  await sleep(800);
  let cellsVs = await cdp.eval(`document.querySelectorAll('.board .cell').length`);
  check('Human vs AI 开局（13×13）', cellsVs === 169, `cells=${cellsVs}`);
  let cardB = await cdp.eval(`document.querySelectorAll('.players-row .player-card')[1]?.innerText || ''`);
  check('AI 座位只显示 ★ 星级', /🤖 AI · ★+/.test(cardB) && !/Random|Tactical|Selfish|3-Ply|MaxN/.test(cardB), cardB.replace(/\s+/g, ' ').slice(0, 60));
  await cdp.eval(`(() => { const el=document.querySelector('.cell.legal'); if(el) el.click(); return true; })()`);
  const t0 = Date.now();
  let lines = 0;
  while (Date.now() - t0 < 12000) {
    lines = await cdp.eval(`document.querySelectorAll('.history-line').length`);
    if (lines >= 2) break;
    await sleep(150);
  }
  check('AI 自动应手（日志 ≥2 条）', lines >= 2, `lines=${lines}`);
  // 5c) BAC Victory Timeline（Human vs AI：同引擎实时显示 + 自动更新到 R6=C）
  let bac1 = (await cdp.eval(`document.querySelector('.bac-panel')?.innerText || ''`)).replace(/\s+/g, ' ');
  check('HvAI BAC 面板：ROUND 1 · VICTORY LOCKED · 下次窗口 R6 C', bac1.includes('BAC Victory Timeline') && bac1.includes('ROUND 1') && bac1.includes('VICTORY LOCKED') && bac1.includes('Round 6'), bac1.slice(0, 160));
  const t1 = Date.now();
  while (Date.now() - t1 < 60000) {
    bac1 = (await cdp.eval(`document.querySelector('.bac-panel')?.innerText || ''`)).replace(/\s+/g, ' ');
    if (bac1.includes('CURRENT · ROUND 6') && bac1.includes('Victory Right')) break;
    await cdp.eval(`(() => { const el=document.querySelector('.cell.legal'); if(el) el.click(); return true; })()`);
    await sleep(250);
  }
  check('HvAI 推进到 R6：面板实时更新（C 持胜权 + R7/R8 未来窗口）', bac1.includes('ROUND 6') && bac1.includes('Victory Right') && bac1.includes('R7') && bac1.includes('R8'), bac1.slice(0, 180));
  await click('button', '返回大厅');
  await sleep(500);

  // 5b) 排行榜含本用户
  await goto('/ranking');
  await sleep(500);
  txt = await bodyText();
  check('排行榜渲染且含新用户', txt.includes('排行榜') && txt.includes(username), txt.slice(0, 150));

  // 6) 好友页（邀请自己以外的用户：先注册第二个用户）
  const email2 = `e2e2${suffix}@test.com`;
  const name2 = `Bob${suffix}`;
  await cdp.eval(`(async () => {
    await fetch(${JSON.stringify(API + '/api/register')}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${email2}', username: '${name2}', password: 'secret1' }) });
  })()`);
  await goto('/friends');
  await sleep(400);
  await cdp.eval(`(() => { const el=document.querySelector('.friend-invite input'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el,'${name2}'); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await click('button', 'Invite');
  let inviteTxt = '';
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    inviteTxt = await bodyText();
    if (inviteTxt.includes('已向')) break;
  }
  check('邀请发送成功提示', inviteTxt.includes('已向') && inviteTxt.includes(name2), inviteTxt.slice(0, 140));

  // 6b) 双浏览器：Bob 在好友页接受邀请 → 双方自动进入对局（2H+1AI，AI 补位）
  const PORT2 = 9334;
  const loginBob = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: name2, password: 'secret1' }),
  });
  const bobAuth = await loginBob.json();
  const profile2 = path.join(os.tmpdir(), 'srszq-e2e2-' + process.pid);
  fs.rmSync(profile2, { recursive: true, force: true });
  const proc2 = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT2}`, `--user-data-dir=${profile2}`, '--window-size=1500,1000', FRONT,
  ], { stdio: 'ignore' });
  let wsUrl2 = null;
  for (let i = 0; i < 60 && !wsUrl2; i++) {
    await sleep(400);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT2}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(FRONT_ORIGIN));
      if (page) wsUrl2 = page.webSocketDebuggerUrl;
    } catch { /* noop */ }
  }
  let cdp2 = null;
  if (wsUrl2) {
    cdp2 = new CDP(wsUrl2);
    await cdp2.open();
    await cdp2.send('Runtime.enable');
    await cdp2.send('Page.enable');
    await cdp2.send('Log.enable');
    // 确保页面完成加载（origin 就绪）后再写会话
    await cdp2.send('Page.navigate', { url: FRONT });
    let ready2 = false;
    for (let i = 0; i < 40 && !ready2; i++) {
      await sleep(300);
      try {
        ready2 = (await cdp2.eval(`location.origin === ${JSON.stringify(FRONT_ORIGIN)} && document.readyState === 'complete'`)) === true;
      } catch { /* noop */ }
    }
    check('Bob 浏览器页面就绪', ready2);
    await cdp2.eval(`localStorage.setItem('srszq_token', '${bobAuth.token}')`);
    await cdp2.eval(`localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(bobAuth.user))})`);
    await cdp2.eval(`location.reload()`);
    await sleep(1400);
    await cdp2.eval(`window.location.hash='#/friends'`);
    await sleep(1200);
    let invText2 = await cdp2.eval(`document.body.innerText`);
    for (let i = 0; i < 12 && !invText2.includes('邀请你对战'); i++) {
      await sleep(400);
      invText2 = await cdp2.eval(`document.body.innerText`);
    }
    check('Bob 好友页看到待处理邀请', invText2.includes('邀请你对战'), invText2.replace(/\s+/g, ' ').slice(0, 120));
    await cdp2.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('接受')); if(b) b.click(); return !!b; })()`);
    await sleep(900);
    // 双方自动导航 #/online 并渲染对局
    let h1 = '', h2 = '';
    const tt0 = Date.now();
    while (Date.now() - tt0 < 12000) {
      h1 = await cdp.eval(`location.hash`);
      h2 = await cdp2.eval(`location.hash`);
      if (h1.includes('/online') && h2.includes('/online')) break;
      await sleep(200);
    }
    check('接受邀请后双方自动进入对局页', h1.includes('/online') && h2.includes('/online'), `${h1} / ${h2}`);
    let cells1 = 0, cells2 = 0;
    const ct0 = Date.now();
    while (Date.now() - ct0 < 9000) {
      cells1 = await cdp.eval(`document.querySelectorAll('.board .cell').length`).catch(() => 0);
      cells2 = await cdp2.eval(`document.querySelectorAll('.board .cell').length`).catch(() => 0);
      if (cells1 === 169 && cells2 === 169) break;
      await sleep(200);
    }
    check('双方渲染 13×13 棋盘', cells1 === 169 && cells2 === 169, `${cells1}/${cells2}`);
    const txt2 = await cdp2.eval(`document.body.innerText`);
    check('邀请对局第三人由 AI 补位（★ 且无真实档位名）', /AI ★+/.test(txt2.replace(/\s+/g, ' ')) && !/Random|Tactical|Selfish|3-Ply|MaxN/.test(txt2), txt2.replace(/\s+/g, ' ').slice(0, 130));
    const errs2 = cdp2.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'));
    check('Bob 页面无 JS 错误', errs2.length === 0, `errors=${errs2.length}`);
    // 6c) BAC Victory Timeline（Online Match：服务器广播 · 双端一致 · 实时更新至 R6=C）
    const bacRead = (cdpX) => cdpX.eval(`document.querySelector('.bac-panel')?.innerText || ''`).then((t) => String(t).replace(/\s+/g, ' '));
    let pa = await bacRead(cdp);
    let pb = await bacRead(cdp2);
    check('双端 BAC 面板渲染（ROUND 1 · VICTORY LOCKED · 下次窗口 R6 C）', pa.includes('BAC Victory Timeline') && pb.includes('BAC Victory Timeline') && pa.includes('ROUND 1') && pb.includes('ROUND 1') && pa.includes('VICTORY LOCKED') && pb.includes('VICTORY LOCKED') && pa.includes('Round 6') && pb.includes('Round 6'), (pa + ' | ' + pb).slice(0, 200));
    const t6 = Date.now();
    while (Date.now() - t6 < 45000) {
      pa = await bacRead(cdp);
      pb = await bacRead(cdp2);
      if (pa.includes('CURRENT · ROUND 6') && pb.includes('CURRENT · ROUND 6')) break;
      await cdp.eval(`(() => { const el=document.querySelector('.cell.legal'); if(el) el.click(); return true; })()`);
      await cdp2.eval(`(() => { const el=document.querySelector('.cell.legal'); if(el) el.click(); return true; })()`);
      await sleep(250);
    }
    check('双端实时同步至 R6（资格 C · R7/R8 未来窗口一致）', pa.includes('ROUND 6') && pb.includes('ROUND 6') && pa.includes('Victory Right') && pb.includes('Victory Right') && pa.includes('R7') && pb.includes('R7') && pa.includes('R8') && pb.includes('R8'), (pa + ' | ' + pb).slice(0, 220));
    // 双方离开（服务端中止房间）
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('离开')); if(b) b.click(); return true; })()`);
    await cdp2.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('离开')); if(b) b.click(); return true; })()`);
    await sleep(700);
    cdp2.close();
  } else {
    check('第二个浏览器可用', false, 'no wsUrl2');
  }
  proc2.kill();

  // 7) 本地对局（#/local）渲染并走一手
  await goto('/local');
  await sleep(600);
  const cells = await cdp.eval(`document.querySelectorAll('.board .cell').length`);
  check('Local Match 渲染 13×13 棋盘', cells === 169, `cells=${cells}`);
  const legalClick = await cdp.eval(`(() => { const el=document.querySelector('.cell.legal'); if(!el) return false; el.click(); return true; })()`);
  await sleep(300);
  const st = await cdp.eval(`(() => {
    const sb=document.querySelector('.statusbar'); const mh=document.querySelector('.history-list');
    return { sb: sb?sb.innerText.replace(/\\s+/g,' ').slice(0,90):'', hist: mh?mh.innerText.length:0 };
  })()`);
  check('本地落子生效（日志出现记录）', legalClick === true && st.hist > 10, JSON.stringify(st).slice(0, 140));

  // 8) 在线排队（教学已完成用户）
  await goto('/online');
  await sleep(1000);
  txt = await bodyText();
  check('在线排队界面显示（Searching players + 倒计时）', txt.includes('Searching players') && txt.includes('正在寻找对手') && /\d+s/.test(txt), txt.slice(0, 150));
  await click('button', '取消并返回');
  await sleep(400);

  // 9) console 无错误
  const jsErrors = cdp.events.filter(
    (e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'),
  );
  check('无页面 JS 错误/异常', jsErrors.length === 0, `errors=${jsErrors.length}`);
  if (jsErrors.length) console.log(JSON.stringify(jsErrors.slice(0, 2), null, 2).slice(0, 800));

  cdp.close();
  proc.kill();
  console.log(failures === 0 ? '\nPLATFORM E2E: ALL PASS' : `\nPLATFORM E2E: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('E2E 错误:', e.message); process.exit(1); });
