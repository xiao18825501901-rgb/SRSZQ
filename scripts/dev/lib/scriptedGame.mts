/**
 * 公网验收共用夹具：注册 3 个 DEMO 账号并打一场**固定脚本的 20 手真实对局**。
 *
 * 为什么固定脚本：这一局会在真实生产后端留下可预期的棋谱（终局致胜点、错失致胜点、
 * 跨轮遮挡各一处），于是复盘页的关键片段、时间线上的关键手标记都能被确定性地检查到。
 */
import { WebSocket } from 'ws';

export const SCRIPT: Array<[number, number]> = [
  [5, 5], [6, 1], [0, 1],
  [10, 10], [6, 2], [0, 2],
  [10, 11], [6, 3], [0, 3],
  [10, 12], [11, 11], [12, 12],
  [5, 6], [11, 12], [12, 11],
  [0, 0], [11, 10], [2, 2],
  [5, 7], [6, 4],
];
export const SEATS = ['A', 'B', 'C'] as const;

export interface DemoUser {
  tag: string; username: string; email: string; token: string; id: string; rating: number; user: Record<string, unknown>;
}
interface ApiResult { status: number; json: any; text: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function api(apiBase: string, method: string, path: string, body?: unknown, token?: string): Promise<ApiResult> {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, json, text };
}

async function connect(wsUrl: string, token: string, msgs: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl + '?protocol=2&ruleset=formal-rules-v2&token=' + encodeURIComponent(token));
    ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function grab(msgs: any[], type: string, ms: number): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = msgs.findIndex((m) => m.type === type);
    if (i >= 0) return msgs.splice(i, 1)[0];
    await sleep(50);
  }
  return null;
}

export async function registerDemo(apiBase: string, tag: string, stamp: string, password: string): Promise<DemoUser> {
  const username = ('dsh' + tag + stamp).slice(0, 16);
  const email = ('dsh.' + tag + '.' + stamp + '@example.invalid').toLowerCase();
  const reg = await api(apiBase, 'POST', '/api/register', { email, username, password });
  if (reg.status !== 201) throw new Error('register ' + tag + ' -> ' + reg.status + ' ' + reg.text.slice(0, 200));
  await api(apiBase, 'POST', '/api/tutorial/complete', {}, reg.json.token);
  return { tag, username, email, token: reg.json.token, id: reg.json.user.id, rating: reg.json.user.rating, user: reg.json.user };
}

export interface ScriptedGameResult {
  gameId: string;
  users: DemoUser[];
  seats: Record<string, number>;
  winner: DemoUser;
  ended: any;
  ackFail: number;
  humanSeats: number;
}

export async function playScriptedTrioGame(o: { apiBase: string; wsUrl: string; prefix: string; password: string }): Promise<ScriptedGameResult> {
  const stamp = Date.now().toString(36);
  const users: DemoUser[] = [];
  for (const tag of ['a', 'b', 'c']) users.push(await registerDemo(o.apiBase, o.prefix + tag, stamp, o.password));
  const msgs: any[][] = [[], [], []];
  const sockets: WebSocket[] = [];
  for (let i = 0; i < 3; i += 1) sockets.push(await connect(o.wsUrl, users[i].token, msgs[i]));
  for (const ws of sockets) ws.send(JSON.stringify({ type: 'queue.join' }));
  const starts = await Promise.all([0, 1, 2].map((i) => grab(msgs[i], 'game.start', 90000)));
  if (!starts.every(Boolean)) { sockets.forEach((w) => w.close()); throw new Error('三人匹配失败'); }
  const gameId: string = starts[0].gameId;
  const seats: Record<string, number> = {};
  for (let i = 0; i < 3; i += 1) seats[starts[i].yourSeat] = i;
  let ackFail = 0;
  for (let i = 0; i < SCRIPT.length; i += 1) {
    const idx = seats[SEATS[i % 3]];
    const [row, col] = SCRIPT[i];
    sockets[idx].send(JSON.stringify({ type: 'move', commandId: o.prefix + '-' + gameId + '-' + i, row, col }));
    const ack = await grab(msgs[idx], 'ack', 15000);
    if (!ack) ackFail += 1;
  }
  const ended = await grab(msgs[seats.B], 'MATCH_ENDED', 15000);
  await sleep(1200);
  sockets.forEach((w) => { try { w.close(); } catch { /* noop */ } });
  return { gameId, users, seats, winner: users[seats.B], ended, ackFail, humanSeats: Object.keys(seats).length };
}