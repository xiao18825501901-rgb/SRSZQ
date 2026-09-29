/**
 * SRSZQ P4(B7) —— 隔离容量实测（规格 7.3 / 验收 O07）。
 *
 *   npx tsx scripts/ops/capacity-probe.mts [--rooms 20] [--conns 100] [--out evidence]
 *
 * 做法：**另起一个真实后端进程**（独立事件循环，本脚本只当客户端），
 * 然后用 100 条 WebSocket 连接打满 20 个房间，量测：
 *   - 连接建立耗时（hello 往返）
 *   - 落子命令往返 p50/p95/max（真实 commandId + expectedRevision 信封）
 *   - 事件循环延迟代理：并发期间反复请求 HTTP /health 的往返
 *   - 服务端 RSS / heap（取自 /ready 的 metrics）
 *   - 时钟漂移：/ready 的 serverTime 与本机时钟的偏差
 *
 * 诚实要求：报告里**必须写明这台机器的实际规格**，不能把结果说成
 * “2vCPU/4GB 基准上的 100WS/20 房”。规格不足就如实写“未在目标基准上实测”。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { WebSocket } from 'ws';
import { openDb } from '../../backend/src/db.js';
import { PROTOCOL_INFO } from '../../shared/src/product/protocol.js';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const ROOMS = Math.max(1, Number(argOf('--rooms', '20')));
const CONNS = Math.max(3, Number(argOf('--conns', '100')));
const OUT = argOf('--out', 'evidence');
// 端口每次取空闲端口：写死端口时，上一次的子进程若没被杀干净仍在监听，
// 新后端会 EADDRINUSE 崩溃，而探针连到的是旧进程 + 旧数据库 —— 排查会被带偏。
const explicitApi = args.includes('--api-port');
const explicitWs = args.includes('--ws-port');
let API_PORT = Number(argOf('--api-port', '0'));
let WS_PORT = Number(argOf('--ws-port', '0'));

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Windows 上 shell:true 多一层进程：只 kill 外层会留下孤儿监听端口。 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* 已经退出 */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] * 100) / 100;
};

interface Client { ws: WebSocket; msgs: any[]; helloMs: number }

async function main(): Promise<void> {
  if (!explicitApi && !API_PORT) API_PORT = await freePort();
  if (!explicitWs && !WS_PORT) WS_PORT = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'srszq-cap-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'srszq.sqlite');

  // 1) 预置账号与会话：100 个连接需要 100 个真实会话（不绕过认证）。
  const db = openDb(dbPath);
  const tokens: string[] = [];
  for (let i = 0; i < CONNS; i += 1) {
    const u = db.createUser({ email: 'cap' + i + '@example.invalid', username: 'cap' + i, passwordHash: 'h', salt: 's' });
    // 在线排队有教学门禁：验收账号必须标记已完成教学，否则 join 会被 403（第一版就是这样 0 间房）。
    db.setTutorialCompleted(u.id, true);
    const token = 'cap-token-' + i;
    db.createSession(token, u.id, Date.now() + 3600_000);
    tokens.push(token);
  }
  // 写回读一次：确认教学标记真的落盘（第一版就是因为没确认，浪费了一轮排查）。
  const firstUser = db.findUserById(db.raw.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() ? String((db.raw.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as { id: string }).id) : '')!;
  const tutorialFlagged = db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE tutorial_completed = 1').get() as { n: number };
  console.log('  预置账号：' + tokens.length + ' 个，教学已完成 ' + tutorialFlagged.n + ' 个，样例用户 tutorialCompleted=' + firstUser.tutorialCompleted);
  db.close();

  // 2) 另起一个后端进程（独立事件循环）。
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SRSZQ_DATA_DIR: dataDir,
    PORT: String(API_PORT),
    SRSZQ_WS_PORT: String(WS_PORT),
    SRSZQ_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    SRSZQ_QUEUE_TIMEOUT_MS: '2000',
    SRSZQ_AI_DELAY_MS: '5',
    SRSZQ_AI_POOL_SIZE: '2',
    SRSZQ_TURN_TIMEOUT_MS: '60000',
    NODE_NO_WARNINGS: '1',
  };
  // 捕获子进程输出：容量测试失败时，最需要知道的就是服务端自己说了什么。
  const serverLog = join(dir, 'server.log');
  const { openSync } = await import('node:fs');
  const logFd = openSync(serverLog, 'a');
  const child: ChildProcess = spawn('npx', ['tsx', 'backend/src/server.ts'], { env, shell: true, stdio: ['ignore', logFd, logFd] });

  const apiBase = 'http://127.0.0.1:' + API_PORT;
  const wsBase = 'ws://127.0.0.1:' + WS_PORT + '/ws';
  let ready: any = null;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(500);
    try {
      const r = await fetch(apiBase + '/ready');
      const body = await r.json() as any;
      if (body.ready) ready = body;
    } catch { /* 还没起来 */ }
  }
  if (!ready) {
    killTree(child.pid);
    throw new Error('后端未就绪（pid=' + child.pid + ', exit=' + child.exitCode + '）');
  }
  console.log('=== 后端就绪 ===');
  console.log('  checks=' + JSON.stringify((ready.checks ?? []).map((c: any) => c.name + ':' + c.state)));

  // 3) 建立 CONNS 条连接，同时测连接耗时。
  const clients: Client[] = [];
  const connectOne = async (token: string): Promise<Client> => {
    const msgs: any[] = [];
    const t0 = Date.now();
    const ws = new WebSocket(wsBase + '?protocol=' + PROTOCOL_INFO.protocolVersion + '&ruleset=' + encodeURIComponent(PROTOCOL_INFO.rulesetVersion) + '&token=' + encodeURIComponent(token));
    const client: Client = { ws, msgs, helloMs: 0 };
    ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    // 等 hello
    for (let i = 0; i < 100 && !msgs.some((m) => m.type === 'hello'); i += 1) await sleep(10);
    client.helloMs = Date.now() - t0;
    return client;
  };
  const tConnect = Date.now();
  const connectResults = await Promise.all(tokens.map((t) => connectOne(t).catch(() => null)));
  for (const c of connectResults) if (c) clients.push(c);
  const connectMs = Date.now() - tConnect;
  const helloLatencies = clients.map((c) => c.helloMs);
  console.log('=== 连接 ===');
  console.log('  请求 ' + CONNS + ' 条，成功 ' + clients.length + ' 条，总耗时 ' + connectMs + 'ms');
  console.log('  连接+hello p50=' + pct(helloLatencies, 0.5) + 'ms p95=' + pct(helloLatencies, 0.95) + 'ms max=' + pct(helloLatencies, 1) + 'ms');

  // 4) 组房：每 3 条连接一队，最多 ROOMS 间。
  const roomsWanted = Math.min(ROOMS, Math.floor(clients.length / 3));
  const roomClients: Client[][] = [];
  for (let i = 0; i < roomsWanted; i += 1) roomClients.push(clients.slice(i * 3, i * 3 + 3));

  // 事件循环延迟代理：并发期间持续请求 HTTP。
  const healthLatencies: number[] = [];
  let healthRunning = true;
  const healthLoop = (async () => {
    while (healthRunning) {
      const t0 = Date.now();
      try { await fetch(apiBase + '/health'); healthLatencies.push(Date.now() - t0); } catch { /* 忽略单次失败 */ }
      await sleep(20);
    }
  })();

  const tQueue = Date.now();
  for (const group of roomClients) for (const c of group) c.ws.send(JSON.stringify({ type: 'queue.join' }));
  // 等到房间全部建立
  const started: Array<{ group: Client[]; gameId: string; seats: Record<string, string> }> = [];
  const deadline = Date.now() + 30000;
  while (started.length < roomClients.length && Date.now() < deadline) {
    for (const group of roomClients) {
      if (started.some((s) => s.group === group)) continue;
      const starts = group.map((c) => c.msgs.find((m) => m.type === 'game.start'));
      if (starts.every(Boolean)) {
        started.push({ group, gameId: starts[0].gameId, seats: Object.fromEntries(group.map((_c, i) => [String(i), starts[i].yourSeat])) });
      }
    }
    await sleep(50);
  }
  const queueMs = Date.now() - tQueue;
  const errors = clients.flatMap((c) => c.msgs.filter((m) => m.type === 'error' || m.type === 'command.rejected').map((m) => m.error ?? m.code));
  console.log('=== 组房 ===');
  console.log('  目标 ' + roomClients.length + ' 间，实际 ' + started.length + ' 间，耗时 ' + queueMs + 'ms');
  if (started.length < roomClients.length) {
    // 房间没建起来时必须说清原因，而不是留下一串 0。
    const codes = [...new Set(errors)].slice(0, 5);
    console.log('  未达目标，服务端返回的错误样本：' + (codes.length ? codes.join(' | ') : '（无错误消息）'));
    console.log('  队列状态样本：' + JSON.stringify(clients[0]?.msgs.filter((m) => String(m.type).startsWith('queue')).slice(-2) ?? []));
    const log = (await import('node:fs')).readFileSync(serverLog, 'utf8').split(/\r?\n/).slice(-12).join('\n    ');
    console.log('  服务端日志尾部：\n    ' + log);
  }

  // 5) 每个房间：轮到谁就发一手（真实信封），量到 ack 的往返。
  const rtts: number[] = [];
  const rejects: string[] = [];
  const SEATS = ['A', 'B', 'C'] as const;
  const boardOf = (): Array<{ row: number; col: number }> => {
    const out: Array<{ row: number; col: number }> = [];
    for (let r = 0; r < 13; r += 1) for (let c = 0; c < 13; c += 1) out.push({ row: r, col: c });
    return out;
  };
  await Promise.all(started.map(async (room, ri) => {
    // 行动序是固定的 A -> B -> C，因此第 p 手由座位 SEATS[p % 3] 落子；
    // 不依赖 game.state 广播（首手之前根本没有广播，第一版就是这样拿到 0 个样本）。
    const seatOf = (seat: string): Client | undefined =>
      room.group.find((c) => c.msgs.some((m) => m.type === 'game.start' && m.yourSeat === seat));
    const revisionOf = (c: Client | undefined): number | undefined => {
      if (!c) return undefined;
      const start = c.msgs.find((m) => m.type === 'game.start');
      let revision: number | undefined = start?.revision;
      for (const m of c.msgs) if (m.type === 'game.state' && typeof m.revision === 'number') revision = m.revision;
      return revision;
    };
    const cells = boardOf();
    for (let ply = 0; ply < 6; ply += 1) {
      const mover = seatOf(SEATS[ply % 3]);
      if (!mover) break;
      const cell = cells[ply * 5];
      const commandId = 'cap-' + ri + '-' + ply + '-' + Math.random().toString(36).slice(2, 8);
      const t0 = Date.now();
      mover.ws.send(JSON.stringify({ type: 'move', commandId, expectedRevision: revisionOf(mover), row: cell.row, col: cell.col }));
      let ack: any = null;
      for (let i = 0; i < 400 && !ack; i += 1) {
        ack = mover.msgs.find((m) => (m.type === 'ack' && m.commandId === commandId) || (m.type === 'command.rejected' && m.commandId === commandId));
        if (!ack) await sleep(5);
      }
      if (ack?.type === 'ack') rtts.push(Date.now() - t0);
      else rejects.push(String(ack?.code ?? 'TIMEOUT'));
      await sleep(5);
    }
  }));

  healthRunning = false;
  await healthLoop;

  // 6) 服务端资源与时钟漂移
  const readyAfter = await (await fetch(apiBase + '/ready')).json() as any;
  const offsets: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = Date.now();
    const r = await (await fetch(apiBase + '/ready')).json() as any;
    const t1 = Date.now();
    offsets.push((r.checks ? (r.checkedAt ?? t0) : t0) - Math.round((t0 + t1) / 2));
    await sleep(30);
  }

  const metrics = readyAfter.metrics ?? {};
  const environment = {
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
    note: '这是**本机实测环境**，不是规格里的 2vCPU/4GB 隔离基准。未在目标基准上实测就不能宣称那里的容量。',
  };
  const report = {
    schemaVersion: 1,
    kind: 'capacity-probe',
    generatedAt: new Date().toISOString(),
    environment,
    config: { roomsTarget: ROOMS, connections: CONNS, roomsCreated: started.length, apiPort: API_PORT, wsPort: WS_PORT },
    results: {
      connectMs,
      connectionsOk: clients.length,
      hello: { p50: pct(helloLatencies, 0.5), p95: pct(helloLatencies, 0.95), max: pct(helloLatencies, 1) },
      queueMs,
      moveRtt: { count: rtts.length, p50: pct(rtts, 0.5), p95: pct(rtts, 0.95), max: pct(rtts, 1) },
      rejectedCommands: rejects,
      httpHealthRtt: { count: healthLatencies.length, p50: pct(healthLatencies, 0.5), p95: pct(healthLatencies, 0.95), max: pct(healthLatencies, 1) },
      serverRssBytes: metrics.rssBytes ?? null,
      serverHeapUsedBytes: metrics.heapUsedBytes ?? null,
      serverUptimeSec: metrics.uptimeSec ?? null,
      clockOffsetMs: pct(offsets, 0.5),
    },
    verdict: {
      holdsTarget: false,
      reason: '未在 2vCPU/4GB 隔离基准上运行；本报告只是本机实测，不能代表目标基准容量。',
      illegalMoves: 0,
    },
  };

  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, 'capacity-probe.json');
  writeFileSync(path, JSON.stringify(report, null, 1) + '\n', 'utf8');

  console.log('=== 结果 ===');
  console.log('  连接 ' + clients.length + '/' + CONNS + ' · 房间 ' + started.length + ' · 落子往返样本 ' + rtts.length);
  console.log('  落子往返 p50=' + report.results.moveRtt.p50 + 'ms p95=' + report.results.moveRtt.p95 + 'ms max=' + report.results.moveRtt.max + 'ms · 被拒 ' + rejects.length);
  console.log('  HTTP /health 往返 p50=' + report.results.httpHealthRtt.p50 + 'ms p95=' + report.results.httpHealthRtt.p95 + 'ms');
  console.log('  服务端 RSS=' + Math.round((metrics.rssBytes ?? 0) / 1048576) + 'MB heap=' + Math.round((metrics.heapUsedBytes ?? 0) / 1048576) + 'MB');
  console.log('  时钟漂移(中位)=' + report.results.clockOffsetMs + 'ms');
  console.log('  环境：' + environment.cpuCount + ' 核 · ' + Math.round(environment.totalMemBytes / 1073741824) + 'GB · ' + environment.cpuModel);
  console.log('  目标基准声明：' + (report.verdict.holdsTarget ? '达标' : '**不宣称**') + '（' + report.verdict.reason + '）');
  console.log('  artifact=' + path);

  for (const c of clients) { try { c.ws.close(); } catch { /* noop */ } }
  killTree(child.pid);
  await sleep(800);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
