/** Current-product browser acceptance for the interaction-polish patch. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const SITE = argOf('--site', 'http://127.0.0.1:4173');
const API = argOf('--api', 'http://127.0.0.1:8080');
const OUT = argOf('--out', 'evidence/ui-polish');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync)!;
const PORT_BASE = 10_000 + Math.floor(Math.random() * 20_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (condition: boolean, label: string) => { console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}`); if (!condition) failures += 1; };

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly exceptions: string[] = [];
  constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id && this.pending.has(message.id)) {
        const promise = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(JSON.stringify(message.params));
    });
  }
  send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.id;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method)); }, 30_000);
    });
  }
  async eval(expression: string) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(result.exceptionDetails).slice(0, 300));
    return result.result?.value;
  }
  async waitFor(selector: string, timeoutMs = 20_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await sleep(120);
    }
    return false;
  }
  async screenshot(path: string) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const bytes = Buffer.from(result.data, 'base64');
    writeFileSync(path, bytes);
    return { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
}

type Account = { token: string; user: Record<string, unknown>; username: string };
async function request(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
async function account(prefix: string): Promise<Account> {
  const username = (prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).slice(0, 16);
  const registration = await request('POST', '/api/register', { email: username.toLowerCase() + '@ui.local', username, password: 'Passw0rd!23' });
  if (registration.status !== 201) throw new Error('register failed: ' + JSON.stringify(registration));
  await request('POST', '/api/tutorial/complete', {}, registration.data.token);
  const me = await request('GET', '/api/me', undefined, registration.data.token);
  return { token: registration.data.token, user: me.data.user, username };
}

type Page = { proc: ChildProcess; cdp: Cdp; goto: (hash: string) => Promise<void>; close: () => void };
async function launch(port: number, auth: Account, width = 1440, height = 900): Promise<Page> {
  const profile = join(tmpdir(), `srszq-polish-${port}-${Date.now()}`);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=' + width + ',' + height, SITE + '/'], { stdio: 'ignore' });
  let tab: any = null;
  for (let i = 0; i < 100 && !tab; i += 1) {
    try { const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()) as any[]; tab = list.find((item) => item.type === 'page' && item.url.startsWith(new URL(SITE).origin)); } catch { /* wait */ }
    if (!tab) await sleep(150);
  }
  if (!tab) throw new Error('Edge CDP did not start on ' + port);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Page.navigate', { url: SITE + '/' });
  let originReady = false;
  for (let i = 0; i < 100 && !originReady; i += 1) {
    try { originReady = await cdp.eval(`location.origin === ${JSON.stringify(new URL(SITE).origin)} && document.readyState !== 'loading'`); } catch { /* navigation in progress */ }
    if (!originReady) await sleep(100);
  }
  if (!originReady) throw new Error('site origin did not become ready on port ' + port);
  await cdp.eval(`localStorage.setItem('srszq_token', ${JSON.stringify(auth.token)}); localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(auth.user))});`);
  const goto = async (hash: string) => { await cdp.send('Page.navigate', { url: SITE + '/#' + hash }); await sleep(900); };
  return { proc, cdp, goto, close: () => {
    ws.close();
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
  } };
}

async function clickText(page: Cdp, text: string) {
  return page.eval(`(() => { const button=[...document.querySelectorAll('button')].find((el)=>(el.textContent||'').includes(${JSON.stringify(text)})); if(!button)return false; button.click(); return true; })()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const pages: Page[] = [];
  try {
    console.log('=== Friends: two independent browser profiles ===');
    const sender = await account('send');
    const receiver = await account('recv');
    const a = await launch(PORT_BASE + 1, sender); pages.push(a);
    const b = await launch(PORT_BASE + 2, receiver); pages.push(b);
    await Promise.all([a.goto('/friends'), b.goto('/friends')]);
    check(await a.cdp.waitFor('.invite-form'), 'sender friends page rendered');
    await a.cdp.eval(`(() => { const el=document.querySelector('input[aria-label="受邀好友用户名"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(el, ${JSON.stringify(receiver.username)}); el.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.invite-form').requestSubmit(); })()`);
    check(await a.cdp.waitFor('.notice'), 'invite action shows a real completion message');
    const sentText = String(await a.cdp.eval(`document.querySelector('.notice')?.textContent || ''`));
    check(sentText.includes('邀请已发送'), 'invite success is based on the API result');
    await b.goto('/friends');
    const invitationVisible = await b.cdp.waitFor('.friend-row button', 8_000);
    check(invitationVisible, 'receiver sees the pending invitation');
    check(await clickText(b.cdp, '接受'), 'receiver activates Accept through the real UI');
    const accepted = await (async () => { for (let i = 0; i < 80; i += 1) { const text = String(await b.cdp.eval('document.body.innerText')); if (text.includes('已接受好友邀请') || text.includes('好友对弈')) return true; await sleep(100); } return false; })();
    check(accepted, 'accept result is visible or transitions to the friend game');

    a.close(); b.close(); pages.splice(0, 2);

    console.log('=== Online: three accounts, game.start, 30-second clock ===');
    const accounts = await Promise.all([account('qa'), account('qb'), account('qc')]);
    const trio = await Promise.all(accounts.map((auth, index) => launch(PORT_BASE + 11 + index, auth)));
    pages.push(...trio);
    await Promise.all(trio.map((page) => page.goto('/online')));
    const entered = await Promise.all(trio.map((page) => page.cdp.waitFor('.matchmaking-card, [data-testid="online-game"]', 5_000)));
    await Promise.all(trio.map((page, index) => entered[index] ? Promise.resolve() : page.goto('/online')));
    const started = await Promise.all(trio.map((page) => page.cdp.waitFor('[data-testid="online-game"]', 25_000)));
    check(started.every(Boolean), 'three real users receive game.start (queue ACK alone is not treated as a match)');
    const clock = await trio[0].cdp.eval(`(() => { const timer=document.querySelector('[role="timer"]'); const n=Number((timer?.textContent||'').replace(/[^0-9]/g,'')); return {exists:!!timer,seconds:n}; })()`);
    check(clock.exists && clock.seconds > 0 && clock.seconds <= 30, 'online move clock is present and capped at 30 seconds');
    const onlineShot = await trio[0].cdp.screenshot(join(OUT, 'desktop-online-three-account.png'));
    check(onlineShot.width === 1440 && onlineShot.height === 900, 'desktop three-account match screenshot is 1440x900');

    console.log('=== Native dialog: focus, Escape, blocked board ===');
    check(await clickText(trio[0].cdp, '退出对局'), 'open exit confirmation');
    check(await trio[0].cdp.waitFor('dialog[open]'), 'native modal is open');
    const modal = await trio[0].cdp.eval(`(() => ({focus:document.activeElement?.textContent?.trim(),cancel:document.activeElement?.hasAttribute('data-dialog-cancel'),open:document.querySelector('dialog')?.open===true}))()`);
    check(modal.open && modal.cancel === true && String(modal.focus).includes('继续对局'), 'cancel button receives initial focus');
    const modalShot = await trio[0].cdp.screenshot(join(OUT, 'desktop-exit-confirmation.png'));
    check(modalShot.width === 1440 && modalShot.height === 900, 'modal screenshot is 1440x900');
    const before = await trio[0].cdp.eval(`document.querySelectorAll('.go-point[data-piece]:not([data-piece=""])').length`);
    const point = await trio[0].cdp.eval(`(() => { const el=document.querySelector('.go-point[data-piece=""]'); if(!el)return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    if (point) {
      await trio[0].cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await trio[0].cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    const after = await trio[0].cdp.eval(`document.querySelectorAll('.go-point[data-piece]:not([data-piece=""])').length`);
    check(before === after, 'board cannot be activated through the open modal');
    if (!(await trio[0].cdp.eval(`!!document.querySelector('dialog[open]')`))) await clickText(trio[0].cdp, '退出对局');
    await trio[0].cdp.waitFor('dialog[open]');
    await trio[0].cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await trio[0].cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(250);
    check(!(await trio[0].cdp.eval(`!!document.querySelector('dialog[open]')`)), 'Escape closes the modal without exiting the game');

    console.log('=== Mobile and reduced motion ===');
    await trio[1].cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    const width = await trio[1].cdp.eval('document.documentElement.scrollWidth');
    const mobileShot = await trio[1].cdp.screenshot(join(OUT, 'mobile-online-three-account.png'));
    check(mobileShot.width === 390 && mobileShot.height === 844 && Number(width) <= 391, 'mobile match is 390x844 with no horizontal overflow');
    await trio[1].cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const motion = await trio[1].cdp.eval(`(() => { const el=document.querySelector('.sq-button'); const cs=getComputedStyle(el); return {animation:cs.animationDuration,transition:cs.transitionDuration}; })()`);
    check(motion.animation === '0.001ms' || motion.animation === '0s', 'reduced-motion disables continuous button animation');

    console.log('=== Current-product settings dialog ===');
    const settingsPage = await launch(PORT_BASE + 21, await account('set'));
    pages.push(settingsPage);
    await settingsPage.goto('/local');
    check(await clickText(settingsPage.cdp, '开始对局'), 'enter a real local game');
    check(await settingsPage.cdp.waitFor('[data-testid="local-game"]'), 'local game rendered');
    check(await clickText(settingsPage.cdp, '设置'), 'open board settings');
    check(await settingsPage.cdp.waitFor('dialog[open]'), 'settings modal is open');
    const settingsFocus = await settingsPage.cdp.eval(`document.activeElement?.hasAttribute('data-dialog-cancel') === true`);
    check(settingsFocus, 'settings Cancel receives initial focus');
    const settingsShot = await settingsPage.cdp.screenshot(join(OUT, 'desktop-settings-modal.png'));
    check(settingsShot.width === 1440 && settingsShot.height === 900, 'settings modal screenshot is 1440x900');

    check(pages.every((page) => page.cdp.exceptions.length === 0), 'all tested pages have zero uncaught runtime exceptions');
    writeFileSync(join(OUT, 'BROWSER_RESULTS.json'), JSON.stringify({ status: failures === 0 ? 'PASS' : 'FAIL', failures, testedAt: new Date().toISOString(), site: SITE, api: API, clock, modal, motion }, null, 2));
  } finally {
    for (const page of pages) page.close();
  }
  console.log(`UI POLISH BROWSER CHECK: ${failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error('FATAL', error); process.exit(1); });
