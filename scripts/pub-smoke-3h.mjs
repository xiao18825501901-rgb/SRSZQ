// Public production 3-human online game test over wss://api.srszq.com/ws.
// Three fresh QA users join the queue -> immediate 3H room -> each plays a legal
// move in turn -> authoritative broadcasts -> A resigns -> PLAYER_FORFEIT for all.
import { WebSocket } from 'ws';

const API = process.env.SRSZQ_API_URL || 'https://api.srszq.com';
const WS = process.env.SRSZQ_WS_URL || 'wss://api.srszq.com/ws';
const ts = Date.now().toString(36);
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  [${e instanceof Error ? e.message : String(e)}]`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(tag) {
  const r = await fetch(`${API}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `qa.${tag}.${ts}@srszq.test`, username: `QA_${tag}_${ts}`, password: 'qa-secret-1' }),
  });
  const j = await r.json();
  if (!r.ok || !j.token) throw new Error(`register ${tag}: ${r.status} ${JSON.stringify(j)}`);
  await fetch(`${API}/api/tutorial/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${j.token}` }, body: '{}',
  });
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

await check('3H immediate match over public WSS', async () => {
  const tokens = await Promise.all(['h1', 'h2', 'h3'].map(register));
  const clients = await Promise.all(tokens.map(connect));
  try {
    clients.forEach((c) => c.ws.send(JSON.stringify({ type: 'queue.join' })));
    const starts = await Promise.all(clients.map((c) => waitFor(c.msgs, 'game.start', 10000)));
    if (!starts.every((s) => s.gameId === starts[0].gameId)) throw new Error('gameIds differ');
    const seats = starts.map((s) => s.yourSeat);
    if (new Set(seats).size !== 3) throw new Error(`seats not distinct: ${seats}`);
    if (!starts.every((s) => Object.values(s.seats).every((x) => x.kind === 'human'))) throw new Error('expected 3 humans');
    if (!starts.every((s) => s.qualification)) throw new Error('BAC qualification missing');
    console.log(`     gameId=${starts[0].gameId} seats=${seats.join('/')} board=${starts[0].state.boardSize}x${starts[0].state.boardSize}`);

    // Play 6 authoritative moves (two full rounds), each from the current player.
    const lastState = (c) => [...c.msgs].reverse().find((m) => m.type === 'game.state' || m.type === 'game.start');
    for (let i = 0; i < 6; i++) {
      await sleep(300);
      const order = ['A', 'B', 'C'];
      const expected = order[i % 3];
      const owner = clients.find((c) => starts[clients.indexOf(c)].yourSeat === expected);
      const st = lastState(owner);
      const board = st.state.board;
      const cell = board.flatMap((row, r) => row.map((v, col) => ({ r, col, v }))).find((x) => x.v === null);
      if (!cell) throw new Error('no empty cell');
      owner.ws.send(JSON.stringify({ type: 'move', row: cell.r, col: cell.col }));
      await sleep(300);
      for (const c of clients) {
        const s = lastState(c);
        if (s.state.moves.length !== i + 1) throw new Error(`client out of sync at move ${i + 1}: ${s.state.moves.length} moves`);
      }
    }
    console.log('     two full rounds broadcast to all three clients in sync');

    // Active leave: A resigns -> everyone receives PLAYER_FORFEIT.
    const a = clients[seats.indexOf('A')];
    a.ws.send(JSON.stringify({ type: 'PLAYER_RESIGN' }));
    await Promise.all(clients.map(async (c) => {
      const end = await waitFor(c.msgs, 'MATCH_ENDED', 8000);
      if (end.reason !== 'PLAYER_FORFEIT') throw new Error(`reason ${end.reason}`);
    }));
    console.log('     resign -> PLAYER_FORFEIT delivered to all three clients');
  } finally {
    clients.forEach((c) => { try { c.ws.close(); } catch {} });
  }
});

console.log(failures === 0 ? 'PUBLIC 3H: ALL PASS' : `PUBLIC 3H: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
