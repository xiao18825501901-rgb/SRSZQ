/**
 * G16 浏览器级证据：新连接替换旧连接时，页面会被告知、并且**不会自动重连**。
 *
 *   npx tsx scripts/dev/browser-multitab-check.mts --site http://127.0.0.1:4173 --api http://127.0.0.1:8080
 *
 * 设计：**只用一个标签页**，第二个连接由外部 Node WebSocket 客户端（同一 token）建立。
 * 对服务端来说这就是“同一账号的第二个连接”，效果与另开标签页一致；
 * 但避开了本机 CDP 在同一浏览器里管理多个 target 时的会话不稳定（attach/enable 偶发超时，实测多次踩到）。
 *
 * 现场缺陷（已修，2026-10-01）：这条脚本以前**跑不通**，报“第二条连接没建立”然后退出。
 *    根因有两个，都不是环境问题：
 *      1. 外部 WebSocket 建在**启动浏览器之前**（原第 115 行），于是它成了“第一个连接”，
 *         被服务端替换掉的是它自己 —— 脚本的设计是“页面先排队，外部连接后到”，顺序反了；
 *      2. `open`/`close` 监听器晚了几十秒才挂上（挂在步骤 2），事件早就发过了，
 *         等 `open` 必然超时。修法：**页面排队成功之后**才建连接，且所有监听器同一 tick 挂齐。
 *    另注：后台运行时 PowerShell 的重定向日志不刷新，所以这条脚本用 cmd 重定向跑（见 README/日志）。
 *
 * 断言：
 *  1. 页面本来在排队（连接活着）；
 *  2. 第二条连接建立后，页面的连接被服务端替换，页面给出明确提示；
 *  3. 页面**不会自动重连**：等 5 秒后确认页面既没有新建 WebSocket，也没有再发任何帧
 *     （直接量网络，不用 DOM 元素当代理）；
 *  4. 存活的那条（第二条）连接可用：能入队并收到服务端广播。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, RULESET_VERSION } from '../../shared/src/product/protocol.js';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'http://127.0.0.1:4173');
const API = argOf('--api', 'http://127.0.0.1:8080');
const WSURL = argOf('--ws', API.replace(/^http/, 'ws') + '/ws');
const OUT = argOf('--out', 'evidence/multitab');
const PORT = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };
const REPLACED_TEXT = '已在另一个标签页打开';
const QUEUE_UI = '.matching-seconds';

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** CDP 事件回调（无 id 的消息）。用来直接观测网络行为，而不是靠 DOM 猜。 */
  private listeners = new Map<string, Array<(params: any) => void>>();
  constructor(private ws: WebSocket, private sessionId: string) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const pr = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) pr.reject(new Error(msg.error.message)); else pr.resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
      }
    });
  }
  on(method: string, cb: (params: any) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(cb);
    this.listeners.set(method, list);
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
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 240));
    return r.result?.value;
  }
  async waitFor(selector: string, timeoutMs = 20000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')')) return true; } catch { /* 重试 */ }
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

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const name = ('dshmt' + stamp).slice(0, 16);
  const reg = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  if (reg.status !== 201) { console.log('FAIL 注册测试账号 status=' + reg.status); process.exit(1); }
  const token = reg.json.token as string;
  await api('POST', '/api/tutorial/complete', {}, token);
  // 必须用**完成教学之后**的 user 对象去注入：注册响应里的 tutorialCompleted 还是 false，
  // 拿它注入的话 /online 会被路由守卫重定向到 /tutorial（本地自检踩到两次）。
  const me = await api('GET', '/api/me', undefined, token);
  const user = me.json.user;
  console.log('测试账号：' + name + '（已通过 API 完成教学）');

  const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((b) => existsSync(b))!;
  const profile = join(tmpdir(), 'srszq-mt-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const extMsgs: Array<Record<string, any>> = [];
  let extCloseCode: number | null = null;
  let extError = '';
  // 第二条连接必须**在页面已经排队之后**才建立：谁后连，谁的连接才会被服务端替换。
  // （以前建在启动浏览器之前，外部连接成了“第一个连接”，被替换的是它自己。）
  let ext: WebSocket | null = null;
  // 通过函数读取：赋值发生在 Promise 回调里，直接读会让 TS 把 ext 收窄成 null/never。
  const extSocket = (): WebSocket | null => ext;
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
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // 直接观测页面的网络行为：新建了多少个 WebSocket、发出了哪些帧。
    // “有没有偷偷重连/重新入队”这件事必须这样量，不能拿 DOM 元素当代理
    // （`.matching-seconds` 在 phase=idle 时同样会渲染 —— 旧版断言因此误报）。
    await page.send('Network.enable');
    const wsCreated: string[] = [];
    const framesSent: string[] = [];
    page.on('Network.webSocketCreated', (p) => wsCreated.push(String(p?.url ?? '')));
    page.on('Network.webSocketFrameSent', (p) => framesSent.push(String(p?.response?.payloadData ?? '')));

    console.log('=== 1. 页面以该账号进入排队（连接活着）===');
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        'try {',
        '  localStorage.setItem("srszq_token", ' + JSON.stringify(token) + ');',
        '  localStorage.setItem("srszq_user", ' + JSON.stringify(JSON.stringify(user)) + ');',
        '} catch (e) {}',
      ].join('\n'),
    });
    await page.send('Page.navigate', { url: SITE + '/#/online' });
    const queued = await page.waitFor(QUEUE_UI, 25000);
    ok(queued, '页面进入排队（倒计时可见）');
    if (!queued) {
      // 失败时把现场打出来，别猜（本地自检踩过太多次）
      const diag = {
        url: await page.evaluate('location.href'),
        hasUser: await page.evaluate('!!localStorage.getItem("srszq_user")'),
        hasToken: await page.evaluate('!!localStorage.getItem("srszq_token")'),
        body: String(await page.evaluate('document.body.innerText')).slice(0, 300),
        me: await page.evaluate('fetch(' + JSON.stringify(API + '/api/me') + ', { headers: { Authorization: "Bearer " + localStorage.getItem("srszq_token") } }).then(r => r.status + " " + JSON.stringify(null)).catch(e => "ERR " + e.message)'),
      };
      console.log('  DIAG ' + JSON.stringify(diag));
    }

    console.log('=== 2. 第二条连接（同一 token）建立 -> 页面连接必须被替换 ===');
    const extOpenPromise = new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 10000);
      const done = (v: boolean) => { clearTimeout(t); res(v); };
      ext = new WebSocket(WSURL + '?token=' + encodeURIComponent(token) + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION), { handshakeTimeout: 8000 });
      // 监听器必须与构造**同一 tick** 挂上：晚一步就漏掉 open/close（这正是本脚本以前卡住的原因）。
      ext.on('open', () => done(true));
      ext.on('error', (e) => { extError = String((e as Error).message ?? e); console.log('  外部连接错误：' + extError + '（URL=' + WSURL + '）'); done(false); });
      ext.on('message', (raw) => { extMsgs.push(JSON.parse(String(raw))); });
      ext.on('close', (code) => { extCloseCode = code; });
    });
    const extOpen = extSocket()?.readyState === WebSocket.OPEN || await extOpenPromise;
    ok(extOpen === true, '第二条连接建立成功（ws=' + WSURL + '）' + (extOpen ? '' : ' 错误=' + extError));
    if (!extOpen) { console.log('  跳过后续步骤：第二条连接没建立'); ws.close(); process.exit(1); }
    ok(extCloseCode === null, '第二条连接没有被服务端关闭');

    let replaced = false;
    for (let i = 0; i < 120 && !replaced; i += 1) {
      try { replaced = await page.evaluate('document.body.innerText.includes(' + JSON.stringify(REPLACED_TEXT) + ')'); } catch { /* 重试 */ }
      if (!replaced) await sleep(250);
    }
    ok(replaced === true, '页面被告知连接已被替换（显示“' + REPLACED_TEXT + '”）');

    console.log('=== 3. 页面不得自动重连（等 5 秒观察）===');
    ok(wsCreated.length >= 1, '已观测到页面自身的 WebSocket 连接（' + wsCreated.length + ' 条：' + wsCreated.join(', ') + '）');
    // S04：握手 URL 里不得出现任何会话凭据（session token / 一次性票据都不行）。
    const credentialInUrl = wsCreated.filter((u) => /[?&](token|ticket|sid|session)=/i.test(u));
    ok(credentialInUrl.length === 0, '页面 WebSocket URL 里没有任何凭据参数（S04）' + (credentialInUrl.length ? ' → ' + JSON.stringify(credentialInUrl) : ''));
    const socketsAtReplace = wsCreated.length;
    const framesAtReplace = framesSent.length;
    await sleep(5000);
    const newSockets = wsCreated.slice(socketsAtReplace);
    const newFrames = framesSent.slice(framesAtReplace);
    ok(newSockets.length === 0, '替换后页面没有新建 WebSocket（新建数=' + newSockets.length + (newSockets.length ? ' → ' + JSON.stringify(newSockets) : '') + '）');
    ok(!newFrames.some((s) => s.includes('queue.join')), '替换后页面没有再次发送 queue.join（否则两个标签页会无限互相顶号）');
    ok(newFrames.length === 0, '替换后页面没有发出任何 WebSocket 帧（发送数=' + newFrames.length + '）');
    const stillText = String(await page.evaluate('document.body.innerText'));
    ok(stillText.includes(REPLACED_TEXT), '页面仍停留在“已被替换”的状态');
    ok(!/正在寻找对手/.test(stillText), '页面不再显示“正在寻找对手”（断开后不再假装还在匹配）');

    console.log('=== 4. 存活的那条连接可用（能入队并收到广播）===');
    extSocket()!.send(JSON.stringify({ type: 'queue.join' }));
    let joined: any = null;
    for (let i = 0; i < 60 && !joined; i += 1) { joined = extMsgs.find((m) => m.type === 'queue.joined') ?? null; if (!joined) await sleep(150); }
    ok(!!joined, '第二条连接能入队（收到 queue.joined）');
    ok(!!joined && Number(joined.timeoutMs) === 20000, '排队窗口仍是 20 秒（实际 ' + (joined && joined.timeoutMs) + '）');

    console.log('=== 截图 ===');
    const shot = await page.shot(join(OUT, 'multitab-page-replaced.png'));
    ok(shot.width === 1440 && shot.height === 900, '页面截图 1440x900（' + shot.bytes + ' bytes）');
    ws.close();
  } finally {
    try { extSocket()?.close(); } catch { /* noop */ }
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  console.log('MULTITAB BROWSER CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
