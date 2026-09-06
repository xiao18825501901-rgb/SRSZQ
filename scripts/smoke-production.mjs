import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const base = process.env.SRSZQ_API_URL ?? 'http://127.0.0.1:8080';
const nginxUrl = process.env.SRSZQ_NGINX_URL ?? 'http://127.0.0.1:9080';
const wsUrl = process.env.SRSZQ_WS_URL ?? 'ws://127.0.0.1:8081/ws';
const wsHost = process.env.SRSZQ_WS_HOST;
const databasePath = process.env.SRSZQ_DB_PATH ?? '/var/www/SRSZQ/data/srszq.sqlite';
async function request(path, body, token) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: await res.json() };
}
async function ready() {
  for (let n = 0; n < 30; n++) {
    try {
      const res = await request('/');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not found: GET /');
      return;
    } catch (error) {
      if (n === 29) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

async function authenticatedWebSocket(token, expectedUserId) {
  const authenticatedUrl = new URL(wsUrl);
  authenticatedUrl.searchParams.set('token', token);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(authenticatedUrl, {
      handshakeTimeout: 5000,
      ...(wsHost ? { headers: { Host: wsHost } } : {}),
    });
    const timer = setTimeout(() => { ws.terminate(); reject(Error('authenticated WS timeout')); }, 7000);
    ws.on('error', error => { clearTimeout(timer); reject(error); });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        assert.equal(message.type, 'hello');
        assert.equal(message.user.id, expectedUserId);
        clearTimeout(timer); ws.close(); resolve();
      } catch (error) { clearTimeout(timer); ws.terminate(); reject(error); }
    });
  });
}
await ready();
console.log('API PASS: loopback API returned the expected JSON response');
await new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl, {
    handshakeTimeout: 5000,
    ...(wsHost ? { headers: { Host: wsHost } } : {}),
  });
  const timer = setTimeout(() => { ws.terminate(); reject(Error('WS timeout')); }, 7000);
  ws.on('error', error => { clearTimeout(timer); reject(error); });
  ws.on('message', raw => {
    try {
      const message = JSON.parse(String(raw));
      assert.equal(message.error, 'unauthorized');
      clearTimeout(timer); ws.close(); resolve();
    } catch (error) { clearTimeout(timer); ws.terminate(); reject(error); }
  });
});
console.log(`WS PASS: ${wsUrl} upgraded and rejected an unauthenticated client`);

const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }));
const backend = processes.find(process => process.name === 'srszq-backend');
assert.equal(backend?.pm2_env?.status, 'online');
console.log('PM2 PASS: srszq-backend is online');

const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
try {
  assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.ok(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count > 0);
} finally {
  database.close();
}
console.log(`DB PASS: ${databasePath} is readable and passes quick_check`);

execFileSync('sudo', ['-n', 'nginx', '-t'], { stdio: 'ignore' });
const nginxResponse = await fetch(nginxUrl + '/', {
  headers: { Host: 'api.srszq.com' },
  signal: AbortSignal.timeout(5000),
});
assert.equal(nginxResponse.status, 404);
assert.equal((await nginxResponse.json()).error, 'not found: GET /');
console.log('NGINX PASS: configuration is valid and the HTTP reverse proxy reaches the API');

if (process.argv.includes('--persistence')) {
  const suffix = randomBytes(6).toString('hex');
  const account = { email: `release-${suffix}@example.invalid`, username: `qa${suffix}`, password: randomBytes(24).toString('base64url') };
  const registered = await request('/api/register', account);
  assert.equal(registered.status, 201);
  const userId = registered.body.user.id;
  assert.equal((await request('/api/me', undefined, registered.body.token)).body.user.id, userId);
  const loginBody = { account: account.email, password: account.password };
  assert.equal((await request('/api/login', loginBody)).status, 200);
  execFileSync('pm2', ['restart', 'srszq-backend'], { stdio: 'ignore' });
  await ready();
  const loggedIn = await request('/api/login', loginBody);
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.user.id, userId);
  // The original session must also persist across the process restart.
  assert.equal((await request('/api/me', undefined, registered.body.token)).body.user.id, userId);
  await authenticatedWebSocket(loggedIn.body.token, userId);
  console.log('PASS registration, login, session persistence and authenticated WebSocket after PM2 restart');
}
