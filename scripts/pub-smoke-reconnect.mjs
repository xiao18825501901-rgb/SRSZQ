// Public production disconnect-grace test over wss://api.srszq.com/ws.
// 3H game -> A's socket drops and resumes within grace (game survives) ->
// A drops again past the 10s grace -> PLAYER_DISCONNECT forfeit for all.
import { WebSocket } from 'ws';

const API = process.env.SRSZQ_API_URL || 'https://api.srszq.com';
const WS = process.env.SRSZQ_WS_URL || 'wss://api.srszq.com/ws';
const ts = Date.now().toString(36);
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}  [${e.message}]`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(tag) {
  const r = await fetch(`${API}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `qa.${tag}.${ts}@srszq.test`, username: `QA_${tag}_${ts}`, password: 'qa-secret-1' }) });
  const j = await r.json();
  if (!j.token) throw new Error('register failed');
  await fetch(`${API}/api/tutorial/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${j.token}` }, body: '{}' });
  return j.token;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${token}`);
    const msgs = [];
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('message', (raw) => { try { msgs.push(JSON.parse(String(raw))); } catch {} });
    ws.on('error', (e) => reject(new Error('ws error: ' + (e.message || 'connect failed'))));
    setTimeout(() => reject(new Error('ws connect timeout')), 15000);
  });
}
async function waitFor(msgs, type, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const found = msgs.find((m) => m.type === type);
    if (found) return found;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${type}`);
}

await check('disconnect grace: resume keeps the game, late drop forfeits', async () => {
  const tokens = await Promise.all(['g1', 'g2', 'g3'].map(register));
  const clients = await Promise.all(tokens.map(connect));
  const a = clients[0], b = clients[1], c = clients[2];
  try {
    clients.forEach((x) => x.ws.send(JSON.stringify({ type: 'queue.join' })));
    const starts = await Promise.all(clients.map((x) => waitFor(x.msgs, 'game.start', 10000)));
    const aSeat = starts[0].yourSeat;
    const gameId = starts[0].gameId;

    // A drops and resumes within grace.
    const token = tokens[0];
    a.ws.close();
    await sleep(1200);
    const again = await connect(token);
    again.ws.send(JSON.stringify({ type: 'resume', gameId }));
    const resumed = await waitFor(again.msgs, 'game.start', 5000);
    if (resumed.gameId !== gameId) throw new Error('resume wrong game');
    // No forfeit for anyone while resumed.
    await sleep(1500);
    if (b.msgs.some((m) => m.type === 'MATCH_ENDED') || c.msgs.some((m) => m.type === 'MATCH_ENDED')) throw new Error('forfeit fired during grace resume');
    console.log(`     A(${aSeat}) resumed in grace; game survived`);

    // A drops again and stays away past the 10s grace.
    again.ws.close();
    await Promise.all([b, c].map(async (x) => {
      const end = await waitFor(x.msgs, 'MATCH_ENDED', 20000);
      if (end.reason !== 'PLAYER_DISCONNECT') throw new Error(`reason ${end.reason}`);
    }));
    console.log('     late drop -> PLAYER_DISCONNECT to both remaining clients');
  } finally {
    clients.forEach((x) => { try { x.ws.close(); } catch {} });
  }
});

console.log(failures === 0 ? 'RECONNECT CHECK: ALL PASS' : `RECONNECT CHECK: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
