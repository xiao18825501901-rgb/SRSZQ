// 三人四子棋 E2E：通过 CDP 驱动 headless Edge，真实点击 DOM 验证 UI 与规则联动
// 运行：node e2e.cjs  （要求 dev server 已在 127.0.0.1:5173 运行）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL = 'http://127.0.0.1:5173/?debug=1';
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

async function main() {
  const profile = path.join(os.tmpdir(), 'tcf-e2e-profile-' + process.pid);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  const proc = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1600,1000',
    URL,
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(500);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && (t.url.includes('5173') || t.url === 'about:blank'));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
  }
  if (!wsUrl) {
    console.log('FAIL 无法连接到 headless Edge（端口 ' + PORT + '）');
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
    try {
      ready = (await cdp.eval(`!!document.querySelector('.board .cell')`)) === true;
    } catch { /* noop */ }
  }
  check('页面渲染出棋盘', ready);
  if (!ready) {
    console.log(await cdp.eval(`document.body ? document.body.innerText.slice(0, 400) : 'none'`));
    proc.kill();
    process.exit(1);
  }

  // 工具：读取状态 / 关弹窗 / 点击格子 / 等待状态刷新
  const getState = () => cdp.eval(`window.__tcf.getState()`);
  const statusText = () => cdp.eval(`document.querySelector('.statusbar').innerText`).then((t) => t.replace(/\s+/g, ' '));
  async function closeStartModal() {
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('.modal-foot .btn')].find(x=>x.textContent.includes('START')); if(b) b.click(); return !!b; })()`);
    await sleep(350);
  }
  async function clickCell(row, col) {
    const r = await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('.cell')].find(c => (c.getAttribute('aria-label')||'').startsWith('(${row}, ${col})'));
      if (!el) return 'notfound';
      const a = el.getAttribute('aria-label') || '';
      if (a.includes('禁手')) return 'forbidden';
      if (a.includes('可落子')) { el.click(); return 'ok'; }
      return 'occupied:' + a;
    })()`);
    await sleep(80);
    return r;
  }
  async function placeViaTcf(row, col) {
    const before = await getState();
    await cdp.eval(`window.__tcf.place(${row}, ${col})`);
    await sleep(120);
    const after = await getState();
    return { ok: after.moves.length === before.moves.length + 1, before: before.moves.length, after: after.moves.length, st: after.status };
  }

  // ===== SRSZQ AI 测试辅助 =====
  const P_OF = (turnIndex) => ['A', 'B', 'C'][turnIndex % 3];
  const seatsApi = () => cdp.eval(`window.__tcf.seats()`);
  const thinkingApi = () => cdp.eval(`window.__tcf.thinking()`);
  async function waitUntil(exprJs, timeoutMs = 12000, interval = 120) {
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
  /** 修改第 seatIdx 个座位下拉（0=A,1=B,2=C），走 React 受控原生 setter */
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
  async function clickSetupBtn(label) {
    await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => (b.textContent||'').trim().startsWith('${label}'))?.click(); })()`);
    await sleep(350);
  }
  async function clickConfirmModal() {
    await cdp.eval(`(() => { [...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.includes('确认'))?.click(); })()`);
    await sleep(450);
  }

  // ========== 场景 1：默认设置与基础落子 ==========
  await closeStartModal();
  check('11×11 棋盘含 121 格', (await cdp.eval(`document.querySelectorAll('.board .cell').length`)) === 121);
  const chip = await cdp.eval(`document.querySelector('.cfg-chip').textContent`);
  check('顶栏显示 11×11 · CBA', chip.includes('11×11') && chip.includes('CBA'), chip);

  let st = await statusText();
  check('初始 Round 1 · 无胜权', st.includes('ROUND 1') && st.includes('玩家 A') && st.includes('NONE'), st.slice(0, 90));

  let r = await clickCell(6, 6);
  check('A 落子 (6,6)', r === 'ok', r);
  st = await statusText();
  check('轮到 B（Round 1）', st.includes('玩家 B'), st.slice(0, 70));
  r = await clickCell(7, 7);
  check('B 落子 (7,7)', r === 'ok', r);
  r = await clickCell(8, 8);
  check('C 落子 (8,8)', r === 'ok', r);
  st = await statusText();
  check('Round 2 开始 · 轮到 A', st.includes('ROUND 2') && st.includes('玩家 A'), st.slice(0, 70));
  const logText = (await cdp.eval(`document.querySelector('.history-list').innerText`)).replace(/\s+/g, ' ');
  check('日志含 Turn 1 — A → (6, 6)', logText.includes('Turn 1 — A → (6, 6)'), logText.slice(0, 60));
  const dots = await cdp.eval(`document.querySelectorAll('.legal-dot').length`);
  check('合法点可视化（剩余空格数）', dots === 121 - 3, `dots=${dots}`);

  // ========== 场景 2：导入构造禁手与胜局 ==========
  const moves = [
    { turn: 0, round: 1, player: 'A', row: 6, col: 2 },
    { turn: 1, round: 1, player: 'B', row: 9, col: 9 },
    { turn: 2, round: 1, player: 'C', row: 1, col: 2 },
    { turn: 3, round: 2, player: 'A', row: 6, col: 3 },
    { turn: 4, round: 2, player: 'B', row: 8, col: 5 },
    { turn: 5, round: 2, player: 'C', row: 1, col: 3 },
    { turn: 6, round: 3, player: 'A', row: 6, col: 4 },
    { turn: 7, round: 3, player: 'B', row: 5, col: 8 },
    { turn: 8, round: 3, player: 'C', row: 1, col: 4 },
  ];
  const payload = JSON.stringify({ boardSize: 11, schedule: 'CBA', moves });
  await cdp.eval(`(async () => {
    const input = document.querySelector('input[type=file]');
    const file = new File([${JSON.stringify(payload)}], 'test.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 600));
  })()`);
  await sleep(300);
  let gs = await getState();
  check('导入 9 步棋局成功（CBA 11×11）', gs.moves.length === 9 && gs.schedule === 'CBA' && gs.boardSize === 11, JSON.stringify({ m: gs.moves.length, s: gs.schedule, b: gs.boardSize }));
  st = await statusText();
  check('导入后 R4 · A 行动 · 胜权 C', st.includes('ROUND 4') && st.includes('玩家 A') && st.includes('🏆 玩家 C'), st.slice(0, 100));

  // 禁手：A 点击 (6,5)（会形成 A 四连）
  r = await clickCell(6, 5);
  gs = await getState();
  check('非资格 A 在 (6,5) 成四 → 禁手不可点', r === 'forbidden' && gs.moves.length === 9, `click=${r} moves=${gs.moves.length}`);
  const rej = await placeViaTcf(6, 5);
  check('引擎拒绝禁手落子', rej.ok === false && rej.after === 9, JSON.stringify(rej));

  // A(6,6) 合法；B(5,5) 合法；C(1,5) 持胜权成四获胜
  const a1 = await placeViaTcf(6, 6);
  check('A 走 (6,6) 合法', a1.ok && a1.after === 10, JSON.stringify(a1));
  const b1 = await placeViaTcf(5, 5);
  check('B 走 (5,5) 合法', b1.ok && b1.after === 11, JSON.stringify(b1));
  st = await statusText();
  check('轮到 C 且持胜权', st.includes('玩家 C') && st.includes('🏆'), st.slice(0, 90));
  const c1 = await placeViaTcf(1, 5);
  gs = await getState();
  check('C 落 (1,5) 形成四连 → C 获胜', gs.status === 'won' && gs.winner === 'C' && gs.winLine?.length >= 4, JSON.stringify({ ok: c1.ok, status: gs.status, winner: gs.winner, line: gs.winLine?.length }));
  const winCells = await cdp.eval(`document.querySelectorAll('.cell.win-cell').length`);
  check('获胜棋子高亮（≥4）', winCells >= 4, `win-cells=${winCells}`);
  const modalText = await cdp.eval(`document.body.innerText`);
  check('胜利弹窗出现', modalText.includes('WINS') || modalText.includes('获胜'), '');

  await cdp.eval(`window.__tcf.undo()`);
  await sleep(120);
  gs = await getState();
  check('撤销获胜步 → 回到 playing', gs.status === 'playing' && gs.winner === null && gs.moves.length === 11, JSON.stringify({ st: gs.status, m: gs.moves.length }));

  // ========== 场景 3：新游戏 + 13×13 + BAC + CBACC ==========
  await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === '新游戏')?.click(); })()`);
  await sleep(250);
  await cdp.eval(`(() => { [...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.includes('确认'))?.click(); })()`);
  await sleep(400);
  gs = await getState();
  check('新游戏后清空', gs.moves.length === 0 && gs.status === 'playing' && gs.boardSize === 11 && gs.schedule === 'CBA');

  // 设置：13×13 + BAC
  await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === '设置')?.click(); })()`);
  await sleep(400);
  await cdp.eval(`(() => { [...document.querySelectorAll('.schedule-card')].find(b => (b.querySelector('strong')?.textContent || '').trim() === 'BAC')?.click(); })()`);
  await sleep(250);
  await cdp.eval(`(() => { [...document.querySelectorAll('.setup-block .btn')].find(b => b.textContent.includes('13'))?.click(); })()`);
  await sleep(250);
  await closeStartModal();
  gs = await getState();
  check('设置切换为 13×13 · BAC', gs.boardSize === 13 && gs.schedule === 'BAC', `${gs.boardSize}x${gs.boardSize} · ${gs.schedule}`);
  const tlText1 = (await cdp.eval(`document.querySelector('.timeline').innerText`)).replace(/\s+/g, ' ');
  check('BAC 时间轴 R4 B', /R4\s*B/.test(tlText1), tlText1.slice(0, 100));

  // 用 DOM 点击走完 9 步进入 R4（A 行动，胜权 B）——验证 BAC R4 = B
  for (let i = 0; i < 9; i++) {
    const ok = await cdp.eval(`(() => {
      const el = document.querySelector('.cell.legal');
      if (!el) return false;
      el.click(); return true;
    })()`);
    if (!ok) break;
    await sleep(60);
  }
  st = await statusText();
  check('BAC：9 步后 R4 · A 行动 · 胜权 🏆 B', st.includes('ROUND 4') && st.includes('🏆 玩家 B'), st.slice(0, 110));

  // 切 CBACC：游戏已有落子 → 应弹出「修改规则将开始新游戏」确认框（顺带验证此流程）
  await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === '设置')?.click(); })()`);
  await sleep(400);
  await cdp.eval(`(() => { [...document.querySelectorAll('.schedule-card')].find(b => (b.querySelector('strong')?.textContent || '').trim() === 'CBACC')?.click(); })()`);
  await sleep(300);
  const confirmShown = await cdp.eval(`document.body.innerText.includes('修改设置将开始新游戏')`);
  check('改规则需确认弹窗', confirmShown === true);
  await cdp.eval(`(() => { [...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.includes('确认'))?.click(); })()`);
  await sleep(400);
  gs = await getState();
  check('切换 CBACC 成功（新局）', gs.schedule === 'CBACC' && gs.moves.length === 0, `${gs.schedule} moves=${gs.moves.length}`);
  const tlText2 = (await cdp.eval(`document.querySelector('.timeline').innerText`)).replace(/\s+/g, ' ');
  check('CBACC 时间轴 R4C R5B R6A', /R4\s*C/.test(tlText2) && /R5\s*B/.test(tlText2) && /R6\s*A/.test(tlText2), tlText2.slice(0, 130));

  // 推进到 R7（第 19 步 = turnIndex 18）观察时间轴：R7/R8 连续 C（周期边界）
  // 每步点击第一个合法格
  for (let i = 0; i < 18; i++) {
    const ok = await cdp.eval(`(() => { const el = document.querySelector('.cell.legal'); if (!el) return false; el.click(); return true; })()`);
    if (!ok) break;
    await sleep(50);
  }
  st = await statusText();
  const tlText3 = (await cdp.eval(`document.querySelector('.timeline').innerText`)).replace(/\s+/g, ' ');
  check('CBACC R7 胜权为 C（连续 C 边界）', /R7\s*C/.test(tlText3) && /R8\s*C/.test(tlText3), `status=${st.slice(0, 60)} tl=${tlText3.slice(0, 160)}`);

  // ========== 场景 4：UI 控制与终局兜底 ==========
  const ctrlText = await cdp.eval(`document.querySelector('.controls').innerText`);
  check('控制区含 悔棋/导出/导入', ctrlText.includes('悔棋') && ctrlText.includes('Export') && ctrlText.includes('Import'));
  await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => b.textContent.includes('悔棋'))?.click(); })()`);
  await sleep(200);
  gs = await getState();
  check('悔棋按钮生效', gs.moves.length === 17, `moves=${gs.moves.length}`);

  // 导出按钮触发下载（验证不抛错）
  await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => b.textContent.includes('Export'))?.click(); })()`);
  await sleep(300);
  check('Export JSON 点击无异常', true, '');

  // ========== 场景 5：SRSZQ AI — BAC 座位选择（每座位 6 选项 / 约束） ==========
  // 当前在 CBACC 13×13（有落子）→ 改 BAC 需确认；随后改 11×11（空局即时生效）
  await clickSetupBtn('设置');
  await cdp.eval(`(() => { [...document.querySelectorAll('.schedule-card')].find(b => (b.querySelector('strong')?.textContent || '').trim() === 'BAC')?.click(); })()`);
  await sleep(300);
  let confirmShown5 = await cdp.eval(`document.body.innerText.includes('修改设置将开始新游戏')`);
  check('BAC 切换（有落子）弹确认框', confirmShown5 === true);
  await clickConfirmModal();
  gs = await getState();
  check('确认后新局 BAC', gs.schedule === 'BAC' && gs.moves.length === 0, `${gs.schedule} moves=${gs.moves.length}`);
  await clickSetupBtn('设置');
  await cdp.eval(`(() => { [...document.querySelectorAll('.setup-block .btn')].find(b => b.textContent.includes('11'))?.click(); })()`);
  await sleep(300);
  gs = await getState();
  check('改 11×11 即时生效（空局）', gs.boardSize === 11, `size=${gs.boardSize}`);

  // 座位行出现：每座位一个 select，含 6 选项（人类 + 5 档 AI）
  const seatInfo = await cdp.eval(`(() => [...document.querySelectorAll('.seat-row')].map(row => ({
    text: row.querySelector('.seat-name')?.textContent || '',
    options: [...row.querySelectorAll('.seat-select option')].map(o => o.value)
  })))()`);
  check('出现 3 个座位行（BAC）', seatInfo.length === 3, `rows=${seatInfo.length}`);
  check(
    '每座位 6 个选项（人类+Random/Tactical/Selfish/3-Ply/MaxN）',
    seatInfo.every((r) => r.options.length === 6 && r.options[0] === 'human' && r.options.includes('random') && r.options.includes('tactical') && r.options.includes('selfish') && r.options.includes('3ply') && r.options.includes('maxn')),
    JSON.stringify(seatInfo[0]?.options),
  );

  // 两个 AI 后，第三个座位的 AI 选项应禁用；强选 3 AI 应被拒绝
  await seatChange(0, 'random'); await sleep(250);
  await seatChange(1, 'tactical'); await sleep(250);
  let seatsNow = await seatsApi();
  check('A=AI·random, B=AI·tactical 设置生效', seatsNow.A.kind === 'ai' && seatsNow.A.level === 'random' && seatsNow.B.kind === 'ai' && seatsNow.B.level === 'tactical' && seatsNow.C.kind === 'human', JSON.stringify(seatsNow));
  const cBlocked = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.seat-row')];
    const sel = rows[2]?.querySelector('.seat-select');
    const aiOpts = [...sel.options].filter(o => o.value !== 'human');
    return { totalDisabled: aiOpts.every(o => o.disabled), selDisabled: sel.disabled };
  })()`);
  check('已达 2 AI 上限 → C 的 AI 选项禁用', cBlocked.totalDisabled === true, JSON.stringify(cBlocked));
  await seatChange(2, 'selfish'); await sleep(250);
  seatsNow = await seatsApi();
  check('强选 3 AI 被拒绝（C 保持人类）', seatsNow.C.kind === 'human', JSON.stringify(seatsNow));
  // 改回 A=人类 → B=3-Ply 单 AI（后续主场景）
  await seatChange(0, 'human'); await sleep(250);
  await seatChange(1, '3ply'); await sleep(250);
  seatsNow = await seatsApi();
  check('主场景座位：A 人类 / B AI·3-Ply / C 人类', seatsNow.A.kind === 'human' && seatsNow.B.kind === 'ai' && seatsNow.B.level === '3ply' && seatsNow.C.kind === 'human', JSON.stringify(seatsNow));
  await closeStartModal();
  gs = await getState();
  check('开局 BAC 11×11 · 座位保留', gs.schedule === 'BAC' && gs.moves.length === 0 && gs.boardSize === 11);

  // ========== 场景 6：AI 自动行动 + THINKING 锁盘 + 历史标记 ==========
  // A 人类先手
  let clicked = await clickFirstLegal();
  check('A（人类）落子', clicked === true);
  // B（AI 3-Ply）自动思考并落子
  const thinkSeen = await waitUntil(`(() => { const t = window.__tcf.thinking(); return t && t.player === 'B' ? t : null; })()`, 8000, 25);
  check('B AI 思考中状态可见（THINKING）', thinkSeen !== null && thinkSeen.level === '3ply', JSON.stringify(thinkSeen));
  const thinkingUi = await cdp.eval(`(() => {
    const notice = document.querySelector('.notice.ai-thinking');
    const status = document.querySelector('.statusbar');
    return { notice: notice ? notice.textContent : '', status: status ? status.textContent : '' };
  })()`);
  check('THINKING 状态栏/提示条可见', thinkingUi.status.includes('AI 思考中') || thinkingUi.notice.includes('AI 思考中'), JSON.stringify(thinkingUi).slice(0, 160));
  // 思考期间棋盘锁定：Tcf place + DOM 点击均不应产生新记录（B 的 minDisplay≥450ms，窗口充足）
  const sDuring = await getState();
  await cdp.eval(`window.__tcf.place(6, 6)`);
  await clickFirstLegal();
  await sleep(120);
  let sAfter = await getState();
  check('AI 思考中棋盘锁定（点击无效）', sAfter.moves.length === sDuring.moves.length, `during=${sDuring.moves.length} after=${sAfter.moves.length}`);
  sAfter = await waitMoves(2, 15000);
  check('B AI 自动落子完成（moves=2）', sAfter.moves.length === 2, `moves=${sAfter.moves.length}`);
  check('B AI 落子后轮到 C（人类）', P_OF(sAfter.turnIndex) === 'C', `cur=${P_OF(sAfter.turnIndex)}`);
  // AI 记录在日志：座位标签 + 调试统计（depth/nodes/time）
  const histAfterB = (await cdp.eval(`document.querySelector('.history-list').innerText`)).replace(/\s+/g, ' ');
  check('历史含 AI 标记 🤖AI·3-Ply', histAfterB.includes('🤖AI·3-Ply'), histAfterB.slice(0, 120));
  check('历史含调试统计 [d', histAfterB.includes('[d') && /k\d+\]/.test(histAfterB), histAfterB.slice(0, 120));
  const statsB = await cdp.eval(`window.__tcf.aiStats()`);
  check('aiStats 记录 B 的决策统计', statsB.length === 1 && statsB[0].index === 1 && statsB[0].depth >= 1 && statsB[0].nodes > 0 && statsB[0].thinkTimeMs !== null, JSON.stringify(statsB));
  const cardB = await cdp.eval(`document.querySelectorAll('.players-row .player-card')[1]?.innerText || ''`);
  check('玩家卡 B 显示 AI·3-Ply', cardB.includes('AI · 3-Ply'), cardB.replace(/\s+/g, ' ').slice(0, 60));

  // 继续：C 人类 → A 人类 → B AI → C 人类，验证串行 AI
  clicked = await clickFirstLegal(); await sleep(150);
  clicked = (await waitMoves(3)).moves.length === 3 ? await clickFirstLegal() : false;
  await sleep(150);
  let s4 = await waitMoves(4, 15000);
  check('C、A 人类依次落子（moves=4，轮到 B AI）', s4.moves.length === 4 && P_OF(s4.turnIndex) === 'B', `moves=${s4.moves.length}`);
  const s5 = await waitMoves(5, 15000);
  check('B AI 第二次自动落子（moves=5）', s5.moves.length === 5, `moves=${s5.moves.length}`);

  // ========== 场景 7：悔棋到上一人类回合 ==========
  // 记录：0 A(h) 1 B(ai) 2 C(h) 3 A(h) 4 B(ai) → 悔棋应回到 A 重新决策（弹出 A 与 B 两步）
  const undoBtnText = await cdp.eval(`document.querySelector('.controls')?.innerText || ''`);
  check('AI 模式悔棋按钮文案', undoBtnText.includes('悔棋到上一人类回合'), undoBtnText.replace(/\s+/g, ' ').slice(0, 60));
  await cdp.eval(`(() => { [...document.querySelectorAll('.btn')].find(b => b.textContent.includes('悔棋到上一人类回合'))?.click(); })()`);
  await sleep(400);
  gs = await getState();
  check('悔棋到上一人类回合（moves=3 → A 重新决策）', gs.moves.length === 3 && P_OF(gs.turnIndex) === 'A', `moves=${gs.moves.length} cur=${P_OF(gs.turnIndex)}`);
  const histAfterUndoRaw = await cdp.eval(`document.querySelector('.history-list').innerText`);
  const histLines = histAfterUndoRaw.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 0);
  const lastLine = histLines[histLines.length - 1] ?? '';
  check('撤销后末尾记录为人类落子（非 AI）', lastLine.length > 0 && !lastLine.includes('🤖AI'), lastLine.slice(0, 100));

  // ========== 场景 8：中途改座位需确认并重开；新游戏保留座位 ==========
  await clickSetupBtn('设置');
  await seatChange(2, 'maxn'); await sleep(300);
  confirmShown5 = await cdp.eval(`document.body.innerText.includes('修改设置将开始新游戏')`);
  check('中途改 AI 座位弹确认框', confirmShown5 === true);
  await clickConfirmModal();
  gs = await getState();
  seatsNow = await seatsApi();
  check('确认后新局生效（C=MaxN）', gs.moves.length === 0 && seatsNow.C.kind === 'ai' && seatsNow.C.level === 'maxn', JSON.stringify(seatsNow));
  // 新游戏保留座位：走几步后点击 新游戏
  await clickFirstLegal(); await sleep(150);
  await waitMoves(2, 15000); // B 3-Ply 自动
  await waitMoves(3, 20000); // C MaxN 自动（最慢档）
  gs = await getState();
  check('A/B/C 三人连续行动（moves=3）', gs.moves.length === 3, `moves=${gs.moves.length}`);
  await clickSetupBtn('新游戏');
  await clickConfirmModal();
  gs = await getState();
  seatsNow = await seatsApi();
  check('新游戏保留 AI 座位（C=MaxN）', gs.moves.length === 0 && seatsNow.C.level === 'maxn', JSON.stringify(seatsNow));

  // ========== 场景 9：Export/Import 座位与 AI 统计（旧格式兼容） ==========
  await clickSetupBtn('设置');
  await seatChange(1, 'tactical'); await sleep(250); // 仍在空局：即时生效
  await seatChange(2, 'human'); await sleep(250);
  await closeStartModal();
  seatsNow = await seatsApi();
  // A human / B tactical / C human；走一步 A(h) 后让 B(tactical) 自动走
  await clickFirstLegal(); await sleep(150);
  await waitMoves(2, 10000);
  const statsBeforeExport = await cdp.eval(`window.__tcf.aiStats()`);
  check('B AI 产生统计记录', statsBeforeExport.length >= 1, JSON.stringify(statsBeforeExport));
  // 新格式（带 players）导入：B=ai maxn；moves 仅 A 一步 → 导入后 B(maxn) 应自动续走
  const newPayload = JSON.stringify({
    boardSize: 11,
    schedule: 'BAC',
    players: { A: { kind: 'human' }, B: { kind: 'ai', level: 'maxn' }, C: { kind: 'human' } },
    moves: [{ turn: 0, round: 1, player: 'A', row: 6, col: 6 }],
  });
  await cdp.eval(`(async () => {
    const input = document.querySelector('input[type=file]');
    const file = new File([${JSON.stringify(newPayload)}], 'ai.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 600));
  })()`);
  await sleep(300);
  seatsNow = await seatsApi();
  gs = await getState();
  check('导入新格式：players 生效（B=AI·MaxN）', gs.moves.length >= 1 && seatsNow.B.kind === 'ai' && seatsNow.B.level === 'maxn', `${gs.moves.length} ${JSON.stringify(seatsNow)}`);
  gs = await waitMoves(2, 20000);
  check('导入后 AI 自动续走（B MaxN 落子）', gs.moves.length === 2 && P_OF(gs.turnIndex) === 'C', `moves=${gs.moves.length} cur=${P_OF(gs.turnIndex)}`);
  // 旧格式（无 players）导入 → 座位回退全人类
  const oldPayload = JSON.stringify({
    boardSize: 11,
    schedule: 'BAC',
    moves: [
      { turn: 0, round: 1, player: 'A', row: 6, col: 6 },
      { turn: 1, round: 1, player: 'B', row: 7, col: 7 },
      { turn: 2, round: 1, player: 'C', row: 8, col: 8 },
    ],
  });
  await cdp.eval(`(async () => {
    const input = document.querySelector('input[type=file]');
    const file = new File([${JSON.stringify(oldPayload)}], 'old.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 600));
  })()`);
  await sleep(300);
  seatsNow = await seatsApi();
  gs = await getState();
  check('导入旧格式：座位回退全人类', gs.moves.length === 3 && seatsNow.A.kind === 'human' && seatsNow.B.kind === 'human' && seatsNow.C.kind === 'human', JSON.stringify(seatsNow));

  // ========== 场景 10：页面 JS 错误 ==========
  const jsErrors = cdp.events.filter(
    (e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'),
  );
  check('无页面 JS 错误/异常', jsErrors.length === 0, `errors=${jsErrors.length}`);
  if (jsErrors.length) console.log(JSON.stringify(jsErrors.slice(0, 3), null, 2).slice(0, 1200));

  cdp.close();
  proc.kill();
  console.log(failures === 0 ? '\nE2E: ALL PASS' : `\nE2E: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 错误:', e.message);
  process.exit(1);
});
