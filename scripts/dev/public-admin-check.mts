/**
 * B7：生产管理台真实浏览器验收（CDP 驱动本机 Edge 无头实例，打真实域名）。
 *
 *   npx tsx scripts/dev/public-admin-check.mts --admin-user <u> --admin-pass <p> [--expect-sha <sha>]
 *
 * 证明三件事，缺一不算过：
 *  1. 管理接口在**服务端**真的鉴权：9 个管理端点匿名 401、普通账号 403、管理员 200（前端隐藏不是权限）；
 *  2. 管理台在真实浏览器里真的渲染出真实数据（/ready、活跃房间、举报队列、审计、数据请求），截图是浏览器渲染的 PNG；
 *  3. 三层同提交：前端 bundle 烘焙的构建 sha 与后端自报 source sha 一致（Netlify 前端 vs VPS 后端）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { RELEASE_ID } from '../../shared/src/product/protocol.js';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'https://srszq.com');
const API = argOf('--api', 'https://api.srszq.com');
const OUT = argOf('--out', 'evidence/browser-admin');
// 端口随机化：固定端口会让“上一次没清掉的浏览器实例”被误当成本次实例（容量探针踩过同款坑）。
const PORT = Number(argOf('--port', String(9300 + Math.floor(Math.random() * 500))));
const ADMIN_USER = argOf('--admin-user', '');
const ADMIN_PASS = argOf('--admin-pass', '');
const EXPECT_SHA = argOf('--expect-sha', '');
const EXPECT_RELEASE = argOf('--expect-release', RELEASE_ID);
if (!ADMIN_USER || !ADMIN_PASS) { console.error('需要 --admin-user/--admin-pass（管理员账号）'); process.exit(2); }

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res { status: number; json: any; text: string }
const req = async (method: string, path: string, body?: unknown, token?: string): Promise<Res> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text };
};

/* ---------- 极简 CDP 客户端（与 browser-ui-check 同构） ---------- */
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
  async waitFor(selector: string, timeoutMs = 25000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const found = await this.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')');
      if (found) return true;
      await sleep(150);
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

function launch(bin: string, profile: string): ChildProcess {
  return spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
}

async function waitJson(url: string, timeoutMs = 20000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端点未就绪: ' + url);
}

/* ---------- 主流程 ---------- */
const ADMIN_ENDPOINTS: Array<[string, string]> = [
  ['GET', '/api/admin/live'],
  ['GET', '/api/admin/reports?status=PENDING'],
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/data-tasks'],
  ['GET', '/api/admin/dataset/runs'],
  ['GET', '/api/admin/metrics/events'],
];

const main = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });

  console.log('=== A. 服务端鉴权：匿名 401 / 普通 403 / 管理员 200 ===');
  const login = await req('POST', '/api/login', { account: ADMIN_USER, password: ADMIN_PASS });
  const adminToken = login.json?.token as string | undefined;
  ok(login.status === 200 && !!adminToken, '管理员登录 http=' + login.status);
  ok(login.json?.user?.role === 'ADMIN', '服务端自报角色 ADMIN（实际 ' + login.json?.user?.role + '）');
  if (!adminToken) { console.log('FAIL: 没有管理员令牌，后续无法进行'); process.exit(1); }

  const normUser = 'dshnorm' + Math.random().toString(16).slice(2, 8);
  const normPass = 'Probe-' + Math.random().toString(36).slice(2, 12) + '_9';
  const reg = await req('POST', '/api/register', { email: normUser + '@example.invalid', username: normUser, password: normPass });
  const normToken = reg.json?.token as string | undefined;
  ok(!!normToken, '对照普通账号注册（' + normUser + '）http=' + reg.status);
  if (!normToken) { console.log('FAIL: 对照账号注册失败，无法证明 403'); process.exit(1); }

  for (const [method, path] of ADMIN_ENDPOINTS) {
    const anon = await req(method, path);
    const norm = await req(method, path, undefined, normToken);
    const adm = await req(method, path, undefined, adminToken);
    ok(anon.status === 401 && norm.status === 403 && adm.status === 200,
      method + ' ' + path + ' => 匿名 ' + anon.status + ' / 普通 ' + norm.status + ' / 管理员 ' + adm.status);
  }
  const ghost = '00000000-0000-0000-0000-000000000000';
  const rAnon = await req('POST', '/api/admin/reports/' + ghost, { status: 'REVIEWED' });
  const rNorm = await req('POST', '/api/admin/reports/' + ghost, { status: 'REVIEWED' }, normToken);
  const rAdm = await req('POST', '/api/admin/reports/' + ghost, { status: 'REVIEWED' }, adminToken);
  ok(rAnon.status === 401, '举报复核 POST 匿名 401（实际 ' + rAnon.status + '）');
  ok(rNorm.status === 403, '举报复核 POST 普通账号 403（实际 ' + rNorm.status + '）');
  ok([400, 404].includes(rAdm.status), '举报复核 POST 管理员通过鉴权后按业务拒绝（实际 ' + rAdm.status + '）——说明这不是隐藏按钮');

  console.log('=== B. 三层同提交（Netlify 前端 vs VPS 后端） ===');
  const ver = await req('GET', '/api/version');
  const backendSha = ver.json?.source?.backendSourceSha as string | null;
  ok(ver.json?.protocol?.releaseId === EXPECT_RELEASE, '后端 releaseId=' + ver.json?.protocol?.releaseId + '（期望 ' + EXPECT_RELEASE + '）');
  ok(!!EXPECT_SHA && backendSha === EXPECT_SHA, '后端自报 source sha=' + backendSha + '（期望 ' + (EXPECT_SHA || '未指定') + '）');

  console.log('=== C. 真实浏览器（管理员视角） ===');
  const bin = await findBrowser();
  const profile = join(tmpdir(), 'srszq-admin-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const proc = launch(bin, profile);
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
    console.log('  浏览器：' + bin);

    const setViewport = async (w: number, h: number, mobile: boolean): Promise<void> => {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    };
    const goto = async (hash: string): Promise<void> => { await page.send('Page.navigate', { url: SITE + '/#' + hash }); await sleep(1500); };
    // 注入脚本的 identifier 必须留着：addScriptToEvaluateOnNewDocument 注册的脚本
    // 会在**每个新文档**上重放。换账号时若不移除，重载后它会把 localStorage 改回管理员，
    // 于是“普通账号被挡住”会永远拿到管理员页面（本次自检踩到，症状是 D 段 3 条全 FAIL）。
    const injectedScriptIds: string[] = [];
    const inject = async (token: string, user: unknown): Promise<void> => {
      const res = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: [
        'try {',
        '  localStorage.setItem("srszq_token", ' + JSON.stringify(token) + ');',
        '  localStorage.setItem("srszq_user", ' + JSON.stringify(JSON.stringify(user)) + ');',
        '} catch (e) { /* about:blank 没有 localStorage */ }',
      ].join('\n') });
      if (res?.identifier) injectedScriptIds.push(res.identifier as string);
    };
    const PROBE = '(() => {'
      + ' const g = (id) => { const el = document.querySelector("[data-testid=" + id + "]"); return el ? el.innerText : null; };'
      + ' return { system: g("admin-system"), live: g("admin-live"), reports: g("admin-reports"),'
      + ' tasks: g("admin-data-tasks"), dataset: g("admin-dataset"), audit: g("admin-audit"),'
      + ' buildSha: g("admin-build-sha"), sourceSha: g("admin-source-sha"), ready: g("admin-ready"),'
      + ' auditRows: document.querySelectorAll("[data-testid=admin-audit-row]").length,'
      + ' reportRows: document.querySelectorAll("[data-testid=admin-report-row]").length,'
      + ' taskRows: document.querySelectorAll("[data-testid=admin-task-row]").length,'
      + ' reportButtons: document.querySelectorAll("[data-testid=admin-report-row] button").length,'
      + ' navAdmin: Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "管理").length,'
      + ' pageError: g("admin-error"), apiBase: String(window.__SRSZQ_API__ ?? "unknown") }; })()';

    // 换账号必须**真正重载文档**：同 hash 导航（#/admin -> #/admin）不重载，
    // addScriptToEvaluateOnNewDocument 不会重跑，于是“普通账号”仍然是管理员页面（本地自检发现）。
    const setAuth = async (token: string, user: unknown): Promise<void> => {
      while (injectedScriptIds.length) {
        const id = injectedScriptIds.pop() as string;
        try { await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }); } catch { /* 已移除 */ }
      }
      await page.evaluate('(() => { localStorage.setItem("srszq_token", ' + JSON.stringify(token) + '); localStorage.setItem("srszq_user", ' + JSON.stringify(JSON.stringify(user)) + '); })()');
      await page.send('Page.reload', { ignoreCache: true });
      await sleep(1500);
    };

    await setViewport(1440, 900, false);
    await inject(adminToken, login.json.user);
    await goto('/admin');
    ok(await page.waitFor('[data-testid="admin-page"]'), '管理台页面渲染成功（url=' + String(await page.evaluate('location.href')) + '）');
    // 数据是异步取的：必须等**真实数据**落到面板上，不能只等容器出现、更不能用固定 sleep。
    const dataLoaded = await (async (): Promise<boolean> => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const txt = String(await page.evaluate('document.querySelector("[data-testid=admin-source-sha]")?.innerText ?? ""'));
        if (txt.includes(EXPECT_SHA)) return true;
        await sleep(300);
      }
      return false;
    })();
    ok(dataLoaded, '管理台真实数据已加载（后端 sha 落到面板上，等待真实数据而不是固定 sleep）');
    ok((await page.evaluate('document.querySelectorAll("[data-testid=admin-forbidden]").length')) === 0, '管理员视角不出现“非管理员”提示');

    const p = await page.evaluate(PROBE);
    // 页面自己直连一次 API：把“浏览器到 API 这条路”与“应用逻辑”分开证明。
    const pageFetch = await page.evaluate('fetch("https://api.srszq.com/ready").then((r) => "http " + r.status).catch((e) => "ERR " + e.message)');
    ok(String(pageFetch).startsWith('http 200'), '浏览器从页面内直连 https://api.srszq.com/ready（' + pageFetch + '）');
    ok(p.pageError === null, '管理台没有报错横幅（' + JSON.stringify(p.pageError) + '）');
    ok(typeof p.system === 'string' && p.system.includes('/ready'), '系统状态面板可见：' + JSON.stringify(p.ready));
    ok(typeof p.ready === 'string' && /就绪|未就绪/.test(p.ready), '健康探针给出可读结论');
    ok(typeof p.sourceSha === 'string' && p.sourceSha.includes(EXPECT_SHA), '面板显示的后端 source sha 与 /api/version 一致');
    ok(typeof p.buildSha === 'string' && p.buildSha.includes(EXPECT_SHA) && p.buildSha.includes('与后端同提交'),
      '构建对账面板判定“与后端同提交”：' + JSON.stringify(p.buildSha));
    ok(typeof p.live === 'string' && p.live.includes('房间') && /\d/.test(p.live), '活跃房间/队列面板有真实数字');
    ok(typeof p.reports === 'string' && p.reports.includes('举报队列'), '举报队列面板可见');
    ok(p.reportRows === 0 || p.reportButtons === p.reportRows * 3, '每个待处理举报恰好 3 个人工结论按钮（实际 ' + p.reportRows + ' 行 / ' + p.reportButtons + ' 按钮）');
    ok(typeof p.tasks === 'string' && p.tasks.includes('数据导出'), '数据导出/删除请求面板可见');
    ok(typeof p.dataset === 'string' && p.dataset.includes('数据集运行登记'), '数据集运行登记面板可见');
    ok(p.auditRows >= 1, '审计面板有真实条目（' + p.auditRows + ' 条，含刚才的 CLI 授权）');
    ok(p.navAdmin === 1, '管理员导航里有“管理”入口（实际 ' + p.navAdmin + '）');
    // 只检查**交互控件**：页面说明文字里本身就有“不改分”字样，用整页 innerText 会误判（本地自检发现）。
    const noScoreControls = await page.evaluate('Array.from(document.querySelectorAll("button,a,input,select")).filter((el) => /(改分|覆盖历史|调整分数|编辑分数)/.test(el.textContent || el.value || "")).length');
    ok(noScoreControls === 0, '没有任何可点击的改分/覆盖历史控件（实际 ' + noScoreControls + '，只统计交互元素）');
    const shot = await page.shot(join(OUT, 'desktop-1440x900-admin.png'));
    ok(shot.width === 1440 && shot.height === 900, '管理台桌面截图 1440x900（' + shot.bytes + ' bytes）');

    console.log('=== D. 真实浏览器（普通账号被挡住） ===');
    await setAuth(normToken, reg.json.user);
    const waitState = await page.waitFor('[data-testid="admin-forbidden"]', 20000);
    if (!waitState) {
      const diag = await page.evaluate('(() => ({ href: location.href, tokenHead: String(localStorage.getItem("srszq_token")).slice(0, 6), userRaw: String(localStorage.getItem("srszq_user")).slice(0, 120), panels: document.querySelectorAll("[data-testid=admin-system]").length, body: document.body.innerText.replace(/\\s+/g, " ").slice(0, 160) }))()');
      console.log('  DIAG ' + JSON.stringify(diag));
    }
    ok(waitState, '普通账号进入 /admin 得到“非管理员”提示');
    const n = await page.evaluate('(() => ({ panels: document.querySelectorAll("[data-testid=admin-system]").length, navAdmin: Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "管理").length }))()');
    ok(n.panels === 0, '普通账号看不到任何管理面板（实际 ' + n.panels + '）');
    ok(n.navAdmin === 0, '普通账号导航里没有“管理”入口（实际 ' + n.navAdmin + '）');
    const nshot = await page.shot(join(OUT, 'desktop-1440x900-admin-forbidden.png'));
    ok(nshot.width === 1440 && nshot.height === 900, '普通账号截图 1440x900（' + nshot.bytes + ' bytes）');

    console.log('=== E. 手机端 390x844 ===');
    await setViewport(390, 844, true);
    await setAuth(adminToken, login.json.user);
    await page.waitFor('[data-testid="admin-page"]');
    const mshot = await page.shot(join(OUT, 'mobile-390x844-admin.png'));
    ok(mshot.width === 390 && mshot.height === 844, '管理台手机截图 390x844（' + mshot.bytes + ' bytes）');
    const over = await page.evaluate('document.documentElement.scrollWidth');
    ok(over <= 391, '手机端无横向溢出（scrollWidth=' + over + '）');
    ws.close();
  } finally {
    // Edge 会派生一堆子进程：只 kill 父进程会留下仍在监听调试端口的实例。
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }

  console.log('PUBLIC ADMIN CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
  process.exit(failures === 0 ? 0 : 1);
};

await main();
