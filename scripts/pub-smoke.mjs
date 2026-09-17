// Public production smoke test — runs against the real https://api.srszq.com edge.
// Verifies: register/tutorial, paginated ranking, authenticated WSS, 60s AI fill,
// 30s turn TIMEOUT forfeit (W10 clock), and active PLAYER_FORFEIT.
const API = process.env.SRSZQ_API_URL || 'https://api.srszq.com';
const WS = process.env.SRSZQ_WS_URL || 'wss://api.srszq.com/ws';
const ts = Date.now().toString(36);

import { WebSocket } from 'ws';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  [${e instanceof Error ? e.message : String(e)}]`); }
};

async function register(tag) {
  const r = await fetch(`${API}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `qa.${tag}.${ts}@srszq.test`, username: `QA_${tag}_${ts}`, password: 'qa-secret-1' }),
  });
  const j = await r.json();
  if (!r.ok || !j.token) throw new Error(`register ${tag}: ${r.status} ${JSON.stringify(j)}`);
  const t = await fetch(`${API}/api/tutorial/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${j.token}` }, body: '{}',
  });
  const tj = await t.json();
  if (!tj.user?.tutorialCompleted) throw new Error(`tutorial ${tag}: ${JSON.stringify(tj)}`);
  return { token: j.token, user: j.user };
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

async function waitFor(msgs, type, timeoutMs, since = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const found = msgs.slice(since).find((m) => m.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${type}`);
}

async function joinAndStart(token, msgs) {
  const { ws } = await connect(token);
  ws.send(JSON.stringify({ type: 'queue.join' }));
  const joined = await waitFor(msgs, 'queue.joined', 10000);
  const start = await waitFor(msgs, 'game.start', 70000); // real 60s deadline + AI fill
  return { ws, joined, start };
}

function seatInfo(start) {
  const seats = start.seats ?? {};
  const humans = Object.entries(seats).filter(([, s]) => s.kind === 'human');
  const ais = Object.entries(seats).filter(([, s]) => s.kind === 'ai');
  return { humans: humans.length, ais: ais.length, boardSize: start.state?.boardSize, mySeat: start.yourSeat, hasQualification: !!start.qualification };
}

await check('public register + tutorial + paginated ranking', async () => {
  const a = await register('A');
  const r = await fetch(`${API}/api/ranking?limit=5&offset=0`);
  const j = await r.json();
  if (!r.ok) throw new Error(`ranking ${r.status}`);
  if (typeof j.total !== 'number' || !Array.isArray(j.ranking) || j.ranking.length > 5) throw new Error(`ranking shape: ${JSON.stringify(j).slice(0, 120)}`);
  // Walk pages (default rating users may not sit on the final page if other
  // QA users lost games and dropped below the default rating).
  let found = false;
  for (let offset = 0; offset < j.total && !found; offset += 50) {
    const page = await fetch(`${API}/api/ranking?limit=50&offset=${offset}`).then((x) => x.json());
    if (page.ranking.some((u) => u.username === a.user.username)) found = true;
  }
  if (!found) throw new Error('QA user missing from ranking pages');
  console.log(`     ranking total=${j.total} limit=${j.limit} offset=${j.offset}`);
});

await check('60s AI fill -> game.start with BAC + seats (user TIMEOUT)', async () => {
  const { token } = await register('T');
  const { ws, msgs, joined, start } = await connect(token).then(async ({ ws, msgs }) => {
    ws.send(JSON.stringify({ type: 'queue.join' }));
    return { ws, msgs, joined: await waitFor(msgs, 'queue.joined', 10000), start: await waitFor(msgs, 'game.start', 70000) };
  });
  const info = seatInfo(start);
  if (info.ais !== 2 || info.humans !== 1 || info.boardSize !== 13 || !info.hasQualification) throw new Error(`start: ${JSON.stringify(info)}`);
  console.log(`     start seats: 1H+2AI board=${info.boardSize} mySeat=${info.mySeat} deadlineMs=${joined.timeoutMs}`);
  // Wait until it is my turn (turnDeadlineAt present) — AIs move in ~350ms each.
  let myDeadline = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const last = [...msgs].reverse().find((m) => m.type === 'game.state' || m.type === 'game.start');
    if (last && last.turnDeadlineAt) { myDeadline = Number(last.turnDeadlineAt); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!myDeadline) throw new Error('never reached my turn with a deadline');
  console.log(`     my turn deadline at ${new Date(myDeadline).toISOString()} — waiting for TIMEOUT forfeit…`);
  const end = await waitFor(msgs, 'MATCH_ENDED', 45000);
  if (end.reason !== 'TIMEOUT') throw new Error(`expected TIMEOUT, got ${end.reason}`);
  ws.close();
});

await check('active leave -> PLAYER_FORFEIT', async () => {
  const { token } = await register('F');
  const { ws, msgs } = await connect(token);
  ws.send(JSON.stringify({ type: 'queue.join' }));
  await waitFor(msgs, 'queue.joined', 10000);
  const start = await waitFor(msgs, 'game.start', 70000);
  const info = seatInfo(start);
  if (info.ais !== 2 || info.humans !== 1) throw new Error(`start: ${JSON.stringify(info)}`);
  ws.send(JSON.stringify({ type: 'PLAYER_RESIGN' }));
  const end = await waitFor(msgs, 'MATCH_ENDED', 10000);
  if (end.reason !== 'PLAYER_FORFEIT') throw new Error(`expected PLAYER_FORFEIT, got ${end.reason}`);
  ws.close();
});

console.log(failures === 0 ? 'PUBLIC SMOKE: ALL PASS' : `PUBLIC SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
