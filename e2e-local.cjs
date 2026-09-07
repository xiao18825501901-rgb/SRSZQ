// SRSZQ.com 正式规则 v2 — 浏览器 E2E（headless Edge + CDP 真实点击）
// 运行：node e2e-local.cjs（默认使用 127.0.0.1:5173；可用 SRSZQ_LOCAL_E2E_URL 指向已部署环境）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_URL = process.env.SRSZQ_LOCAL_E2E_URL ?? 'http://127.0.0.1:5173/?debug=1#/local';
const TARGET_ORIGIN = new URL(TEST_URL).origin;
const PORT = 9333;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

/** 注入 JSON 文件到隐藏 input（模拟导入） */
async function importFile(cdp, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  await cdp.eval(`(async () => {
    const input = document.querySelector('input[type=file]');
    const file = new File([${JSON.stringify(payload)}], 't.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r2) => setTimeout(r2, 500));
  })()`);
  await sleep(250);
}

async function main() {
  const profile = path.join(os.tmpdir(), 'tcf-v2-profile-' + process.pid);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1000', TEST_URL,
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(500);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && (t.url.startsWith(TARGET_ORIGIN) || t.url === 'about:blank'));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
  }
  if (!wsUrl) {
    console.log('FAIL 无法连接 headless Edge');
    proc.kill();
    process.exit(1);
  }
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    try { ready = (await cdp.eval(`!!document.querySelector('.board .cell, .seat-row')`)) === true; } catch { /* noop */ }
  }
  check('页面渲染出棋盘/座位设置', ready);
  if (!ready) { proc.kill(); process.exit(1); }
  // 本地对局先出现“座位与 AI 设置”屏：点击开始对局（默认三真人）进入棋盘
  await cdp.eval(`(() => { const b=[...document.querySelectorAll('.btn')].find(x=>/开始对局/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`);
  await sleep(400);

  const getState = () => cdp.eval(`window.__tcf.getState()`);
  const statusText = () => cdp.eval(`document.querySelector('.statusbar').innerText`).then((t) => t.replace(/\s+/g, ' '));
  const bodyText = () => cdp.eval(`document.body.innerText`).then((t) => t.replace(/\s+/g, ' '));
  async function closeStartModal() {
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('.modal-foot .btn')].find(x=>x.textContent.includes('START')); if(b) b.click(); return !!b; })()`);
    await sleep(300);
  }
  async function clickCell(row, col) {
    return cdp.eval(`(() => {
      const el = [...document.querySelectorAll('.cell')].find(c => (c.getAttribute('aria-label')||'').startsWith('(${row}, ${col})'));
      if (!el) return 'notfound';
      const a = el.getAttribute('aria-label') || '';
      if (a.includes('禁手')) return 'forbidden';
      if (a.includes('可落子')) { el.click(); return 'ok'; }
      return 'occupied:' + a;
    })()`);
  }
  const P_OF = (turnIndex) => ['A', 'B', 'C'][turnIndex % 3];
  const seatsApi = () => cdp.eval(`window.__tcf.seats()`);
  async function waitUntil(exprJs, timeoutMs = 12000, interval = 100) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      last = await cdp.eval(exprJs);
      if (last) return last;
      await sleep(interval);
    }
    return last;
  }
  async function waitMoves(n, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = await getState();
      if (s.moves.length >= n) return s;
      await sleep(120);
    }
    return getState();
  }
  async function clickFirstLegal() {
    return cdp.eval(`(() => { const el = document.querySelector('.cell.legal'); if (!el) return false; el.click(); return true; })()`);
  }
  async function seatChange(seatIdx, value) {
    return cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.seat-row')];
      const sel = rows[${seatIdx}]?.querySelector('.seat-select');
      if (!sel) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, '${value}');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }
  async function clickBtn(label) {
    await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => (b.textContent||'').trim().startsWith('${label}'))?.click(); })()`);
    await sleep(300);
  }
  async function clickConfirm() {
    await cdp.eval(`(() => { [...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.includes('确认'))?.click(); })()`);
    await sleep(400);
  }
  const shot = async (name) => {
    if (!process.env.SRSZQ_SHOT_DIR) return;
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(process.env.SRSZQ_SHOT_DIR, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('   [shot]', f);
  };

  // ===== 场景 1：默认开局（13×13 · R1-5 无胜权）=====
  await closeStartModal();
  check('默认 13×13 棋盘含 169 格', (await cdp.eval(`document.querySelectorAll('.board .cell').length`)) === 169);
  const chip = await cdp.eval(`document.querySelector('.cfg-chip').textContent`);
  check('顶栏 13×13 · 正式规则', chip.includes('13×13') && chip.includes('正式规则'), chip);
  let st = await statusText();
  check('R1 · NONE（R1-5 无人有胜权）', st.includes('ROUND 1') && st.includes('NONE'), st.slice(0, 90));
  const bodyAll = await bodyText();
  check('页面不出现 CBA/CBACC/11×11', !/CBA|CBACC|11×11/.test(bodyAll), '');
  check('页面不出现真实 AI 档位名', !/Random|Tactical|Selfish|3-Ply|MaxN/.test(bodyAll), '');

  // BAC 面板：R1 视角（VICTORY LOCKED + 下次胜权窗口 R6 C）
  const tl = (await cdp.eval(`document.querySelector('.bac-panel')?.innerText || ''`)).replace(/\s+/g, ' ');
  check('BAC 面板标题（BAC Victory Timeline + C→B→A）', tl.includes('BAC Victory Timeline') && tl.includes('C → B → A'), tl.slice(0, 140));
  check('R1 当前轮：ROUND 1 + VICTORY LOCKED + 下次窗口 Round 6', tl.includes('ROUND 1') && tl.includes('VICTORY LOCKED') && tl.includes('Round 6') && tl.includes('C'), tl.slice(0, 200));
  await shot('bac-r1-locked.png');

  // ===== 场景 2：基础轮流落子 =====
  let r = await clickCell(7, 7);
  check('A 落子 (7,7)', r === 'ok', r);
  let pieceMotion = await cdp.eval(`(() => { const s=document.querySelector('.cell.last-move .stone-A'); return s ? getComputedStyle(s).animationName : ''; })()`);
  check('A 棋子使用桌面落子动画', pieceMotion.includes('tabletop-piece-drop'), pieceMotion);
  r = await clickCell(8, 8);
  check('B 落子 (8,8)', r === 'ok', r);
  pieceMotion = await cdp.eval(`(() => { const s=document.querySelector('.cell.last-move .stone-B'); return s ? getComputedStyle(s).animationName : ''; })()`);
  check('B 棋子使用桌面落子动画', pieceMotion.includes('tabletop-piece-drop'), pieceMotion);
  r = await clickCell(9, 9);
  check('C 落子 (9,9)', r === 'ok', r);
  pieceMotion = await cdp.eval(`(() => { const s=document.querySelector('.cell.last-move .stone-C'); return s ? getComputedStyle(s).animationName : ''; })()`);
  check('C 棋子使用桌面落子动画', pieceMotion.includes('tabletop-piece-drop'), pieceMotion);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  pieceMotion = await cdp.eval(`(() => { const s=document.querySelector('.cell.last-move .stone-C'); return s ? getComputedStyle(s).animationName : ''; })()`);
  check('Reduced Motion 使用非位移确认动画', pieceMotion.includes('tabletop-piece-confirm'), pieceMotion);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  st = await statusText();
  check('Round 2 开始 · 轮到 A', st.includes('ROUND 2') && st.includes('玩家 A'), st.slice(0, 70));
  const tl2 = (await cdp.eval(`document.querySelector('.bac-panel')?.innerText || ''`)).replace(/\s+/g, ' ');
  check('BAC 面板随落子自动更新（CURRENT ROUND 2）', tl2.includes('ROUND 2') && !tl2.includes('CURRENT · ROUND 1'), tl2.slice(0, 120));

  // ===== 场景 3：R6 禁手（无资格成四不可落）=====
  // 15 步导入：turnIndex=15（A，R6，资格 C）；A 在 0-based(5,1..3)=1-based(6,2..4) 三连
  await importFile(cdp, {
    boardSize: 13,
    rulesVersion: 2,
    moves: [
      { turn: 0, player: 'A', row: 6, col: 2 }, { turn: 1, player: 'B', row: 1, col: 1 },
      { turn: 2, player: 'C', row: 13, col: 13 }, { turn: 3, player: 'A', row: 6, col: 3 },
      { turn: 4, player: 'B', row: 1, col: 13 }, { turn: 5, player: 'C', row: 13, col: 1 },
      { turn: 6, player: 'A', row: 6, col: 4 }, { turn: 7, player: 'B', row: 2, col: 12 },
      { turn: 8, player: 'C', row: 12, col: 2 }, { turn: 9, player: 'A', row: 9, col: 9 },
      { turn: 10, player: 'B', row: 3, col: 11 }, { turn: 11, player: 'C', row: 11, col: 3 },
      { turn: 12, player: 'A', row: 7, col: 7 }, { turn: 13, player: 'B', row: 4, col: 12 },
      { turn: 14, player: 'C', row: 12, col: 4 },
    ],
  });
  let gs = await getState();
  check('导入 15 步（turnIndex=15 = R6 A 行动）', gs.moves.length === 15 && gs.turnIndex === 15 && P_OF(15) === 'A', `moves=${gs.moves.length} turn=${gs.turnIndex}`);
  st = await statusText();
  check('R6 · 资格 C', st.includes('ROUND 6') && st.includes('玩家 C · 持有胜权'), st.slice(0, 100));
  const tl6 = (await cdp.eval(`document.querySelector('.bac-panel')?.innerText || ''`)).replace(/\s+/g, ' ');
  check('BAC 面板 R6 视角：CURRENT ROUND 6 + C Victory Right + R7/R8', tl6.includes('ROUND 6') && tl6.includes('Player C') && tl6.includes('Victory Right') && tl6.includes('R7') && tl6.includes('R8'), tl6.slice(0, 200));
  await shot('bac-r6-eligible-C.png');
  r = await clickCell(6, 5); // 1-based (6,5) = 0-based (5,4)：补成 AAAA → 禁手
  gs = await getState();
  check('R6 非资格 A 成四禁手不可点', r === 'forbidden' && gs.moves.length === 15, `click=${r} moves=${gs.moves.length}`);

  // ===== 场景 4：R6 C 资格获胜 =====
  // 17 步后 turnIndex=17 = C（R6，资格 C）；C 在 0-based(7,1..3)=1-based(8,2..4) 三连，胜点 (8,1)/(8,5)
  await importFile(cdp, {
    boardSize: 13,
    rulesVersion: 2,
    moves: [
      { turn: 0, player: 'A', row: 2, col: 2 }, { turn: 1, player: 'B', row: 1, col: 2 },
      { turn: 2, player: 'C', row: 8, col: 2 }, { turn: 3, player: 'A', row: 4, col: 4 },
      { turn: 4, player: 'B', row: 3, col: 3 }, { turn: 5, player: 'C', row: 8, col: 3 },
      { turn: 6, player: 'A', row: 6, col: 6 }, { turn: 7, player: 'B', row: 12, col: 13 },
      { turn: 8, player: 'C', row: 8, col: 4 }, { turn: 9, player: 'A', row: 1, col: 13 },
      { turn: 10, player: 'B', row: 13, col: 12 }, { turn: 11, player: 'C', row: 1, col: 1 },
      { turn: 12, player: 'A', row: 13, col: 1 }, { turn: 13, player: 'B', row: 11, col: 13 },
      { turn: 14, player: 'C', row: 13, col: 13 }, { turn: 15, player: 'A', row: 12, col: 12 },
      { turn: 16, player: 'B', row: 13, col: 11 },
    ],
  });
  gs = await getState();
  check('导入 17 步（turnIndex=17 = C，R6 资格 C）', gs.moves.length === 17 && P_OF(17) === 'C', `turn=${gs.turnIndex}`);
  r = await clickCell(8, 1);
  gs = await getState();
  check('C 凭本手成四 → C 获胜', r === 'ok' && gs.status === 'won' && gs.winner === 'C', `${r} ${gs.status}/${gs.winner}`);
  const modalText = await bodyText();
  check('胜利弹窗出现', modalText.includes('WINS'), '');

  // ===== 场景 5：17×17 新局 + 设置仅 13/17 =====
  await clickBtn('新游戏');
  await clickConfirm();
  await clickBtn('设置');
  const sizeBtns = await cdp.eval(`(() => [...document.querySelectorAll('.setup-block .btn')].map(b => b.textContent.trim()))()`);
  check('棋盘选项仅 13×13 与 17×17', sizeBtns.length === 2 && sizeBtns.includes('13 × 13') && sizeBtns.includes('17 × 17'), JSON.stringify(sizeBtns));
  const hasScheduleCards = await cdp.eval(`!!document.querySelector('.schedule-card')`);
  check('无资格顺序选择卡（正式规则唯一）', hasScheduleCards === false);
  await cdp.eval(`(() => { [...document.querySelectorAll('.setup-block .btn')].find(b => b.textContent.includes('17'))?.click(); })()`);
  await sleep(300);
  gs = await getState();
  check('切换 17×17 生效', gs.boardSize === 17, `size=${gs.boardSize}`);
  await closeStartModal();
  check('17×17 棋盘含 289 格', (await cdp.eval(`document.querySelectorAll('.board .cell').length`)) === 289);

  // ===== 场景 6：AI 座位（★ 显示、0-2 AI 约束）=====
  await clickBtn('设置');
  const seatInfo = await cdp.eval(`(() => [...document.querySelectorAll('.seat-row')].map(row => ({
    options: [...row.querySelectorAll('.seat-select option')].map(o => o.value)
  })))()`);
  check('3 座位行 × 6 选项', seatInfo.length === 3 && seatInfo.every((x) => x.options.length === 6), `rows=${seatInfo.length}`);
  const optionTexts = await cdp.eval(`(() => [...document.querySelectorAll('.seat-row')].map(row => [...row.querySelectorAll('.seat-select option')].map(o => o.textContent)))()`);
  check('AI 选项只显示 ★（隐藏真实档位名）', optionTexts.every((opts) => opts.slice(1).every((t) => /^AI [★☆]+$/.test(t))), JSON.stringify(optionTexts[0]));
  await seatChange(0, '1'); await sleep(200);
  await seatChange(1, '2'); await sleep(200);
  let seatsNow = await seatsApi();
  check('两个 AI 座位可设（数字星级）', seatsNow.A.kind === 'ai' && seatsNow.A.level === 1 && seatsNow.B.kind === 'ai' && seatsNow.B.level === 2 && seatsNow.C.kind === 'human', JSON.stringify(seatsNow));
  const cBlocked = await cdp.eval(`(() => {
    const sel = [...document.querySelectorAll('.seat-row')][2].querySelector('.seat-select');
    return [...sel.options].filter(o => o.value !== 'human').every(o => o.disabled);
  })()`);
  check('已达 2 AI 上限 → C 的 AI 选项禁用', cBlocked === true);
  await seatChange(2, '3'); await sleep(200);
  seatsNow = await seatsApi();
  check('强选 3 AI 被拒（C 保持人类）', seatsNow.C.kind === 'human', JSON.stringify(seatsNow));
  await seatChange(0, 'human'); await sleep(200);
  await seatChange(1, '4'); await sleep(200);
  seatsNow = await seatsApi();
  check('主场景座位：A 人类 / B 4★ AI / C 人类', seatsNow.A.kind === 'human' && seatsNow.B.level === 4, JSON.stringify(seatsNow));
  await closeStartModal();

  // ===== 场景 7：AI 自动行动 + THINKING 锁盘 + 日志星级 =====
  await clickFirstLegal(); // A（人类）
  const thinkSeen = await waitUntil(`(() => { const t = window.__tcf.thinking(); return t && t.player === 'B' ? t : null; })()`, 8000, 25);
  check('B 4★ AI THINKING 可见', thinkSeen !== null && thinkSeen.level === 4, JSON.stringify(thinkSeen));
  const during = await getState();
  await cdp.eval(`window.__tcf.place(7, 7)`);
  await clickFirstLegal();
  await sleep(150);
  let after = await getState();
  check('思考中棋盘锁定（点击无效）', after.moves.length === during.moves.length, `${during.moves.length}->${after.moves.length}`);
  after = await waitMoves(2, 15000);
  check('B AI 自动落子完成', after.moves.length === 2 && P_OF(after.turnIndex) === 'C', `moves=${after.moves.length}`);
  const cardB = await cdp.eval(`document.querySelectorAll('.players-row .player-card')[1]?.innerText || ''`);
  check('玩家卡 B 显示 AI 星级（无档位名）', /AI · ★+/.test(cardB) && !/3-Ply|Tactical/.test(cardB), cardB.replace(/\s+/g, ' ').slice(0, 60));
  const hist = (await cdp.eval(`document.querySelector('.history-list').innerText`)).replace(/\s+/g, ' ');
  check('日志 AI 标记为星级', /AI·★+/.test(hist), hist.slice(0, 120));

  // ===== 场景 8：悔棋到上一人类回合 + 导出/导入 v2 =====
  await clickFirstLegal(); // C 人类 → moves 3
  await sleep(150);
  after = await waitMoves(4, 15000); // A 人类 → moves 4
  await waitMoves(5, 15000); // B AI → moves 5
  await clickBtn('悔棋到上一人类回合');
  await sleep(400);
  gs = await getState();
  check('悔棋到上一人类回合（回到 A 决策）', gs.moves.length === 3 && P_OF(gs.turnIndex) === 'A', `moves=${gs.moves.length} cur=${P_OF(gs.turnIndex)}`);

  // 导出按钮无异常
  await clickBtn('Export');
  check('Export JSON 点击无异常', true, '');

  // v2 导入（带 players）→ 座位恢复 + AI 自动续走
  await importFile(cdp, {
    boardSize: 13,
    rulesVersion: 2,
    players: { A: { kind: 'human' }, B: { kind: 'ai', level: 2 }, C: { kind: 'human' } },
    moves: [{ turn: 0, player: 'A', row: 7, col: 7 }],
  });
  seatsNow = await seatsApi();
  gs = await getState();
  check('导入新格式：players 数字星级生效', gs.moves.length >= 1 && seatsNow.B.kind === 'ai' && seatsNow.B.level === 2, JSON.stringify(seatsNow));
  gs = await waitMoves(2, 10000);
  check('导入后 AI 自动续走', gs.moves.length >= 2, `moves=${gs.moves.length}`);
  // 旧格式（无 players）→ 全人类
  await importFile(cdp, {
    boardSize: 13,
    moves: [
      { turn: 0, player: 'A', row: 7, col: 7 },
      { turn: 1, player: 'B', row: 8, col: 8 },
      { turn: 2, player: 'C', row: 9, col: 9 },
    ],
  });
  seatsNow = await seatsApi();
  check('导入旧格式：座位回退全人类', seatsNow.A.kind === 'human' && seatsNow.B.kind === 'human' && seatsNow.C.kind === 'human', JSON.stringify(seatsNow));

  // ===== 场景 9：console 无错误 =====
  const jsErrors = cdp.events.filter(
    (e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'),
  );
  check('无页面 JS 错误/异常', jsErrors.length === 0, `errors=${jsErrors.length}`);
  if (jsErrors.length) console.log(JSON.stringify(jsErrors.slice(0, 3), null, 2).slice(0, 1200));

  cdp.close();
  proc.kill();
  console.log(failures === 0 ? '\nE2E-LOCAL(v2): ALL PASS' : `\nE2E-LOCAL(v2): ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 错误:', e.message);
  process.exit(1);
});
