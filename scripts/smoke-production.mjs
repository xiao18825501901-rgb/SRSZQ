import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

const base = 'http://127.0.0.1:8080';
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
await ready();
console.log('PASS API readiness (expected JSON 404)');
await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1/ws', { handshakeTimeout: 5000 });
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
console.log('PASS Nginx WS upgrade and unauthenticated rejection');

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
  console.log('PASS registration, login and original session after PM2 restart; synthetic QA account retained');
}
