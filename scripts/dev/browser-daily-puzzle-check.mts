/**
 * 每日一题专项浏览器验收（真实 Edge 无头 + CDP）。
 *
 *   npx tsx scripts/dev/browser-daily-puzzle-check.mts --site http://127.0.0.1:4173 --api http://127.0.0.1:8080
 *
 * 覆盖本轮两件事：
 *  1. 三块冗余文字确实从界面上消失（并核对没有把正常产品信息一起删掉）；
 *  2. 真实点击棋盘交叉点能拿到判题结果，**不再返回 Not Found**（含复盘后回到当前局面的路径）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'http://127.0.0.1:4173');
const API = argOf('--api', 'http://127.0.0.1:8080');
const OUT = argOf('--out', 'evidence/daily-puzzle');
const PORT = 9600 + Math.floor(Math.random() * 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket, private sessionId: string) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const pr = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) pr.reject(new Error(msg.error.message)); else pr.resolve(msg.result);
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
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 240));
    return r.result?.value;
  }
  async waitFor(selector: string, timeoutMs = 20000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await this.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')')) return true;
      await sleep(120);
    }
    return false;
  }
  async shot(path: string): Promise<{ bytes: number; width: number; height: number }> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(path, buf);
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) throw new Error('不是 PNG: ' + path);
    return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
}

/** 点击第一个可点的空交叉点；返回它点的坐标。 */
const CLICK_EMPTY = "(() => { const el = document.querySelector('.go-point[data-piece=\"\"][aria-disabled=\"false\"]'); if (!el) return null; const r = el.getAttribute('data-row'), c = el.getAttribute('data-col'); el.click(); return { row: Number(r), col: Number(c) }; })()";
const EMPTY_COUNT = "document.querySelectorAll('.go-point[data-piece=\"\"][aria-disabled=\"false\"]').length";

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((b) => existsSync(b))!;
  const profile = join(tmpdir(), 'srszq-dp-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  try {
    let info: any = null;
    for (let i = 0; i < 80 && !info; i += 1) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) info = await r.json(); } catch { /* 等待 */ } if (!info) await sleep(250); }
    const ws = new WebSocket(info.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const cdp = new Cdp(ws, '');
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    const page = new Cdp(ws, attached.sessionId as string);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const viewport = async (w: number, h: number, mobile: boolean) => { await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }); };
    const goto = async (hash: string) => { await page.send('Page.navigate', { url: SITE + '/#' + hash }); await sleep(1400); };

    await viewport(1440, 900, false);
    console.log('=== 准备：一键建号并完成教学 ===');
    await page.send('Page.navigate', { url: SITE + '/' });
    await sleep(1500);
    await page.evaluate('document.querySelector("[data-testid=cta-quick-start]").click()');
    let userId: string | null = null;
    for (let i = 0; i < 100 && !userId; i += 1) { userId = await page.evaluate('(() => { try { const u = JSON.parse(localStorage.getItem("srszq_user") || "null"); return u && u.id ? u.id : null; } catch { return null; } })()'); if (!userId) await sleep(200); }
    ok(!!userId, '一键建号成功（' + userId + '）');
    const tut = await page.evaluate('fetch(' + JSON.stringify(API + '/api/tutorial/complete') + ', { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } }).then(r => r.status).catch(e => "ERR " + e.message)');
    ok(String(tut) === '200', '教学完成（' + tut + '）');

    console.log('=== 1. 每日一题页面：冗余文字必须消失 ===');
    await goto('/puzzles');
    ok(await page.waitFor('[data-testid="puzzle-page"]', 25000), '每日一题页面渲染');
    ok(await page.waitFor('[data-testid="board"]', 25000), '棋盘渲染');
    const text = String(await page.evaluate('document.body.innerText'));
    const gone = [
      ['点一个空交叉点落子', '棋盘下方教学说明'],
      ['答案提交后由服务端用完整答案集判定', '判题说明'],
      ['我的状态：', '我的状态一行'],
      ['已尝试', '尝试次数一行'],
      ['起始局面', '起始局面一行'],
      ['SYNTHETIC_SELFPLAY', '内部来源标签'],
      ['shared/game/qualification', '引擎实现路径'],
      ['与 Online Match 同一个资格引擎', '开发说明段落'],
      ['来源', '来源字段'],
    ] as const;
    for (const [needle, label] of gone) ok(!text.includes(needle), '已删除：' + label + '（找不到「' + needle + '」）');
    ok(!/[ABC]\s*座/.test(text), '不再出现 A/B/C 座 这种内部座位名');
    ok(!/\b(13|17)\s*路\b/.test(text), '不再显示「N 路」这类内部棋盘参数');
    const stillThere = [
      ['每日一题', '页面标题'],
      ['胜权时间线', '胜权时间线面板'],
      ['我的进度', '我的进度面板'],
      ['回到今日题目', '回到今日题目按钮'],
    ] as const;
    for (const [needle, label] of stillThere) ok(text.includes(needle), '保留：' + label);
    const typeLabel = await page.evaluate('document.querySelector("[data-testid=puzzle-type]")?.innerText ?? ""');
    ok(String(typeLabel).length > 0, '保留：题目类型（' + typeLabel + '）');
    const roundLine = String(await page.evaluate('document.querySelector("[data-testid=puzzle-round]")?.innerText ?? ""'));
    ok(/第 \d+ 轮/.test(roundLine) && /(红棋|绿棋|白棋)行棋/.test(roundLine), '保留：轮次与行棋颜色（' + roundLine + '）');
    const tl = String(await page.evaluate('document.querySelector("[data-testid=puzzle-timeline-current]")?.innerText ?? ""'));
    ok(/当前 · Round \d+/.test(tl), '保留：当前胜权（' + tl + '）');

    console.log('=== 2. 点击棋盘空交叉点：必须得到判题结果（不再是 Not Found）===');
    const emptyCount = await page.evaluate(EMPTY_COUNT);
    ok(Number(emptyCount) > 0, '棋盘存在可点的空交叉点（' + emptyCount + ' 个）');
    const clicked = await page.evaluate(CLICK_EMPTY);
    ok(!!clicked, '点击了一个空交叉点：' + JSON.stringify(clicked));
    const gotVerdict = await page.waitFor('[data-testid="puzzle-verdict"]', 20000);
    ok(gotVerdict, '提交后出现判题结论（不再无反应/Not Found）');
    const verdict = String(await page.evaluate('document.querySelector("[data-testid=puzzle-verdict]")?.innerText ?? ""'));
    ok(/正确|不对|这一手不合法|开放研究题/.test(verdict), '判题结论可读：' + verdict);
    const pageText2 = String(await page.evaluate('document.body.innerText'));
    ok(!/not found|Not Found|HTTP 404/i.test(pageText2), '页面上没有 Not Found / 404 字样');
    const hasErr = await page.evaluate('!!document.querySelector("[data-testid=puzzle-error]")');
    const errText = String(await page.evaluate('document.querySelector("[data-testid=puzzle-error]")?.innerText ?? ""'));
    ok(hasErr === false, '没有出现错误提示条' + (hasErr ? '（实际：' + errText + '）' : ''));

    console.log('=== 3. 复盘后回到当前局面：仍可正常作答 ===');
    await page.evaluate('document.querySelector("[data-testid=puzzle-step-prev]").click()');
    await sleep(300);
    ok(await page.evaluate('!!document.querySelector("[data-testid=puzzle-rewound]")'), '回放态给出提示');
    const clickableInReplay = await page.evaluate(EMPTY_COUNT);
    ok(Number(clickableInReplay) === 0, '回放态棋盘不可点（可点交叉点 ' + clickableInReplay + ' 个）');
    await page.evaluate('document.querySelector("[data-testid=puzzle-step-live]").click()');
    await sleep(400);
    const clickableLive = await page.evaluate(EMPTY_COUNT);
    ok(Number(clickableLive) > 0, '回到当前局面后棋盘恢复可点（' + clickableLive + ' 个）');
    const clicked2 = await page.evaluate(CLICK_EMPTY);
    ok(!!clicked2, '再次点击空交叉点：' + JSON.stringify(clicked2));
    await sleep(1200);
    const pageText3 = String(await page.evaluate('document.body.innerText'));
    ok(!/not found|HTTP 404/i.test(pageText3), '复盘往返后依然没有 Not Found');
    const attemptsLine = String(await page.evaluate('document.querySelector("[data-testid=progress-line]")?.innerText ?? ""'));
    ok(/累计尝试/.test(attemptsLine), '进度已更新：' + attemptsLine);

    console.log('=== 4. 截图（桌面 1440x900 / 手机 390x844）===');
    const d = await page.shot(join(OUT, 'daily-puzzle-desktop-fixed.png'));
    ok(d.width === 1440 && d.height === 900, '桌面截图 1440x900（' + d.bytes + ' bytes）');
    const bigGap = await page.evaluate('(() => { const b = document.querySelector(".rv-col-board"); const a = document.querySelector(".rv-col-aside"); return { boardH: b ? Math.round(b.getBoundingClientRect().height) : 0, asideH: a ? Math.round(a.getBoundingClientRect().height) : 0 }; })()');
    console.log('  几何：' + JSON.stringify(bigGap));
    ok(Number(bigGap.boardH) > 200, '棋盘高度正常（' + bigGap.boardH + 'px），没有塌陷成大空白');
    await viewport(390, 844, true);
    await sleep(600);
    const m = await page.shot(join(OUT, 'daily-puzzle-mobile-fixed.png'));
    ok(m.width === 390 && m.height === 844, '手机截图 390x844（' + m.bytes + ' bytes）');
    const docW = await page.evaluate('document.documentElement.scrollWidth');
    ok(Number(docW) <= 391, '手机端无横向溢出（scrollWidth=' + docW + '）');
    ws.close();
  } finally {
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  console.log('DAILY PUZZLE BROWSER CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
