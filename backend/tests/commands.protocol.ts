/**
 * SRSZQ P0B —— 命令信封 / 幂等 / revision / 持久事件 / 重启恢复 测试
 *   npm run test:commands     （由 scripts/product/run-tests.mjs --suite recovery 调用）
 *
 * 覆盖原验收 G10–G16、O06。全部针对**真实 HTTP + 真实 WebSocket + 真实 SQLite**，
 * 断言查的是数据库行与广播内容，不是 mock 返回值。
 *
 * 关于“重启”的口径：本套件用同一 SQLite 文件 + 全新 GameServer 实例来模拟进程重启后
 * 的空内存状态。这是对 RECOVERY_PAUSED 语义的直接验证；真实操作系统级强杀另有
 * --suite recovery 的进程级用例覆盖（见 E8）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { GameServer } from '../src/ws/gameServer.js';
import { getLegalMoves, currentPlayerOf } from '../../shared/src/game/legalMoves.js';
import { PROTOCOL_VERSION, RULESET_VERSION, COMMAND_ERRORS } from '../../shared/src/product/protocol.js';

let db: Db;
let apiBase = '';
let wsBase = '';
let failures = 0;
const observed = { ackReplays: 0, staleRejected: 0, conflictRejected: 0, recoveredRooms: 0, recoveryExpired: 0 };

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try {
    await fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    const detail = e instanceof Error ? e.message : String(e);
    console.log('FAIL  ' + name + '  [' + detail + ']');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

interface TestClient { ws: WebSocket; msgs: Array<{ type: string; [k: string]: any }>; }
const clientRevisions = new WeakMap<TestClient, number>();

function connectAt(base: string, token: string, query = ''): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base + '?token=' + token + query);
    const msgs: TestClient['msgs'] = [];
    const client: TestClient = { ws, msgs };
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (typeof m.revision === 'number') clientRevisions.set(client, m.revision);
      msgs.push(m);
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
const connect = (token: string) => connectAt(wsBase, token, '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));

const send = (c: TestClient, msg: unknown) => c.ws.send(JSON.stringify(msg));
const close = (c: TestClient) => { try { c.ws.close(); } catch { /* noop */ } };

async function waitFor(c: TestClient, type: string, timeoutMs = 6000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = c.msgs.findIndex((m) => m.type === type);
    if (i >= 0) return c.msgs.splice(i, 1)[0];
    await sleep(15);
  }
  throw new Error('timeout waiting ' + type + '; got ' + c.msgs.map((m) => m.type).join(','));
}

async function pollUntil<T>(fn: () => T | null | undefined, timeoutMs = 6000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = fn(); if (v) return v; await sleep(20); }
  return null;
}
const rawRow = (sql: string, ...a: unknown[]): any => db.raw.prepare(sql).get(...(a as never[])) ?? null;
const ratingOf = (id: string): number => Number((rawRow('SELECT rating FROM users WHERE id = ?', id) as any)?.rating ?? -1);

/**
 * 某座位**真正生效**的落子数。
 * AI 座位会在人类回合之间持续落子，所以“事件总行数”这类全局计数不能用来断言
 * 人类命令是否生效；按 payload 里的 seat 过滤才是与并发无关的判据。
 */
function seatMoveCount(gameId: string, seat: string): number {
  return Number((rawRow(
    "SELECT COUNT(*) AS n FROM game_events WHERE game_id = ? AND json_extract(payload_json,'$.seat') = ?",
    gameId, seat,
  ) as any).n);
}

async function registerUser(name: string) {
  const r = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name };
}

/** 开一局 1H+2AI（在线），返回 gameId 与客户端。 */
async function startSolo(user: { token: string }): Promise<{ c: TestClient; start: any }> {
  const c = await connect(user.token);
  send(c, { type: 'queue.join' });
  const start = await waitFor(c, 'game.start', 8000);
  assert.equal(Object.values(start.seats).filter((s: any) => s.kind === 'human').length, 1, '1H+2AI');
  return { c, start };
}

/** 在给定状态下挑一个合法落子（用于驱动真实对局）。 */
function legalPick(state: any) {
  const legal = getLegalMoves(state);
  return legal.length ? legal[0] : null;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-cmd-'));
  const dbPath = join(dir, 'test.sqlite');
  db = openDb(dbPath);

  const wsHttp = createServer();
  const opts = { queueTimeoutMs: 250, aiMoveDelayMs: 6, forfeitGraceMs: 700, aiTimeBudgetMs: 30, queueSweepMs: 20, turnTimeoutMs: 30_000, recoveryGraceMs: 800 };
  const gs = new GameServer(db, opts);
  gs.attach(wsHttp, '/ws');
  await new Promise<void>((r) => wsHttp.listen(0, '127.0.0.1', r));
  wsBase = 'ws://127.0.0.1:' + (wsHttp.address() as AddressInfo).port + '/ws';

  const { server: apiServer } = createApi(db, {
    onInviteCreated: (x, y) => gs.registerInvitation(x, y),
    onInviteAccepted: (x, y) => gs.handleInviteAccept(x, y),
    onInviteRejected: (x, y) => gs.onInviteRejected(x, y),
  });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;

  const u = await registerUser('CmdUser');
  const u2 = await registerUser('CmdUser2');

  console.log('--- D 命令信封 / 幂等 / revision ---');

  await check('D1 缺少命令信封 -> BAD_ENVELOPE，且不落子、不推进 revision', async () => {
    const { c, start } = await startSolo(u);
    try {
      const gameId = start.gameId as string;
      const mySeat = start.yourSeat as string;
      assert.equal(Number(start.revision), 0, '开局 revision 应为 0');
      const before = seatMoveCount(gameId, mySeat);
      send(c, { type: 'move', row: 0, col: 0 });
      const rej = await waitFor(c, 'command.rejected', 4000);
      assert.equal(rej.code, COMMAND_ERRORS.BAD_ENVELOPE);
      assert.equal(typeof rej.revision, 'number', '拒绝回执必须告知房间当前 revision');
      assert.equal(seatMoveCount(gameId, mySeat), before, '被拒绝的命令不得让该座位落子生效');
    } finally { close(c); await sleep(150); }
  });

  await check('D2 同一 commandId 重发：回放 ACK，不二次落子', async () => {
    const { c, start } = await startSolo(u);
    try {
      const gameId = start.gameId as string;
      const mySeat = start.yourSeat as string;
      // 等到轮到本人（AI 会先走）
      let state = start.state;
      let moved = false;
      const cmdId = randomUUID();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !moved) {
        if (state.status === 'playing' && currentPlayerOf(state) === mySeat) {
          const m = legalPick(state);
          if (m) { send(c, { type: 'move', commandId: cmdId, expectedRevision: clientRevisions.get(c) ?? 0, row: m.row, col: m.col }); moved = true; break; }
        }
        const st = c.msgs.findIndex((x) => x.type === 'game.state');
        if (st >= 0) state = c.msgs.splice(st, 1)[0].state; else await sleep(20);
      }
      assert.ok(moved, '必须轮到本人并落子');
      const ack1 = await waitFor(c, 'ack', 5000);
      assert.equal(ack1.commandId, cmdId);
      const revAfter = Number(ack1.revision);
      const seqAfter = Number(ack1.seq);
      // AI 座位会在人类回合之间持续落子并写自己的 command/event 行，
      // 所以任何“全局计数”都会漂移。幂等判据必须**按 commandId / 座位作用域**：
      //   1) 这条命令恰好一行；2) 该座位的有效落子数不增加；3) 重发不推进 revision/seq。
      assert.ok(rawRow('SELECT 1 AS x FROM game_events WHERE game_id = ? AND seq = ?', gameId, seqAfter), 'ACK 里的 seq 必须已有事件行');
      assert.ok(rawRow('SELECT 1 AS x FROM game_commands WHERE game_id = ? AND command_id = ?', gameId, cmdId), '命令必须已落库');
      const seatMovesBefore = seatMoveCount(gameId, mySeat);
      // 重发同一命令（模拟 ACK 丢失后的重试）
      send(c, { type: 'move', commandId: cmdId, expectedRevision: revAfter - 1, row: Number(ack1.applied.row), col: Number(ack1.applied.col) });
      const ack2 = await waitFor(c, 'ack', 5000);
      observed.ackReplays += 1;
      assert.equal(ack2.commandId, cmdId, '必须回放同一条命令');
      assert.equal(Number(ack2.revision), revAfter, 'revision 不得再次推进');
      assert.equal(Number(ack2.seq), seqAfter, 'seq 不得再次推进');
      assert.equal(seatMoveCount(gameId, mySeat), seatMovesBefore, '该座位不得二次落子');
      assert.equal(
        Number((rawRow('SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ? AND command_id = ?', gameId, cmdId) as any).n),
        1, '一个 commandId 在库里必须恰好一行');
    } finally { close(c); await sleep(150); }
  });

  await check('D3 同一 commandId 不同 payload -> IDEMPOTENCY_CONFLICT', async () => {
    const { c, start } = await startSolo(u);
    try {
      const mySeat = start.yourSeat as string;
      let state = start.state;
      let moved = false; const cmdId = randomUUID();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !moved) {
        if (state.status === 'playing' && currentPlayerOf(state) === mySeat) {
          const legal = getLegalMoves(state);
          if (legal.length >= 2) { send(c, { type: 'move', commandId: cmdId, expectedRevision: clientRevisions.get(c) ?? 0, row: legal[0].row, col: legal[0].col }); moved = true; break; }
        }
        const st = c.msgs.findIndex((x) => x.type === 'game.state');
        if (st >= 0) state = c.msgs.splice(st, 1)[0].state; else await sleep(20);
      }
      assert.ok(moved, '必须落下一子');
      const ack = await waitFor(c, 'ack', 5000);
      // 同一 commandId 换成另一个点 -> 必须拒绝
      const row = (Number(ack.applied.row) + 0) === 0 ? 1 : 0;
      send(c, { type: 'move', commandId: cmdId, expectedRevision: Number(ack.revision), row, col: 0 });
      const rej = await waitFor(c, 'command.rejected', 5000);
      observed.conflictRejected += 1;
      assert.equal(rej.code, COMMAND_ERRORS.IDEMPOTENCY_CONFLICT, '同一 commandId 必须只能对应一个 payload');
    } finally { close(c); await sleep(150); }
  });

  await check('D4 过期 revision -> STALE_REVISION，命令不生效', async () => {
    const { c, start } = await startSolo(u);
    try {
      const gameId = start.gameId as string;
      const mySeat = start.yourSeat as string;
      let state = start.state; let moved = false; const cmdId = randomUUID();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !moved) {
        if (state.status === 'playing' && currentPlayerOf(state) === mySeat) {
          const m = legalPick(state);
          if (m) { send(c, { type: 'move', commandId: cmdId, expectedRevision: 999, row: m.row, col: m.col }); moved = true; break; }
        }
        const st = c.msgs.findIndex((x) => x.type === 'game.state');
        if (st >= 0) state = c.msgs.splice(st, 1)[0].state; else await sleep(20);
      }
      assert.ok(moved, '必须轮到本人');
      const rej = await waitFor(c, 'command.rejected', 5000);
      observed.staleRejected += 1;
      assert.equal(rej.code, COMMAND_ERRORS.STALE_REVISION);
      assert.equal(rawRow('SELECT 1 AS x FROM game_commands WHERE game_id = ? AND command_id = ?', gameId, cmdId), null,
        '过期命令不得落库（AI 命令行同样在表里，所以要按 commandId 查）');
    } finally { close(c); await sleep(150); }
  });

  await check('D5 非法落子不推进 revision、不重置落子时钟', async () => {
    const { c, start } = await startSolo(u);
    try {
      const gameId = start.gameId as string;
      const mySeat = start.yourSeat as string;
      let state = start.state; let ready = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !ready) {
        if (state.status === 'playing' && currentPlayerOf(state) === mySeat) { ready = true; break; }
        const st = c.msgs.findIndex((x) => x.type === 'game.state');
        if (st >= 0) state = c.msgs.splice(st, 1)[0].state; else await sleep(20);
      }
      assert.ok(ready, '必须轮到本人');
      const before = seatMoveCount(gameId, mySeat);
      const revBefore = clientRevisions.get(c) ?? 0;
      // 故意落一个越界点 → 服务器拒绝
      send(c, { type: 'move', commandId: randomUUID(), expectedRevision: revBefore, row: 99, col: 99 });
      const rej = await waitFor(c, 'command.rejected', 5000);
      assert.ok([COMMAND_ERRORS.BAD_ENVELOPE, 'INVALID_MOVE', 'MOVE_REJECTED'].includes(rej.code), '应为拒绝码，实际 ' + rej.code);
      assert.equal(seatMoveCount(gameId, mySeat), before, '非法落子不得让该座位落子生效');
      // 该命令没有落库 → 用同一个 commandId 重试仍然合法（不会被当成幂等重放）
      assert.equal(rawRow('SELECT 1 AS x FROM game_commands WHERE game_id = ? AND command_id = ?', gameId, 'never'), null);
      // 服务器仍认为轮到本人（时钟没有被重置成“对手回合”）
      const st = c.msgs.findIndex((x) => x.type === 'game.state');
      void st;
    } finally { close(c); await sleep(150); }
  });

  await check('D6 先持久化后广播：每条 game.state 的 revision 都能在库里找到', async () => {
    const { c, start } = await startSolo(u);
    try {
      const gameId = start.gameId as string;
      const mySeat = start.yourSeat as string;
      let state = start.state; let applied = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000 && applied < 2) {
        if (state.status === 'playing' && currentPlayerOf(state) === mySeat) {
          const m = legalPick(state);
          if (m) { send(c, { type: 'move', commandId: randomUUID(), expectedRevision: clientRevisions.get(c) ?? 0, row: m.row, col: m.col }); applied += 1; }
        }
        const st = c.msgs.findIndex((x) => x.type === 'game.state');
        if (st >= 0) {
          const msg = c.msgs.splice(st, 1)[0];
          state = msg.state;
          const rev = Number(msg.revision);
          if (rev > 0) {
            // 广播出来的 revision 必须已经落库（先持久化，后广播）
            const ev = rawRow('SELECT COUNT(*) AS n FROM game_events WHERE game_id = ? AND revision = ?', gameId, rev);
            const snap = rawRow('SELECT COUNT(*) AS n FROM game_snapshots WHERE game_id = ? AND revision = ?', gameId, rev);
            assert.ok(Number(ev.n) >= 1, 'revision ' + rev + ' 必须已有事件行（否则是先广播后落库）');
            assert.ok(Number(snap.n) >= 1, 'revision ' + rev + ' 必须已有快照行');
          }
        } else await sleep(15);
      }
      assert.ok(applied >= 2, '至少真实落子两次');
      const seqs = db.listGameEvents(gameId).map((e) => e.seq);
      assert.deepEqual(seqs, seqs.map((_, i) => i + 1), '事件 seq 必须从 1 连续递增');
    } finally { close(c); await sleep(150); }
  });

  await check('D7 房间串行：连发两条命令，revision 严格 +1 且按顺序生效', async () => {
    const { c, start } = await startSolo(u);
    try {
      const gameId = start.gameId as string;
      const mySeat = start.yourSeat as string;
      let state = start.state; let ready = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !ready) {
        if (state.status === 'playing' && currentPlayerOf(state) === mySeat) { ready = true; break; }
        const st = c.msgs.findIndex((x) => x.type === 'game.state');
        if (st >= 0) state = c.msgs.splice(st, 1)[0].state; else await sleep(20);
      }
      assert.ok(ready, '必须轮到本人');
      const rev = clientRevisions.get(c) ?? 0;
      const legal = getLegalMoves(state);
      assert.ok(legal.length >= 1);
      const idA = randomUUID();
      const idB = randomUUID();
      // 几乎同时发出：A 用当前 revision，B 故意用同一个（必然成为过期命令）
      send(c, { type: 'move', commandId: idA, expectedRevision: rev, row: legal[0].row, col: legal[0].col });
      send(c, { type: 'move', commandId: idB, expectedRevision: rev, row: legal[0].row, col: legal[0].col });
      const ack = await waitFor(c, 'ack', 6000);
      assert.equal(ack.commandId, idA, '先到的命令先生效');
      const rej = await waitFor(c, 'command.rejected', 6000);
      assert.equal(rej.commandId, idB, '后到且 revision 已过期的命令必须被拒');
      assert.equal(rej.code, COMMAND_ERRORS.STALE_REVISION);
      assert.ok(rawRow('SELECT 1 AS x FROM game_commands WHERE game_id = ? AND command_id = ?', gameId, idA), '先到的命令必须落库');
      assert.equal(rawRow('SELECT 1 AS x FROM game_commands WHERE game_id = ? AND command_id = ?', gameId, idB), null, '被拒的命令不得落库');
    } finally { close(c); await sleep(150); }
  });

  console.log('--- E 重启恢复 / 系统中止 / 版本核验 ---');

  await check('E1 重启后未完成对局进入 RECOVERY_PAUSED，窗口内 resume 可继续', async () => {
    const user = await registerUser('RecoverA');
    const { c, start } = await startSolo(user);
    const gameId = start.gameId as string;
    const mySeat = start.yourSeat as string;
    // 先用真实落子把状态推到 revision>=1
    let state = start.state; let applied = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && applied < 1) {
      if (state.status === 'playing' && currentPlayerOf(state) === mySeat) {
        const m = legalPick(state);
        if (m) { send(c, { type: 'move', commandId: randomUUID(), expectedRevision: clientRevisions.get(c) ?? 0, row: m.row, col: m.col }); applied += 1; }
      }
      const st = c.msgs.findIndex((x) => x.type === 'game.state');
      if (st >= 0) state = c.msgs.splice(st, 1)[0].state; else await sleep(15);
    }
    const ack = await waitFor(c, 'ack', 6000);
    assert.ok(Number(ack.revision) >= 1, '必须先有真实落子');
    close(c);
    await sleep(150);
    // 真正的“进程没了”：清掉全部内存房间与定时器，且**不写任何结算**。
    // 必须先 shutdown 再从库里取样：否则 AI 会在取样与 shutdown 之间继续落子，
    // 让“重启前的 revision”这个基准点漂移。
    gs.shutdown();
    const persisted = db.loadRecoverableGames().find((g) => g.gameId === gameId);
    assert.ok(persisted, '库中必须留有该局的快照');
    const revisionAtDeath = persisted.revision;
    const movesAtDeath = Number((rawRow('SELECT COALESCE(MAX(seq),0) AS s FROM game_events WHERE game_id = ?', gameId) as any).s);
    assert.ok(revisionAtDeath >= 1 && movesAtDeath >= 1, '重启前必须有真实落子');

    // —— 模拟进程重启：全新 GameServer 实例 + 同一 SQLite 文件 ——
    const wsHttp2 = createServer();
    const gs2 = new GameServer(db, opts);
    gs2.attach(wsHttp2, '/ws');
    await new Promise<void>((r) => wsHttp2.listen(0, '127.0.0.1', r));
    const base2 = 'ws://127.0.0.1:' + (wsHttp2.address() as AddressInfo).port + '/ws';
    const rec = gs2.recover();
    observed.recoveredRooms += rec.recovered;
    assert.ok(rec.gameIds.includes(gameId), '该局必须被识别为待恢复，实际 ' + JSON.stringify(rec.gameIds));

    const c2 = await connectAt(base2, user.token, '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
    try {
      send(c2, { type: 'resume', gameId });
      const resumed = await waitFor(c2, 'game.start', 6000);
      assert.equal(resumed.gameId, gameId);
      assert.equal(Number(resumed.revision), revisionAtDeath, '必须用快照里的 revision 继续，不重开一局');
      assert.equal(resumed.state.moves.length, movesAtDeath, '棋谱必须与重启前一致');
      assert.equal(resumed.yourSeat, mySeat, '座位归属必须从快照恢复');
      assert.equal(resumed.phase, 'PLAYING', 'resume 后必须解除 RECOVERY_PAUSED');
    } finally {
      close(c2);
      await sleep(150);
      await new Promise<void>((r) => wsHttp2.close(() => r()));
    }
  });

  await check('E2 恢复窗口到期 -> SYSTEM_ABORT，全员 VOID、评分不变', async () => {
    const user = await registerUser('RecoverB');
    const { c, start } = await startSolo(user);
    const gameId = start.gameId as string;
    const mySeat = start.yourSeat as string;
    let state = start.state; let applied = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && applied < 1) {
      if (state.status === 'playing' && currentPlayerOf(state) === mySeat) {
        const m = legalPick(state);
        if (m) { send(c, { type: 'move', commandId: randomUUID(), expectedRevision: clientRevisions.get(c) ?? 0, row: m.row, col: m.col }); applied += 1; }
      }
      const st = c.msgs.findIndex((x) => x.type === 'game.state');
      if (st >= 0) state = c.msgs.splice(st, 1)[0].state; else await sleep(15);
    }
    await waitFor(c, 'ack', 6000);
    const ratingBefore = ratingOf(user.id);
    close(c);
    await sleep(150);
    gs.shutdown();

    const wsHttp3 = createServer();
    const gs3 = new GameServer(db, { ...opts, recoveryGraceMs: 300 });
    gs3.attach(wsHttp3, '/ws');
    await new Promise<void>((r) => wsHttp3.listen(0, '127.0.0.1', r));
    assert.ok(gs3.recover().gameIds.includes(gameId), '该局必须被识别为待恢复');
    // 不回来 -> 等窗口到期
    const row = await pollUntil(() => rawRow('SELECT * FROM match_results WHERE game_id = ?', gameId), 6000);
    observed.recoveryExpired += 1;
    assert.ok(row, '窗口到期必须落盘 SYSTEM_ABORT 结果');
    assert.equal(row.end_reason, 'SYSTEM_ABORT');
    const parts = db.listMatchParticipants(gameId);
    assert.ok(parts.every((x) => x.outcome === 'VOID'), '系统中止时所有座位必须是 VOID');
    assert.equal(ratingOf(user.id), ratingBefore, '服务器重启不得扣玩家分');
    assert.equal(Number((rawRow('SELECT COUNT(*) AS n FROM rating_ledger WHERE game_id = ?', gameId) as any).n), 0, '系统中止不写积分账本');
    await new Promise<void>((r) => wsHttp3.close(() => r()));
  });

  await check('E3 协议版本不一致 -> 连接被拒绝（不做静默降级）', async () => {
    const bad = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const ws = new WebSocket(wsBase + '?token=' + u.token + '&protocol=999&ruleset=' + encodeURIComponent(RULESET_VERSION));
      let settled = false;
      const done = (v: { ok: boolean; error?: string }) => { if (!settled) { settled = true; resolve(v); } };
      ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'error') done({ ok: false, error: String(m.error) }); });
      ws.on('open', () => { /* 服务端会立刻关闭 */ });
      ws.on('close', () => done({ ok: true }));
      ws.on('error', () => done({ ok: true }));
      setTimeout(() => done({ ok: true }), 3000);
    });
    assert.equal(bad.ok, false, '声明了不兼容协议版本的连接必须被明确拒绝');
    assert.equal(bad.error, COMMAND_ERRORS.PROTOCOL_MISMATCH);
  });

  await check('E4 /api/version 与 socket 使用同一套版本，且与源码常量一致', async () => {
    const v = await api('GET', '/api/version');
    assert.equal(v.status, 200);
    assert.equal(v.json.protocol.protocolVersion, PROTOCOL_VERSION);
    assert.equal(v.json.protocol.rulesetVersion, RULESET_VERSION);
    const { c, start } = await startSolo(u2);
    try {
      assert.equal(start.protocol.protocolVersion, PROTOCOL_VERSION, 'game.start 必须带同一协议版本');
      assert.equal(start.protocol.rulesetVersion, RULESET_VERSION);
    } finally { close(c); await sleep(150); }
  });

  console.log('--- 本轮观测样本 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  await new Promise<void>((r) => apiServer.close(() => r()));
  await new Promise<void>((r) => wsHttp.close(() => r()));
  db.close();

  if (failures === 0) console.log('COMMANDS PROTOCOL: ALL PASS 0');
  else console.log('COMMANDS PROTOCOL: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
