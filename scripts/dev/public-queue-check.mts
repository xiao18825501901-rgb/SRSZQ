/**
 * 线上排队超时探针（增量 B 的公网证据）：真连生产 WS，读服务器下发的 timeoutMs 与 deadlineAt。
 *
 *   npx tsx scripts/dev/public-queue-check.mts
 *
 * 为什么需要它：代码默认改成 20 秒之后，生产 PM2 的 SRSZQ_QUEUE_TIMEOUT_MS 仍然钉着 60000，
 * 线上真实等待还是 60 秒（前端如实显示 59）。只测代码默认值发现不了这种环境覆盖。
 * 本脚本用 dsh* 测试账号（已被既有来源分类标成 TEST，不进排行榜），排队后立即离队，不留对局。
 */
import { WebSocket } from 'ws';
import { api, registerDemo } from './lib/scriptedGame.mjs';
import { DEFAULT_QUEUE_TIMEOUT_MS } from '../../shared/src/product/queuePolicy.js';
import { PROTOCOL_VERSION, RULESET_VERSION } from '../../shared/src/product/protocol.js';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const WSURL = process.env.SRSZQ_WS_URL ?? 'wss://api.srszq.com/ws';

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const user = await registerDemo(API);
ok(!!user.token, '拿到线上测试账号（dsh* 前缀 → 来源标记 TEST）');

const msgs: Array<Record<string, any>> = [];
const ws = new WebSocket(WSURL + '?token=' + encodeURIComponent(user.token) + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION));
await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw))); });
await sleep(300);

const t0 = Date.now();
ws.send(JSON.stringify({ type: 'queue.join' }));
let joined: Record<string, any> | null = null;
while (Date.now() - t0 < 15000) {
  joined = msgs.find((m) => m.type === 'queue.joined') ?? null;
  if (joined) break;
  await sleep(100);
}
ws.send(JSON.stringify({ type: 'queue.leave' }));

ok(!!joined, '收到 queue.joined（线上真实排队响应）');
const declared = Number(joined?.timeoutMs);
const window = Number(joined?.deadlineAt) - Number(joined?.enqueuedAt);
const serverNowSkew = Math.abs(Number(joined?.serverNow) - Date.now());
ok(declared === DEFAULT_QUEUE_TIMEOUT_MS, '线上下发的 timeoutMs = ' + declared + '（期望 ' + DEFAULT_QUEUE_TIMEOUT_MS + '）');
ok(Math.abs(window - DEFAULT_QUEUE_TIMEOUT_MS) <= 250, '线上 deadline 窗口 = ' + window + 'ms（期望约 ' + DEFAULT_QUEUE_TIMEOUT_MS + '）');
ok(serverNowSkew < 60000, '服务器时钟与本地偏差在合理范围（' + serverNowSkew + 'ms）');

// 立刻离队：确认没有把自己留在一个会自动 AI 补位的房间里
await sleep(600);
const started = msgs.filter((m) => m.type === 'game.start').length;
ok(started === 0, '离队后没有开局（离线排队不算弃权、也不该进局）：game.start=' + started);
try { ws.close(); } catch { /* noop */ }

console.log('OBSERVED ' + JSON.stringify({ declaredTimeoutMs: declared, deadlineWindowMs: window, skewMs: serverNowSkew, api: API }));
console.log('PUBLIC QUEUE CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
process.exit(failures === 0 ? 0 : 1);
