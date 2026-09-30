/**
 * 线上 G16 探针：真连生产 WS，验证“同一账号的新连接会替换旧连接”。
 *
 *   npx tsx scripts/dev/public-multitab-check.mts
 *
 * 用 dsh* 测试账号（既有来源分类会标成 TEST，不进排行榜）。
 * 断言：
 *  1. 第一条连接先 hello；
 *  2. 第二条连接（同 token）建立后，**第一条被服务端关闭**，关闭码为 4000（协议约定的“被替换”）；
 *  3. 第二条仍然可用（入队能收到 queue.joined），随后立即离队。
 */
import { WebSocket } from 'ws';
import { registerDemo } from './lib/scriptedGame.mjs';
import { PROTOCOL_VERSION, RULESET_VERSION, WS_CLOSE_REPLACED } from '../../shared/src/product/protocol.js';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const WSURL = process.env.SRSZQ_WS_URL ?? 'wss://api.srszq.com/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };

interface Cli { ws: WebSocket; msgs: Array<Record<string, any>>; closedCode: number | null; reason: string }
function connect(token: string): Promise<Cli> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL + '?token=' + encodeURIComponent(token) + '&protocol=' + PROTOCOL_VERSION + '&ruleset=' + encodeURIComponent(RULESET_VERSION), { handshakeTimeout: 10000 });
    const cli: Cli = { ws, msgs: [], closedCode: null, reason: '' };
    ws.on('message', (raw) => cli.msgs.push(JSON.parse(String(raw))));
    ws.on('close', (code, reason) => { cli.closedCode = code; cli.reason = String(reason); });
    ws.on('error', reject);
    ws.on('open', () => resolve(cli));
  });
}
async function waitMsg(c: Cli, type: string, timeoutMs = 10000): Promise<any | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const m = c.msgs.find((x) => x.type === type);
    if (m) return m;
    await sleep(100);
  }
  return null;
}

const user = await registerDemo(API, 'g16', Date.now().toString(36), 'Passw0rd!23');
ok(!!user.token, '拿到线上测试账号（dsh* → 来源标记 TEST）');

const first = await connect(user.token);
ok(!!(await waitMsg(first, 'hello', 10000)), '第一条连接收到 hello');

const second = await connect(user.token);
ok(!!(await waitMsg(second, 'hello', 10000)), '第二条连接（同 token）收到 hello');

for (let i = 0; i < 60 && first.closedCode === null; i += 1) await sleep(100);
ok(first.closedCode === WS_CLOSE_REPLACED, '第一条连接被服务端关闭且关闭码为 4000（实际 ' + first.closedCode + '）');
ok(String(first.reason).includes('replaced'), '关闭原因说明被替换：' + first.reason);
ok(first.ws.readyState === WebSocket.CLOSED, '第一条连接的底层 socket 已关闭（readyState=' + first.ws.readyState + '）');

second.ws.send(JSON.stringify({ type: 'queue.join' }));
const joined = await waitMsg(second, 'queue.joined', 15000);
ok(!!joined, '第二条连接仍可用（收到 queue.joined）');
ok(!!joined && Number(joined.timeoutMs) === 20000, '排队窗口仍是 20 秒（实际 ' + (joined && joined.timeoutMs) + '）');
second.ws.send(JSON.stringify({ type: 'queue.leave' }));
await sleep(400);
ok(second.msgs.filter((m) => m.type === 'game.start').length === 0, '离队后没有开局（不留残局）');
try { second.ws.close(); } catch { /* noop */ }

console.log('OBSERVED ' + JSON.stringify({ ws: WSURL, firstCloseCode: first.closedCode, firstReason: first.reason, secondQueueMs: joined && joined.timeoutMs }));
console.log('PUBLIC MULTITAB CHECK: ' + (failures === 0 ? 'ALL PASS 0' : 'FAILED ' + failures));
process.exit(failures === 0 ? 0 : 1);
