/**
 * 增量 A/B/C 的真实浏览器验收（CDP + 本机 Edge 无头实例）。
 *
 *   npx tsx scripts/dev/browser-increment-check.mts --site http://127.0.0.1:4173 --api http://127.0.0.1:8080
 *
 * 打的是**本地跑起来的这一份源码**（不是线上），覆盖：
 *  1. 首页主 CTA「创建账号并开始」+ 弱化的「已有账号？登录」；
 *  2. 一键建号 → 自动登录（无邮箱/密码，无令牌落 localStorage）→ 大厅；
 *  3. 账号页原地领取（昵称+密码），userId 不变；
 *  4. 每日一题胜权时间线：当前/下一轮、步进跟随、白棋对比度；
 *  5. Online 20 秒倒计时文案与初值；
 *  6. 桌面 1440x900 与手机 390x844 截图（PNG 尺寸校验）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'http://127.0.0.1:4173');
const API = argOf('--api', 'http://127.0.0.1:8080');
const OUT = argOf('--out', 'evidence/increment-browser');
const PORT = Number(argOf('--port', String(9400 + Math.floor(Math.random() * 400))));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
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

async function findBrowser(): Promise<string> {
  for (const b of BROWSERS) if (existsSync(b)) return b;
  throw new Error('没有找到 Edge/Chrome');
}
async function waitJson(url: string, timeoutMs = 20000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端点未就绪: ' + url);
}

/** 在页面里算 WCAG 对比度（白棋可见性用）。 */
const CONTRAST_FN = "const lum=(c)=>{const m=c.match(/[0-9.]+/g).map(Number);const f=m.slice(0,3).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]};const ratio=(a,b)=>{const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)};";

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const bin = await findBrowser();
  const profile = join(tmpdir(), 'srszq-inc-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const proc: ChildProcess = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    const info = await waitJson('http://127.0.0.1:' + PORT + '/json/version');
    const ws = new WebSocket(info.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const cdp = new Cdp(ws, '');
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    const page = new Cdp(ws, attached.sessionId as string);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const setViewport = async (w: number, h: number, mobile: boolean) => { await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }); };
    const goto = async (hash: string) => { await page.send('Page.navigate', { url: SITE + '/#' + hash }); await sleep(1400); };
    const userId = async () => page.evaluate('(() => { try { const u = JSON.parse(localStorage.getItem("srszq_user") || "null"); return u && u.id ? u.id : null; } catch { return null; } })()');

    await setViewport(1440, 900, false);
    console.log('=== 1. 未登录首页：主 CTA 与弱化的登录入口 ===');
    await page.send('Page.navigate', { url: SITE + '/' });
    await sleep(1500);
    ok(await page.waitFor('[data-testid="cta-quick-start"]'), '首页渲染出主 CTA');
    const ctaText = await page.evaluate('document.querySelector("[data-testid=cta-quick-start]").innerText');
    ok(String(ctaText).includes('创建账号并开始'), '主 CTA 文案是「创建账号并开始」：' + ctaText);
    const loginVisible = await page.evaluate('!!document.querySelector("[data-testid=cta-login]")');
    ok(loginVisible === true, '保留较弱的「已有账号？登录」入口');
    const heroShot = await page.shot(join(OUT, 'desktop-1440x900-home-cta.png'));
    ok(heroShot.width === 1440 && heroShot.height === 900, '首页截图 1440x900（' + heroShot.bytes + ' bytes）');

    console.log('=== 2. 一键创建账号并开始 ===');
    await page.evaluate('document.querySelector("[data-testid=cta-quick-start]").click()');
    const created = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 25000) { const id = await userId(); if (id) return id; await sleep(200); } return null; })();
    ok(!!created, '一键建号后已自动登录（localStorage 里有用户）：' + created);
    const tokenLeak = await page.evaluate('localStorage.getItem("srszq_token")');
    ok(!tokenLeak, '会话密钥没有落进 localStorage（走 HttpOnly cookie）：' + String(tokenLeak));
    const provFlag = await page.evaluate('(() => { const u = JSON.parse(localStorage.getItem("srszq_user") || "null"); return u ? { provisional: u.provisional === true, username: u.username } : null; })()');
    ok(provFlag && provFlag.provisional === true, '前端知道这是临时账号：' + JSON.stringify(provFlag));
    ok(!!provFlag && /^棋友/.test(String(provFlag.username)), '昵称是系统生成的随机中文名：' + (provFlag && provFlag.username));
    const doneTutorial = await page.evaluate('fetch(' + JSON.stringify(API + '/api/tutorial/complete') + ', { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } }).then(r => r.status).catch(e => "ERR " + e.message)');
    ok(String(doneTutorial) === '200', '页面内用 cookie 会话调用受保护接口成功（' + doneTutorial + '）');
    await goto('/lobby');
    await sleep(800);
    const lobbyShot = await page.shot(join(OUT, 'desktop-1440x900-lobby-after-quickstart.png'));
    ok(lobbyShot.width === 1440 && lobbyShot.height === 900, '一键建号后的大厅截图 1440x900（' + lobbyShot.bytes + ' bytes）');

    console.log('=== 3. 账号页：原地领取（昵称+密码），userId 不变 ===');
    const before = await userId();
    await goto('/me');
    ok(await page.waitFor('[data-testid="profile-page"]', 15000), '账号页渲染成功');
    ok(await page.waitFor('[data-testid="profile-provisional"]', 15000), '账号页提示这是临时账号');
    const newName = '领取' + String(Math.floor(Math.random() * 9000) + 1000);
    await page.evaluate('(() => { const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }; set(document.querySelector("[data-testid=claim-username]"), ' + JSON.stringify(newName) + '); set(document.querySelector("[data-testid=claim-password]"), "Passw0rd!23"); })()');
    await page.evaluate('document.querySelector("[data-testid=claim-submit]").click()');
    ok(await page.waitFor('[data-testid="claim-ok"]', 15000), '领取成功并给出提示');
    const after = await userId();
    ok(after === before, '领取前后必须是同一个 userId（战绩不丢）：' + before + ' -> ' + after);
    const claimShot = await page.shot(join(OUT, 'desktop-1440x900-profile-claim.png'));
    ok(claimShot.width === 1440 && claimShot.height === 900, '账号领取截图 1440x900（' + claimShot.bytes + ' bytes）');
    console.log('=== 4. 每日一题：胜权时间线 + 步进跟随 + 白棋对比度 ===');
    await goto('/puzzles');
    ok(await page.waitFor('[data-testid="puzzle-timeline"]', 25000), '每日一题页面出现胜权时间线');
    const cur = await page.evaluate('document.querySelector("[data-testid=puzzle-timeline-current]").innerText');
    const nxt = await page.evaluate('document.querySelector("[data-testid=puzzle-timeline-next]").innerText');
    ok(/当前 · Round \d+/.test(String(cur)), '显示当前轮与当前胜权：' + cur);
    ok(/下一轮|下一次胜权/.test(String(nxt)), '显示下一轮胜权：' + nxt);
    const round0 = await page.evaluate('document.querySelector("[data-testid=puzzle-timeline]").getAttribute("data-round")');
    const stops = await page.evaluate('document.querySelectorAll(".round-track .track-stop").length');
    ok(stops >= 3, '时间线给出未来若干轮（实际 ' + stops + ' 站）');
    const curClass = await page.evaluate('document.querySelector(".round-track .track-stop").className');
    const nextClass = await page.evaluate('document.querySelectorAll(".round-track .track-stop")[1].className');
    ok(String(curClass).includes('now'), '第一站标为 CURRENT：' + curClass);
    ok(String(nextClass).includes('next'), '第二站标为 NEXT（次级层级）：' + nextClass);
    // 白棋底是**渐变**（background-image），computed backgroundColor 是透明的。
    // 拿文字色去比透明底等于算了个寂寞（本地自检踩到，误报 2.45）。
    // 正确口径：把渐变里的每个色标都当底色，取最差对比；同时要求棋子有可见填充或描边。
    const contrast = await page.evaluate('(() => { ' + CONTRAST_FN + ' const el = document.querySelector(".round-track .color-chip.stone-C") || document.querySelector(".stone-C"); if (!el) return null; const cs = getComputedStyle(el); const stops = (cs.backgroundImage.match(/rgba?\\([^)]+\\)/g) || []); const fills = stops.length ? stops : (/rgba\\(0, 0, 0, 0\\)/.test(cs.backgroundColor) ? [] : [cs.backgroundColor]); const ratios = fills.map((c) => ratio(cs.color, c)); return { borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor, color: cs.color, fills, worstRatio: ratios.length ? Math.min.apply(null, ratios) : null, hasFill: fills.length > 0 || !/rgba\\(0, 0, 0, 0\\)/.test(cs.backgroundColor) }; })()');
    ok(!!contrast, '时间线里能找到白棋标识');
    ok(!!contrast && parseFloat(contrast.borderWidth) >= 1 && !/rgba\(0, 0, 0, 0\)/.test(String(contrast.borderColor)), '白棋有可见描边：' + JSON.stringify(contrast && { w: contrast.borderWidth, c: contrast.borderColor }));
    ok(!!contrast && contrast.hasFill === true, '白棋有可见底色（渐变或实色），不是透明圆点');
    ok(!!contrast && Number(contrast.worstRatio) >= 3, '白棋文字与底色最差对比度 >= 3（色标 ' + JSON.stringify(contrast && contrast.fills) + '，最差 ' + (contrast && contrast.worstRatio ? Number(contrast.worstRatio).toFixed(2) : 'n/a') + '）');
    ok(Number(round0) > 0, '时间线带当前轮次：Round ' + round0);
    // 每日训练 Session 改版后，每日题页面**不再有**历史回放控件（上一步/下一步/回到当前局面）
    // 与棋子手数，「下一题」在答对前是禁用的。这里改断言新契约（旧断言已随功能下线）。
    const historyControls = await page.evaluate('["[data-testid=puzzle-steps]","[data-testid=puzzle-step-prev]","[data-testid=puzzle-step-next]","[data-testid=puzzle-step-first]","[data-testid=puzzle-step-live]","[data-testid=puzzle-step-info]","[data-testid=puzzle-rewound]","[data-testid=back-to-daily]",".rv-scrub"].filter((s) => document.querySelector(s)).length');
    ok(Number(historyControls) === 0, '每日题页面已无历史回放控件（找到 ' + historyControls + ' 个）');
    const numbers = await page.evaluate('Array.from(document.querySelectorAll(".go-stone")).filter((el) => /[0-9]/.test(el.textContent || "")).length');
    ok(Number(numbers) === 0, '棋盘棋子不显示手数（带数字的棋子数=' + numbers + '）');
    const nextDisabled = await page.evaluate('(() => { const b = document.querySelector("[data-testid=puzzle-next]"); return b ? b.disabled === true : null; })()');
    ok(nextDisabled === true, '未答对时「下一题」是 disabled（实际 ' + nextDisabled + '）');
    const puzzleShot = await page.shot(join(OUT, 'desktop-1440x900-puzzle-timeline.png'));
    ok(puzzleShot.width === 1440 && puzzleShot.height === 900, '每日一题截图 1440x900（' + puzzleShot.bytes + ' bytes）');

    console.log('=== 5. Online 匹配：20 秒文案与倒计时初值 ===');
    await goto('/online');
    ok(await page.waitFor('.matchmaking-card', 25000), '进入匹配页');
    const queueText = await page.evaluate('document.body.innerText');
    ok(String(queueText).includes('20 秒内不足 3 名真人'), '文案已改为 20 秒');
    const secs = await page.evaluate('(() => { const el = document.querySelector(".matching-seconds"); return el ? Number(el.innerText.replace(/[^0-9]/g, "")) : null; })()');
    ok(secs !== null && Number(secs) <= 20 && Number(secs) >= 0, '倒计时初值不超过 20 秒（实际 ' + secs + '）');
    const onlineShot = await page.shot(join(OUT, 'desktop-1440x900-online-20s.png'));
    ok(onlineShot.width === 1440 && onlineShot.height === 900, '匹配页截图 1440x900（' + onlineShot.bytes + ' bytes）');

    console.log('=== 6. 手机 390x844 ===');
    await setViewport(390, 844, true);
    await goto('/puzzles');
    ok(await page.waitFor('[data-testid="puzzle-timeline"]', 25000), '手机端每日一题时间线渲染');
    const mobileShot = await page.shot(join(OUT, 'mobile-390x844-puzzle-timeline.png'));
    ok(mobileShot.width === 390 && mobileShot.height === 844, '手机每日一题截图 390x844（' + mobileShot.bytes + ' bytes）');
    const docWidth = await page.evaluate('document.documentElement.scrollWidth');
    ok(Number(docWidth) <= 391, '手机端无横向溢出（scrollWidth=' + docWidth + '）');
    await page.send('Page.navigate', { url: SITE + '/#/' });
    await sleep(1500);
    const mobileHome = await page.shot(join(OUT, 'mobile-390x844-home-cta.png'));
    ok(mobileHome.width === 390 && mobileHome.height === 844, '手机首页截图 390x844（' + mobileHome.bytes + ' bytes）');
    ws.close();
  } finally {
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  console.log('INCREMENT BROWSER CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
