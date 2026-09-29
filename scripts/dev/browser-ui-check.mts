/**
 * R10：真实浏览器验收（CDP 驱动本机 Edge/Chrome 无头实例，打真实页面）。
 *
 *   npx tsx scripts/dev/browser-ui-check.mts [--site https://srszq.com] [--out <dir>]
 *
 * 这是**真浏览器**：Chromium 内核、真实 DOM、真实 CSS、真实网络请求。断言读的是页面渲染后的 DOM，
 * 截图是浏览器自己渲染出来的 PNG（不是把 HTML 拼成图片）。手机端 390x844、桌面端 1440x900 两种视口。
 *
 * 覆盖：R09（历史/复盘/题库界面 + 手机端「时间线在上、棋盘居中、操作在下」）与 R10（真实截图）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { api, playScriptedTrioGame } from './lib/scriptedGame.mjs';
// 说明：夹具是 .mts，tsx 按 .js 说明符解析（与本仓库其它 TS 源码一致）。

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SITE = argOf('--site', 'https://srszq.com');
const API = argOf('--api', 'https://api.srszq.com');
const WSURL = argOf('--ws', 'wss://api.srszq.com/ws');
const OUT = argOf('--out', 'evidence/browser');
const PORT = Number(argOf('--port', '9333'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- 极简 CDP 客户端 ---------- */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket, private sessionId: string) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const pr = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) pr.reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data ?? '')));
        else pr.resolve(msg.result);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }
  async waitFor(selector: string, timeoutMs = 20000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return true;
      await sleep(150);
    }
    return false;
  }
  async shot(path: string): Promise<{ bytes: number; width: number; height: number }> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(path, buf);
    // PNG 的 IHDR 里就有宽高（第 16-24 字节）。读出来，避免“截图存在但尺寸不对”这种假通过。
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) throw new Error('不是 PNG: ' + path);
    return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
}

async function findBrowser(): Promise<string> {
  for (const b of BROWSERS) if (existsSync(b)) return b;
  throw new Error('没有找到 Edge/Chrome');
}

function launch(bin: string, profile: string): ChildProcess {
  return spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
}

async function waitJson(url: string, timeoutMs = 20000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端点未就绪: ' + url);
}

const LAYOUT_PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }; };
  const board = q('[data-testid="board"]');
  return {
    timeline: rect(q('[data-testid="move-timeline"]')),
    board: rect(board),
    aside: rect(q('.rv-col-aside')),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docWidth: document.documentElement.scrollWidth,
  };
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log('=== 准备真实对局（生产后端） ===');
  const v = await api(API, 'GET', '/api/version');
  const release = v.json?.protocol?.releaseId;
  console.log('  release=' + release + '  site=' + SITE);
  const game = await playScriptedTrioGame({ apiBase: API, wsUrl: WSURL, prefix: 'ui', password: 'Demo-UI-' + Date.now().toString(36) + '!3' });
  ok(game.humanSeats === 3, '三人同房 human=' + game.humanSeats);
  ok(game.ackFail === 0, '20 手全部被接受（ackFail=' + game.ackFail + '）');
  const winner = game.winner;

  console.log('=== 启动真实浏览器 ===');
  const bin = await findBrowser();
  const profile = join(tmpdir(), 'srszq-ui-' + Date.now().toString(36));
  const child = launch(bin, profile);
  const version = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
  console.log('  ' + String(version.Browser).slice(0, 80));
  const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  const cdp = new Cdp(ws, '');
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
  const S = attached.sessionId as string;
  const page = new Cdp(ws, S);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  const consoleErrors: string[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params).slice(0, 200));
  });

  const setViewport = async (width: number, height: number, mobile: boolean): Promise<void> => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  };
  const goto = async (hash: string): Promise<void> => {
    await page.send('Page.navigate', { url: SITE + '/#' + hash });
    await sleep(1200);
  };

  try {
    await setViewport(1440, 900, false);
    // 登录态必须在**文档加载前**写入：应用在挂载时读 localStorage 决定是否已登录。
    // 之前是先加载页面再注入，结果 /#/history 被重定向到登录页（本地自检发现的问题）。
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        'try {',
        `  localStorage.setItem('srszq_token', ${JSON.stringify(winner.token)});`,
        `  localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(winner.user))});`,
        '} catch (e) { /* about:blank 等不透明来源没有 localStorage */ }',
      ].join('\n'),
    });
    await goto('/history');
    const injected = await page.evaluate(`localStorage.getItem('srszq_token') === ${JSON.stringify(winner.token)}`);
    ok(injected === true, '登录态已在文档加载前注入真实浏览器（localStorage）');

    console.log('=== 桌面 1440x900：历史页 ===');
    ok(await page.waitFor('[data-testid="history-page"]'), '历史页渲染成功（url=' + String(await page.evaluate('location.href')) + '）');
    const rows = await page.evaluate(`document.querySelectorAll('[data-testid="history-row"]').length`);
    if (rows === 0) {
      const diag = await page.evaluate(`(async () => {
        const t = localStorage.getItem('srszq_token');
        const r = await fetch(${JSON.stringify(API)} + '/api/history?limit=5', { headers: { Authorization: 'Bearer ' + t } });
        return { status: r.status, body: (await r.text()).slice(0, 400),
          pageErr: document.querySelector('[data-testid="history-error"]')?.textContent ?? null,
          text: document.body.innerText.slice(0, 300) };
      })()`);
      console.log('  DIAG ' + JSON.stringify(diag));
    }
    ok(rows >= 1, '历史列表至少 1 行（实际 ' + rows + '）');
    const total = await page.evaluate(`document.querySelector('[data-testid="history-total"]')?.textContent`);
    ok(typeof total === 'string' && total.includes('共'), '分页信息可见：' + total);
    const layoutDesktop = await page.evaluate(LAYOUT_PROBE);
    const desktopShot = await page.shot(join(OUT, 'desktop-1440x900-history.png'));
    ok(desktopShot.width === 1440 && desktopShot.height === 900, '桌面历史截图 1440x900（实际 ' + desktopShot.width + 'x' + desktopShot.height + '，' + desktopShot.bytes + ' bytes）');

    console.log('=== 桌面：复盘详情 ===');
    await page.evaluate(`document.querySelector('[data-testid="open-replay"]').click()`);
    ok(await page.waitFor('[data-testid="key-moves"]'), '复盘视图渲染成功');
    const keyTypes = await page.evaluate(`Array.from(document.querySelectorAll('[data-testid^="key-move-"]')).map(e => e.getAttribute('data-testid'))`);
    ok(Array.isArray(keyTypes) && keyTypes.length === 3, '关键片段 3 段：' + JSON.stringify(keyTypes));
    const kmText = await page.evaluate(`document.querySelector('[data-testid="key-moves"]')?.textContent ?? ''`);
    ok(/轮/.test(kmText) && !/胜率|必胜|唯一正解|串通|恶意/.test(kmText), '关键片段文案只讲已证明事实（无胜率/必胜/唯一正解）');
    const timelineCount = await page.evaluate(`document.querySelectorAll('[data-testid^="ply-"]').length`);
    ok(timelineCount === 20, '时间线 20 手（实际 ' + timelineCount + '）');
    const keyPlyMarked = await page.evaluate(`document.querySelectorAll('[data-testid^="ply-"][data-key="1"]').length`);
    ok(keyPlyMarked === 3, '时间线上标出了 3 处关键手（实际 ' + keyPlyMarked + '）');
    const replayLayout = await page.evaluate(LAYOUT_PROBE);
    const desktopReplayShot = await page.shot(join(OUT, 'desktop-1440x900-replay.png'));
    ok(desktopReplayShot.width === 1440 && desktopReplayShot.height === 900, '桌面复盘截图 1440x900（实际 ' + desktopReplayShot.width + 'x' + desktopReplayShot.height + '，' + desktopReplayShot.bytes + ' bytes）');
    ok(replayLayout.board && replayLayout.board.width > 300, '桌面棋盘宽度 ' + replayLayout.board?.width + 'px');
    ok(replayLayout.board!.left + replayLayout.board!.width <= replayLayout.aside!.left + 2, '桌面棋盘在侧栏左侧');

    console.log('=== 桌面：题库每日一题 ===');
    await goto('/puzzles');
    ok(await page.waitFor('[data-testid="puzzle-page"]'), '题库页渲染成功');
    const ptype = await page.evaluate(`document.querySelector('[data-testid="puzzle-type"]')?.textContent`);
    ok(typeof ptype === 'string' && ptype.length > 0, '题目类型可见：' + ptype);
    const answersBefore = await page.evaluate(`!!document.querySelector('[data-testid="puzzle-answers"]')`);
    ok(answersBefore === false, '未作答前页面不显示答案');
    const puzzleShot = await page.shot(join(OUT, 'desktop-1440x900-puzzle.png'));
    ok(puzzleShot.width === 1440 && puzzleShot.height === 900, '桌面题库截图 1440x900（实际 ' + puzzleShot.width + 'x' + puzzleShot.height + '，' + puzzleShot.bytes + ' bytes）');

    console.log('=== 手机 390x844：复盘页布局与截图 ===');
    await setViewport(390, 844, true);
    await goto('/history');
    await page.waitFor('[data-testid="history-page"]');
    await page.evaluate(`document.querySelector('[data-testid="open-replay"]').click()`);
    ok(await page.waitFor('[data-testid="key-moves"]'), '手机端复盘视图渲染成功');
    const mobile = await page.evaluate(LAYOUT_PROBE);
    const mobileShot = await page.shot(join(OUT, 'mobile-390x844-replay.png'));
    ok(mobileShot.width === 390 && mobileShot.height === 844, '手机复盘截图 390x844（实际 ' + mobileShot.width + 'x' + mobileShot.height + '，' + mobileShot.bytes + ' bytes）');
    ok(mobile.timeline !== null && mobile.board !== null && mobile.aside !== null, '手机端三块都在');
    ok(mobile.timeline!.top < mobile.board!.top, '手机端：时间线在棋盘上方（' + mobile.timeline!.top + ' < ' + mobile.board!.top + '）');
    ok(mobile.board!.top < mobile.aside!.top, '手机端：棋盘在操作区上方（' + mobile.board!.top + ' < ' + mobile.aside!.top + '）');
    const centered = Math.abs((mobile.board!.left + mobile.board!.width / 2) - mobile.viewport.w / 2) <= 12;
    ok(centered, '手机端棋盘水平居中（棋盘中心 ' + Math.round(mobile.board!.left + mobile.board!.width / 2) + ' vs 视口中心 ' + mobile.viewport.w / 2 + '）');
    ok(mobile.board!.width <= mobile.viewport.w, '手机端棋盘不超出视口（' + mobile.board!.width + ' <= ' + mobile.viewport.w + '）');
    ok(mobile.docWidth <= mobile.viewport.w + 1, '手机端无横向溢出（scrollWidth=' + mobile.docWidth + '）');
    console.log('  手机端几何：' + JSON.stringify(mobile));

    console.log('=== 手机 390x844：题库页截图 ===');
    await goto('/puzzles');
    await page.waitFor('[data-testid="puzzle-page"]');
    const mobilePuzzleShot = await page.shot(join(OUT, 'mobile-390x844-puzzle.png'));
    ok(mobilePuzzleShot.width === 390 && mobilePuzzleShot.height === 844, '手机题库截图 390x844（实际 ' + mobilePuzzleShot.width + 'x' + mobilePuzzleShot.height + '，' + mobilePuzzleShot.bytes + ' bytes）');
    const pLayout = await page.evaluate(LAYOUT_PROBE);
    ok(pLayout.docWidth <= pLayout.viewport.w + 1, '手机端题库页无横向溢出（scrollWidth=' + pLayout.docWidth + '）');
    ok(pLayout.board !== null && pLayout.board.width <= pLayout.viewport.w, '手机端题库棋盘在视口内');

    console.log('=== 渲染密度（防“空白页也算通过”） ===');
    const density = await page.evaluate(`(() => ({
      text: document.body.innerText.replace(/\\s+/g, ' ').length,
      points: document.querySelectorAll('.go-point').length,
      stones: document.querySelectorAll('.go-stone').length,
      panels: document.querySelectorAll('.panel').length,
      title: document.title,
    }))()`);
    console.log('  密度：' + JSON.stringify(density));
    ok(density.text > 200, '页面有实际文本内容（' + density.text + ' 字符）');
    ok(density.points === 169, '13 路棋盘 169 个交叉点（实际 ' + density.points + '）');
    ok(density.stones >= 10, '棋盘上有棋子渲染（' + density.stones + ' 个）');
    ok(density.panels >= 2, '页面面板已渲染（' + density.panels + ' 个）');

    console.log('=== 白棋可辨（R09） ===');
    // 棋子是 .go-stone.stone-{A|B|C}，填充是 radial-gradient（不是 backgroundColor），
    // 所以要比的是 backgroundImage 与描边色 —— 第一次写成 backgroundColor 时两边都是 transparent。
    const stones = await page.evaluate(`(() => {
      const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el);
        return { bgImage: cs.backgroundImage.replace(/\s+/g, ' ').slice(0, 160), border: cs.borderTopColor, size: Math.round(el.getBoundingClientRect().width) }; };
      return { white: pick('.go-stone.stone-C'), red: pick('.go-stone.stone-A'), green: pick('.go-stone.stone-B') };
    })()`);
    ok(stones.white !== null, '页面上有白棋棋子：' + JSON.stringify(stones.white));
    ok(stones.red !== null, '页面上有红棋棋子：' + JSON.stringify(stones.red));
    ok(stones.white && stones.red && stones.white.bgImage !== stones.red.bgImage, '白棋与红棋填充不同');
    ok(!!stones.white && /rgb\(255, 255, 255\)/.test(stones.white.bgImage), '白棋填充含纯白，浅色棋盘上仍可辨');
    ok(!!stones.white && !!stones.red && stones.white.border !== stones.red.border, '白棋有独立描边色（' + stones.white?.border + ' vs ' + stones.red?.border + '）');
    console.log('  棋子样式：' + JSON.stringify(stones).slice(0, 400));

    console.log('=== 页面运行期错误 ===');
    ok(consoleErrors.length === 0, '浏览器控制台无未捕获异常（实际 ' + consoleErrors.length + ' 条）' + (consoleErrors.length ? ' ' + consoleErrors[0] : ''));
    console.log('  桌面布局：' + JSON.stringify(layoutDesktop));

    console.log('=== 观测 ===');
    console.log('  release=' + release);
    console.log('  gameId=' + game.gameId);
    console.log('  demoUser=' + winner.username);
    console.log('  screenshots=' + OUT);
    console.log(failures === 0 ? 'BROWSER UI CHECK: ALL PASS 0' : 'BROWSER UI CHECK: ' + failures + ' FAILED 1');
  } finally {
    try { ws.close(); } catch { /* noop */ }
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });