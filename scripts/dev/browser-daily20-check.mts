/**
 * 每日训练 Session（≤20）浏览器验收 + 截图（真实前后端）。
 *
 *   npx tsx scripts/dev/browser-daily20-check.mts --site/--api/--ws [--out]
 *
 * 截图（需求第 25 节要求的 5 张）：ANSWERING / WRONG FEEDBACK / SOLVED / 下一题 / 今日完成；
 * 另加手机 390x844 的 ANSWERING 与 SOLVED。
 * 断言：页面里**没有**历史回放控件；答错不落子；答对正解留在棋盘上；刷新后仍在；
 *      未答对时“下一题”禁用；答对后可进入下一题；最后一题给“今日训练完成”。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { PUZZLE_BANK } from '../../shared/src/product/puzzleBank.generated.js';
import { getLegalMoves } from '../../shared/src/game/legalMoves.js';
import { applyMove, createInitialState } from '../../shared/src/game/rules.js';
import type { BoardSize } from '../../shared/src/game/types.js';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'http://127.0.0.1:4173');
const API = argOf('--api', 'http://127.0.0.1:8080');
const OUT = argOf('--out', 'evidence/daily20');
const PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };
const bankById = new Map(PUZZLE_BANK.map((p) => [p.puzzleId, p]));

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket, private sessionId: string) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) { const pr = this.pending.get(msg.id)!; this.pending.delete(msg.id); if (msg.error) pr.reject(new Error(msg.error.message)); else pr.resolve(msg.result); }
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId: string | null = this.sessionId): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result?.value;
  }
  async waitFor(selector: string, timeoutMs = 20000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')')) return true; } catch { /* retry */ }
      await sleep(150);
    }
    return false;
  }
  async shot(path: string): Promise<{ bytes: number; width: number; height: number }> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(path, buf);
    const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!png) throw new Error('不是 PNG: ' + path);
    return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

function stateOfPuzzle(pz: { boardSize: number; moves: Array<{ row: number; col: number }> }) {
  let s = createInitialState(pz.boardSize as BoardSize);
  for (const m of pz.moves) s = applyMove(s, m.row, m.col).state;
  return s;
}
const CELL = (row: number, col: number): string => '.go-point[data-row="' + row + '"][data-col="' + col + '"]';
const isEmpty = (row: number, col: number): string => 'document.querySelector(' + JSON.stringify(CELL(row, col)) + ')?.getAttribute("data-piece") === ""';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const name = ('dshd20' + stamp).slice(0, 16);
  const reg = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  if (reg.status !== 201) { console.log('FAIL 注册 status=' + reg.status + ' ' + JSON.stringify(reg.json)); process.exit(1); }
  const token = reg.json.token as string;
  await api('POST', '/api/tutorial/complete', {}, token);
  const me = (await api('GET', '/api/me', undefined, token)).json.user;
  const daily = (await api('GET', '/api/puzzles/daily', undefined, token)).json;
  console.log('账号 ' + name + '；今日训练 ' + daily.session.total + ' 题；首题 ' + daily.puzzle.puzzleId);

  const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((b) => existsSync(b))!;
  const profile = join(tmpdir(), 'srszq-d20-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  try {
    let info: any = null;
    for (let i = 0; i < 80 && !info; i += 1) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) info = await r.json(); } catch { /* 等 */ } if (!info) await sleep(250); }
    const ws = new WebSocket(info.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const cdp = new Cdp(ws, '');
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    const page = new Cdp(ws, attached.sessionId as string);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const viewport = async (w: number, h: number, mobile: boolean) => { await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }); };
    await viewport(1440, 900, false);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: [
      'try {',
      '  localStorage.setItem("srszq_token", ' + JSON.stringify(token) + ');',
      '  localStorage.setItem("srszq_user", ' + JSON.stringify(JSON.stringify(me)) + ');',
      '} catch (e) {}',
    ].join('\n') });
    await page.send('Page.navigate', { url: SITE + '/#/puzzles' });
    ok(await page.waitFor('[data-testid="puzzle-page"]', 25000), '每日训练页面渲染');
    ok(await page.waitFor('[data-testid="board"]', 25000), '棋盘渲染');

    console.log('=== 1. ANSWERING ===');
    const pos = String(await page.evaluate('document.querySelector("[data-testid=puzzle-position]")?.innerText ?? ""'));
    ok(/第 1 \/ \d+ 题/.test(pos), '顶部显示 第 x / total 题：' + pos);
    const solved0 = String(await page.evaluate('document.querySelector("[data-testid=puzzle-timeline-current]")?.innerText ?? ""'));
    ok(/当前 · Round \d+/.test(solved0), '胜权时间线（ANSWERING）：' + solved0);
    ok((await page.evaluate('!!document.querySelector("[data-testid=puzzle-next]")')) === true, '“下一题”按钮存在');
    ok((await page.evaluate('document.querySelector("[data-testid=puzzle-next]").disabled')) === true, '未答对时“下一题”是 disabled');
    const historyControls = await page.evaluate('["[data-testid=puzzle-steps]","[data-testid=puzzle-step-prev]","[data-testid=puzzle-step-next]","[data-testid=puzzle-step-first]","[data-testid=puzzle-step-live]","[data-testid=puzzle-step-info]","[data-testid=puzzle-rewound]","[data-testid=back-to-daily]",".rv-scrub"].filter((s) => document.querySelector(s)).length');
    ok(Number(historyControls) === 0, '页面里没有任何历史回放控件（上一步/下一步/回到当前局面/手数/进度条）');
    const numbers = await page.evaluate('Array.from(document.querySelectorAll(".go-stone")).filter((el) => /[0-9]/.test(el.textContent || "")).length');
    ok(Number(numbers) === 0, '棋盘棋子不显示手数（带数字的棋子数=' + numbers + '）');
    const s1 = await page.shot(join(OUT, 'daily20-1-answering-1440x900.png'));
    ok(s1.width === 1440 && s1.height === 900, '截图 ANSWERING 1440x900（' + s1.bytes + ' bytes）');

    console.log('=== 2. WRONG FEEDBACK ===');
    const pz1 = daily.puzzle;
    const def1 = bankById.get(pz1.puzzleId)!;
    const st1 = stateOfPuzzle(pz1);
    const answers1 = new Set(def1.answers.map((a) => a.row + ',' + a.col));
    const wrongPt = getLegalMoves(st1).find((m) => !answers1.has(m.row + ',' + m.col));
    assertOk(!!wrongPt, '必须能找到合法但非答案的落点');
    await page.evaluate('document.querySelector(' + JSON.stringify(CELL(wrongPt!.row, wrongPt!.col)) + ').click()');
    ok(await page.waitFor('[data-testid="puzzle-feedback"]', 15000), '答错后出现反馈');
    const fb = String(await page.evaluate('document.querySelector("[data-testid=puzzle-feedback]")?.innerText ?? ""'));
    ok(/再想想|不对|不合法/.test(fb), '反馈文案是“再想想”一类：' + fb);
    ok((await page.evaluate(isEmpty(wrongPt!.row, wrongPt!.col))) === true, '答错不在棋盘上留下棋子（题面未变）');
    ok((await page.evaluate('document.querySelector("[data-testid=puzzle-next]").disabled')) === true, '答错后“下一题”仍然 disabled');
    const s2 = await page.shot(join(OUT, 'daily20-2-wrong-1440x900.png'));
    ok(s2.width === 1440 && s2.height === 900, '截图 WRONG 1440x900（' + s2.bytes + ' bytes）');

    console.log('=== 3. SOLVED（正解留在棋盘上）===');
    const ans1 = def1.answers[0];
    await page.evaluate('document.querySelector(' + JSON.stringify(CELL(ans1.row, ans1.col)) + ').click()');
    ok(await page.waitFor('[data-testid="puzzle-solved-note"]', 15000), '答对后进入 SOLVED');
    const verdict = String(await page.evaluate('document.querySelector("[data-testid=puzzle-verdict]")?.innerText ?? ""'));
    ok(verdict.includes('正确'), '判定显示“正确”：' + verdict);
    ok((await page.evaluate(isEmpty(ans1.row, ans1.col))) === false, '正解棋子真的留在棋盘上');
    const phaseAttr = await page.evaluate('document.querySelector("[data-testid=puzzle-timeline]").getAttribute("data-phase")');
    ok(phaseAttr === 'SOLVED', '时间线阶段标为 SOLVED（与棋盘同局面）：' + phaseAttr);
    ok((await page.evaluate('document.querySelector("[data-testid=puzzle-next]").disabled')) === false, '答对后“下一题”可用');
    const s3 = await page.shot(join(OUT, 'daily20-3-solved-1440x900.png'));
    ok(s3.width === 1440 && s3.height === 900, '截图 SOLVED 1440x900（' + s3.bytes + ' bytes）');

    console.log('=== 4. 下一题 ===');
    await page.evaluate('document.querySelector("[data-testid=puzzle-next]").click()');
    const moved = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 20000) { const p = String(await page.evaluate('document.querySelector("[data-testid=puzzle-position]")?.innerText ?? ""')); if (/第 2 \//.test(p)) return p; await sleep(200); } return null; })();
    ok(!!moved, '点击后进入第 2 题：' + moved);
    ok((await page.evaluate('document.querySelector("[data-testid=puzzle-next]").disabled')) === true, '新题未答对 → “下一题”重新 disabled');
    const s4 = await page.shot(join(OUT, 'daily20-4-next-1440x900.png'));
    ok(s4.width === 1440 && s4.height === 900, '截图 下一题 1440x900（' + s4.bytes + ' bytes）');

    console.log('=== 5. 刷新后正解仍在（SOLVED 持久化）===');
    const pz2 = (await api('GET', '/api/puzzles/daily', undefined, token)).json.puzzle;
    const ans2 = bankById.get(pz2.puzzleId)!.answers[0];
    await api('POST', '/api/puzzles/' + encodeURIComponent(pz2.puzzleId) + '/attempt', { attemptId: 'b2', row: ans2.row, col: ans2.col }, token);
    await page.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    ok(await page.waitFor('[data-testid="puzzle-solved-note"]', 20000), '刷新后仍是 SOLVED');
    ok((await page.evaluate(isEmpty(ans2.row, ans2.col))) === false, '刷新后正解棋子仍在棋盘上');

    console.log('=== 6. 手机 390x844 ===');
    await viewport(390, 844, true);
    await sleep(800);
    const m1 = await page.shot(join(OUT, 'daily20-3-solved-390x844.png'));
    ok(m1.width === 390 && m1.height === 844, '手机 SOLVED 截图 390x844（' + m1.bytes + ' bytes）');
    const docW = await page.evaluate('document.documentElement.scrollWidth');
    ok(Number(docW) <= 391, '手机端无横向溢出（scrollWidth=' + docW + '）');

    console.log('=== 7. 今日完成 ===');
    // 用 API 把剩下的题全部做完（浏览器一题一题点太慢），然后回到页面看完成态
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 40) break;
      const cur = (await api('GET', '/api/puzzles/daily', undefined, token)).json;
      if (!cur.puzzle) break;
      const a = bankById.get(cur.puzzle.puzzleId)!.answers[0];
      await api('POST', '/api/puzzles/' + encodeURIComponent(cur.puzzle.puzzleId) + '/attempt', { attemptId: 'fin' + guard, row: a.row, col: a.col }, token);
      const nx = await api('POST', '/api/puzzles/daily/next', { expectedIndex: cur.session.currentIndex }, token);
      if (nx.json.completed) break;
    }
    await viewport(1440, 900, false);
    await page.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    ok(await page.waitFor('[data-testid="puzzle-complete"]', 20000), '全部完成后显示“今日训练完成”');
    const doneText = String(await page.evaluate('document.querySelector("[data-testid=puzzle-complete]")?.innerText ?? ""'));
    ok(/今日训练完成/.test(doneText), '完成文案：' + doneText.replace(/\n/g, ' '));
    ok((await page.evaluate('!!document.querySelector("[data-testid=board]")')) === false, '完成后不再显示新题棋盘（不会有第 21 题）');
    const s5 = await page.shot(join(OUT, 'daily20-5-complete-1440x900.png'));
    ok(s5.width === 1440 && s5.height === 900, '截图 今日完成 1440x900（' + s5.bytes + ' bytes）');
    ws.close();
  } finally {
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  console.log('DAILY20 BROWSER CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
  process.exit(failures === 0 ? 0 : 1);
}

function assertOk(cond: boolean, msg: string): void { if (!cond) { failures += 1; console.log('  FAIL ' + msg); } }

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
