// Real local acceptance for the four shared match modes. Uses isolated Edge
// profiles, the local API, real SQLite, and the real WebSocket game server.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONT = process.env.SRSZQ_FRONTEND_URL ?? 'http://127.0.0.1:5173';
const API = process.env.SRSZQ_API_URL ?? 'http://127.0.0.1:8080';
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve(process.argv[2] ?? 'results/fourmode-20261115');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async waitFor(expression, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return true;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
  async shotFull(name) {
    const metrics = await this.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
    });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

class EdgeSession {
  constructor(label, port, width = 1440, height = 900) {
    this.label = label;
    this.port = port;
    this.width = width;
    this.height = height;
  }
  async start() {
    const profile = path.join(os.tmpdir(), `srszq-fourmode-${this.label}-${process.pid}-${this.port}`);
    fs.rmSync(profile, { recursive: true, force: true });
    this.process = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${profile}`,
      `--window-size=${this.width},${this.height}`, FRONT,
    ], { stdio: 'ignore' });
    let wsUrl = '';
    const deadline = Date.now() + 20_000;
    while (!wsUrl && Date.now() < deadline) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((item) => item.type === 'page' && item.url.startsWith(FRONT));
        wsUrl = page?.webSocketDebuggerUrl ?? '';
      } catch {}
    }
    if (!wsUrl) throw new Error(`Cannot connect ${this.label} browser`);
    this.cdp = new Cdp(wsUrl);
    await this.cdp.open();
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');
    await this.cdp.send('Page.navigate', { url: FRONT });
    await sleep(300);
    await this.cdp.waitFor(`document.readyState === 'complete'`);
    await this.cdp.waitFor(`location.origin === ${JSON.stringify(new URL(FRONT).origin)}`);
    return this;
  }
  async authenticate(account) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.cdp.eval(`(() => {
        localStorage.setItem('srszq_token', ${JSON.stringify(account.token)});
        localStorage.setItem('srszq_user', ${JSON.stringify(JSON.stringify(account.user))});
        return true;
      })()`);
      const lobbyUrl = new URL(FRONT);
      lobbyUrl.searchParams.set('authAttempt', `${Date.now()}-${attempt}`);
      lobbyUrl.hash = '/lobby';
      await this.cdp.send('Page.navigate', { url: lobbyUrl });
      await sleep(800);
      try {
        await this.cdp.waitFor(`document.body.innerText.includes('大厅')`, 12_000);
        return;
      } catch (error) {
        if (attempt === 2) {
          const state = await this.cdp.eval(`({ hash: location.hash, body: document.body.innerText, token: !!localStorage.getItem('srszq_token'), user: localStorage.getItem('srszq_user') })`);
          throw new Error(`Authentication page did not reach lobby: ${JSON.stringify(state)}`, { cause: error });
        }
      }
    }
  }
  async route(hash) {
    await this.cdp.eval(`location.hash = ${JSON.stringify(hash)}; location.reload(); true`);
    await sleep(600);
    await this.cdp.waitFor(`document.readyState === 'complete'`);
  }
  async clickText(selector, text) {
    return this.cdp.eval(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => (node.textContent || '').includes(${JSON.stringify(text)}));
      if (!element) return false;
      element.click();
      return true;
    })()`);
  }
  async setViewport(width, height, mobile = false) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile,
      screenWidth: width, screenHeight: height,
    });
    await sleep(250);
  }
  async shot(name) {
    return this.cdp.shot(name);
  }
  async shotFull(name) {
    return this.cdp.shotFull(name);
  }
  async stop() {
    this.cdp?.close();
    if (this.process && !this.process.killed) this.process.kill();
  }
}

async function register(suffix) {
  const password = 'secret123';
  const email = `fourmode-${stamp}-${suffix}@example.com`;
  const username = `Four${stamp}${suffix}`;
  const response = await fetch(`${API}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, username, password }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  const tutorial = await fetch(`${API}/api/tutorial/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const tutorialBody = await tutorial.json();
  if (!tutorial.ok) throw new Error(JSON.stringify(tutorialBody));
  return { token: body.token, user: tutorialBody.user, username, password };
}

async function startLocal(session, hash, screenshot) {
  await session.route(hash);
  await session.cdp.waitFor(`document.querySelector('.setup-card') !== null`);
  await session.clickText('.setup-bottom button', '开始对局');
  await session.cdp.waitFor(`document.querySelector('[data-testid="four-mode-local"]') !== null || document.querySelector('[data-testid="four-mode-vsai"]') !== null`);
  await sleep(500);
  return session.shot(screenshot);
}

async function startAstra(session, screenshot) {
  await session.route('#/vsai');
  await session.cdp.waitFor(`document.querySelectorAll('.seat-config select').length === 3`);
  for (const index of [1, 2]) {
    await session.cdp.eval(`(() => {
      const select = document.querySelectorAll('.seat-config select')[${index}];
      select.value = 'astra';
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    })()`);
    await sleep(250);
  }
  await session.cdp.waitFor(`document.querySelectorAll('.seat-config select')[1].value === 'astra' && document.querySelectorAll('.seat-config select')[2].value === 'astra'`);
  const before = await session.cdp.eval(`(() => {
    const button = document.querySelector('.setup-bottom .btn.primary');
    return { disabled: button?.disabled, text: button?.textContent, values: [...document.querySelectorAll('.seat-config select')].map((select) => select.value) };
  })()`);
  if (before.disabled) throw new Error(`Astra setup remained disabled: ${JSON.stringify(before)}`);
  await session.cdp.eval(`document.querySelector('.setup-bottom .btn.primary').click(); true`);
  await sleep(1_000);
  const after = await session.cdp.eval(`({ hash: location.hash, body: document.body.innerText, hasVsai: document.querySelector('[data-testid="four-mode-vsai"]') !== null })`);
  if (!after.hasVsai) throw new Error(`Astra match did not start: ${JSON.stringify(after)}`);
  await session.cdp.waitFor(`document.body.innerText.includes('Astra')`);
  await sleep(500);
  return session.shot(screenshot);
}

async function waitForGame(session) {
  await session.cdp.waitFor(`document.querySelector('[data-testid="four-mode-online"]') !== null || document.querySelector('[data-testid="four-mode-invite"]') !== null`, 35_000);
  await sleep(500);
}

async function mobileModeCheck(session) {
  return session.cdp.eval(`(() => {
    const board = document.querySelector('.four-mode-board-column')?.getBoundingClientRect();
    const chat = document.querySelector('.four-mode-chat-column')?.getBoundingClientRect();
    const seats = document.querySelector('.chat-seat-row');
    return {
      width: innerWidth,
      height: innerHeight,
      sharedLayout: document.querySelector('.four-mode-shell') !== null,
      seatColumns: seats ? getComputedStyle(seats).gridTemplateColumns : null,
      boardBeforeChat: Boolean(board && chat && board.top < chat.top),
      hasChat: document.body.innerText.includes('局内聊天')
    };
  })()`);
}

async function sendChat(session, text) {
  return session.cdp.eval(`(() => {
    const textarea = document.querySelector('.chat-composer textarea');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  const report = {
    capturedAt: new Date().toISOString(),
    frontend: FRONT,
    api: API,
    screenshots: {},
    checks: {},
    notes: [],
  };
  const accountA = await register('A');
  const accountB = await register('B');
  const sessions = [];
  try {
    const single = await new EdgeSession('single', 9355).start();
    sessions.push(single);
    await single.authenticate(accountA);
    await single.setViewport(1440, 900, false);
    report.screenshots.localDesktop = await startLocal(single, '#/local', '01-local-desktop-1440.png');
    report.checks.localDesktop = await single.cdp.eval(`document.querySelector('[data-testid="four-mode-local"]') !== null`);

    report.screenshots.vsaiAstraDesktop = await startAstra(single, '02-vsai-astra-desktop-1440.png');
    report.checks.astraVisible = await single.cdp.eval(`document.body.innerText.includes('Astra') && document.body.innerText.includes('局内聊天')`);
    await single.setViewport(390, 844, true);
    report.screenshots.vsaiAstraMobile390 = await single.shotFull('12-vsai-astra-mobile-390x844.png');
    report.checks.vsaiAstraMobile390 = await mobileModeCheck(single);
    await single.setViewport(360, 800, true);
    report.screenshots.vsaiAstraMobile360 = await single.shotFull('13-vsai-astra-mobile-360x800.png');
    report.checks.vsaiAstraMobile360 = await mobileModeCheck(single);

    await single.route('#/local');
    await single.setViewport(390, 844, true);
    await single.cdp.waitFor(`document.querySelector('.setup-card') !== null`);
    await single.clickText('.setup-bottom button', '开始对局');
    await single.cdp.waitFor(`document.querySelector('[data-testid="four-mode-local"]') !== null`);
    await sleep(350);
    report.screenshots.localMobile390 = await single.shotFull('03-local-mobile-390x844.png');
    report.checks.mobile390 = await single.cdp.eval(`({
      width: innerWidth,
      height: innerHeight,
      seatColumns: getComputedStyle(document.querySelector('.chat-seat-row')).gridTemplateColumns,
      boardBeforeChat: document.querySelector('.four-mode-board-column').getBoundingClientRect().top < document.querySelector('.four-mode-chat-column').getBoundingClientRect().top
    })`);
    await single.setViewport(390, 420, true);
    await single.cdp.eval(`(() => {
      const textarea = document.querySelector('.chat-composer textarea');
      textarea.scrollIntoView({ block: 'center' });
      textarea.focus();
      return true;
    })()`);
    await sleep(250);
    report.checks.mobileKeyboard = await single.cdp.eval(`(() => {
      const rect = document.querySelector('.chat-composer').getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        focused: document.activeElement === document.querySelector('.chat-composer textarea'),
        composerTop: rect.top,
        composerBottom: rect.bottom,
        visible: rect.top >= 0 && rect.bottom <= innerHeight + 1
      };
    })()`);
    report.screenshots.localKeyboard390x420 = await single.shot('04-local-keyboard-sim-390x420.png');
    await single.setViewport(360, 800, true);
    await single.route('#/local');
    await single.cdp.waitFor(`document.querySelector('.setup-card') !== null`);
    await single.clickText('.setup-bottom button', '开始对局');
    await single.cdp.waitFor(`document.querySelector('[data-testid="four-mode-local"]') !== null`);
    await sleep(250);
    report.screenshots.localMobile360 = await single.shotFull('05-local-mobile-360x800.png');
    await single.stop();
    sessions.pop();

    const alice = await new EdgeSession('online-a', 9356).start();
    const bob = await new EdgeSession('online-b', 9357).start();
    sessions.push(alice, bob);
    await Promise.all([alice.authenticate(accountA), bob.authenticate(accountB)]);
    await Promise.all([alice.setViewport(1440, 900, false), bob.setViewport(1440, 900, false)]);
    await Promise.all([alice.route('#/online'), bob.route('#/online')]);
    await Promise.all([waitForGame(alice), waitForGame(bob)]);
    report.screenshots.onlineAlice = await alice.shot('06-online-alice-1440.png');
    report.screenshots.onlineBob = await bob.shot('07-online-bob-1440.png');
    const chatText = `两账号真实聊天 ${stamp}`;
    await sendChat(alice, chatText);
    await alice.clickText('.chat-send', '发送');
    await Promise.all([
      alice.cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(chatText)})`, 8_000),
      bob.cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(chatText)})`, 8_000),
    ]);
    report.checks.onlineChatBothAccounts = true;
    await alice.cdp.eval(`document.querySelector('button[aria-label="表情与原创贴纸"]').click(); true`);
    await alice.cdp.waitFor(`document.querySelector('.emoji-picker') !== null`);
    report.checks.emojiStickerCatalog = await alice.cdp.eval(`({
      emojiCount: document.querySelectorAll('.emoji-picker .emoji-row button').length,
      stickerCount: document.querySelectorAll('.emoji-picker .sticker-row button').length
    })`);
    report.screenshots.emojiStickerPanel = await alice.shot('18-emoji-sticker-panel.png');
    await alice.cdp.eval(`document.querySelector('.emoji-picker .emoji-row button').click(); true`);
    report.checks.emojiInserted = await alice.cdp.eval(`document.querySelector('.chat-composer textarea').value.includes('😎')`);
    await sendChat(alice, '');
    await sleep(1_700);
    await alice.clickText('.emoji-picker .sticker-row button', '放马过来');
    await Promise.all([
      alice.cdp.waitFor(`document.body.innerText.includes('放马过来')`, 8_000),
      bob.cdp.waitFor(`document.body.innerText.includes('放马过来')`, 8_000),
    ]);
    report.checks.stickerDeliveredBothAccounts = true;
    await sleep(1_700);
    await alice.cdp.eval(`(() => {
      const label = [...document.querySelectorAll('.chat-settings label')].find((node) => node.textContent.includes('趣味改写'));
      const checkbox = label?.querySelector('input[type="checkbox"]');
      if (!checkbox) return false;
      checkbox.click();
      return true;
    })()`);
    await sendChat(alice, '趣味改写真实验收');
    await alice.clickText('.chat-send', '发送');
    await alice.cdp.waitFor(`document.querySelector('.rewrite-preview') !== null`, 8_000);
    report.checks.rewritePreview = await alice.cdp.eval(`({
      original: document.querySelector('.rewrite-preview p')?.textContent === '趣味改写真实验收',
      fallbackLabel: document.querySelector('.rewrite-preview small')?.textContent === '模型不可用，原文可用',
      hasConfirm: [...document.querySelectorAll('.rewrite-actions button')].some((node) => node.textContent.includes('确认发送')),
      hasOriginal: [...document.querySelectorAll('.rewrite-actions button')].some((node) => node.textContent.includes('发送原文')),
      hasCancel: [...document.querySelectorAll('.rewrite-actions button')].some((node) => node.textContent.includes('取消'))
    })`);
    report.screenshots.rewritePreview = await alice.shot('19-rewrite-preview-fallback.png');
    await alice.clickText('.rewrite-actions button', '发送原文');
    await Promise.all([
      alice.cdp.waitFor(`document.body.innerText.includes('趣味改写真实验收')`, 8_000),
      bob.cdp.waitFor(`document.body.innerText.includes('趣味改写真实验收')`, 8_000),
    ]);
    report.checks.rewriteFallbackDeliveredBothAccounts = true;
    report.screenshots.onlineChatAlice = await alice.shot('08-online-chat-alice.png');
    report.screenshots.onlineChatBob = await bob.shot('09-online-chat-bob.png');
    await alice.setViewport(390, 844, true);
    report.screenshots.onlineChatMobile390 = await alice.shotFull('14-online-chat-mobile-390x844.png');
    report.checks.onlineChatMobile390 = await mobileModeCheck(alice);
    await alice.setViewport(360, 800, true);
    report.screenshots.onlineChatMobile360 = await alice.shotFull('15-online-chat-mobile-360x800.png');
    report.checks.onlineChatMobile360 = await mobileModeCheck(alice);
    await Promise.all([alice.stop(), bob.stop()]);
    sessions.splice(0, sessions.length);

    const inviter = await new EdgeSession('invite-a', 9358).start();
    const invitee = await new EdgeSession('invite-b', 9359).start();
    sessions.push(inviter, invitee);
    await Promise.all([inviter.authenticate(accountA), invitee.authenticate(accountB)]);
    await Promise.all([inviter.setViewport(1440, 900, false), invitee.setViewport(1440, 900, false)]);
    await sleep(800);
    const inviteResponse = await fetch(`${API}/api/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accountA.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toUsername: accountB.username }),
    });
    const inviteBody = await inviteResponse.json();
    if (!inviteResponse.ok) throw new Error(JSON.stringify(inviteBody));
    const acceptResponse = await fetch(`${API}/api/invite/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accountB.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: inviteBody.invitation.id }),
    });
    if (!acceptResponse.ok) throw new Error(await acceptResponse.text());
    await Promise.all([waitForGame(inviter), waitForGame(invitee)]);
    report.checks.inviteUsesSharedLayout = await inviter.cdp.eval(`document.querySelector('[data-testid="four-mode-invite"]') !== null`);
    report.screenshots.inviteHost = await inviter.shot('10-invite-host-1440.png');
    report.screenshots.inviteGuest = await invitee.shot('11-invite-guest-1440.png');
    await inviter.setViewport(390, 844, true);
    report.screenshots.inviteMobile390 = await inviter.shotFull('16-invite-mobile-390x844.png');
    report.checks.inviteMobile390 = await mobileModeCheck(inviter);
    await inviter.setViewport(360, 800, true);
    report.screenshots.inviteMobile360 = await inviter.shotFull('17-invite-mobile-360x800.png');
    report.checks.inviteMobile360 = await mobileModeCheck(inviter);
  } finally {
    for (const session of sessions) {
      try { await session.stop(); } catch {}
    }
  }
  fs.writeFileSync(path.join(OUT, 'BROWSER_ACCEPTANCE.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
