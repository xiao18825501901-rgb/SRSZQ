import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const apiBase = process.env.SRSZQ_API_URL;
const wsBase = process.env.SRSZQ_WS_URL;
assert.ok(apiBase, 'SRSZQ_API_URL is required');
assert.ok(wsBase, 'SRSZQ_WS_URL is required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body, token) {
  const response = await fetch(apiBase + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  assert.ok(response.ok, `${method} ${path} failed: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function register(label) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const username = `ql${label}${suffix}`.slice(0, 16);
  const result = await api('POST', '/api/register', {
    email: `${username}@test.com`,
    username,
    password: 'secret1',
  });
  await api('POST', '/api/tutorial/complete', undefined, result.token);
  return { id: result.user.id, username, token: result.token };
}

function connect(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}?token=${encodeURIComponent(user.token)}`);
    const client = { user, ws, messages: [] };
    ws.on('message', (raw) => client.messages.push(JSON.parse(String(raw))));
    ws.once('error', reject);
    ws.once('open', () => resolve(client));
  });
}

function send(client, message) {
  client.ws.send(JSON.stringify(message));
}

function close(client) {
  try {
    client.ws.close();
  } catch {
    // Already closed.
  }
}

async function waitFor(client, type, timeoutMs = 5000, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = client.messages.findIndex((message) => message.type === type && predicate(message));
    if (index >= 0) return client.messages.splice(index, 1)[0];
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${type}; got ${client.messages.map((message) => message.type).join(',')}`);
}

async function connectAndHello(user) {
  const client = await connect(user);
  const hello = await waitFor(client, 'hello');
  assert.equal(hello.user.id, user.id);
  return client;
}

async function startThreeHumanGame(clients) {
  for (const client of clients) send(client, { type: 'queue.join' });
  const starts = await Promise.all(clients.map((client) => waitFor(client, 'game.start', 5000)));
  const gameId = starts[0].gameId;
  assert.ok(starts.every((start) => start.gameId === gameId));
  assert.ok(starts.every((start) => Object.values(start.seats).filter((seat) => seat.kind === 'human').length === 3));
  const bySeat = new Map(starts.map((start, index) => [start.yourSeat, clients[index]]));
  return { gameId, starts, bySeat };
}

async function rankingsFor(users) {
  const { ranking } = await api('GET', '/api/ranking');
  return users.map((user) => ranking.find((row) => row.id === user.id));
}

async function main() {
  const users = await Promise.all(['a', 'b', 'c'].map(register));
  let clients = await Promise.all(users.map(connectAndHello));
  let reconnected = null;

  try {
    const first = await startThreeHumanGame(clients);
    const seatA = first.bySeat.get('A');
    assert.ok(seatA);
    send(seatA, { type: 'move', row: 0, col: 0 });
    const observers = clients.filter((client) => client !== seatA);
    await Promise.all(observers.map((client) => waitFor(client, 'game.state', 3000, (message) => message.state.moves.length === 1)));

    close(seatA);
    await Promise.all(observers.map((client) => waitFor(client, 'player.status', 3000, (message) => message.status === 'disconnected')));

    reconnected = await connectAndHello(seatA.user);
    send(reconnected, { type: 'resume', gameId: first.gameId });
    const resumed = await waitFor(reconnected, 'game.start', 3000);
    assert.equal(resumed.gameId, first.gameId);
    assert.equal(resumed.state.moves.length, 1);
    await Promise.all(observers.map((client) => waitFor(client, 'player.status', 3000, (message) => message.status === 'reconnected')));

    await sleep(10_500);
    assert.ok(!observers.some((client) => client.messages.some((message) => message.type === 'MATCH_ENDED')));
    console.log('PASS public disconnect and resume within the production grace period');

    send(reconnected, { type: 'PLAYER_RESIGN' });
    const firstEnd = await Promise.all([reconnected, ...observers].map((client) => waitFor(client, 'MATCH_ENDED', 3000)));
    assert.ok(firstEnd.every((message) => message.reason === 'PLAYER_FORFEIT' && message.matchId === first.gameId));
    console.log('PASS public PLAYER_RESIGN produced PLAYER_FORFEIT for all clients');

    clients = [reconnected, ...observers];
    reconnected = null;
    const second = await startThreeHumanGame(clients);
    const disconnecting = second.bySeat.get('A');
    assert.ok(disconnecting);
    const remaining = clients.filter((client) => client !== disconnecting);
    close(disconnecting);
    const secondEnd = await Promise.all(remaining.map((client) => waitFor(client, 'MATCH_ENDED', 13_000)));
    assert.ok(secondEnd.every((message) => message.reason === 'PLAYER_DISCONNECT' && message.matchId === second.gameId));
    console.log('PASS public disconnect timeout produced PLAYER_DISCONNECT');

    await sleep(300);
    const rows = await rankingsFor(users);
    assert.ok(rows.every((row) => row && row.games === 2));
    assert.equal(rows.reduce((sum, row) => sum + row.wins, 0), 4);
    assert.equal(rows.reduce((sum, row) => sum + row.rating, 0), 3700);
    console.log('PASS public forfeit/disconnect results persisted to ranking');
    console.log('PUBLIC GAME LIFECYCLE: ALL PASS');
  } finally {
    for (const client of clients) close(client);
    if (reconnected) close(reconnected);
  }
}

main().catch((error) => {
  console.error('PUBLIC GAME LIFECYCLE: FAIL', error);
  process.exitCode = 1;
});
