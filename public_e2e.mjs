
// 公网端到端验收：https://api.srszq.com + wss://api.srszq.com/ws
// 用一个明确标注为 DEMO 的合成账号，走真实注册 -> 真实 WS -> 真实 P0B 命令信封 -> 真实 ACK。
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const API = 'https://api.srszq.com';
const WS = 'wss://api.srszq.com/ws?protocol=2&ruleset=formal-rules-v2';
const stamp = Date.now().toString(36);
// 生产校验规则：用户名必须 2-16 位 [A-Za-z0-9_\u4e00-\u9fa5]，所以这里保持短且明确标为 DEMO。
const username = ('dshp0b' + stamp).slice(0, 16);
const email = ('dsh.demo.p0b.' + stamp + '@example.invalid').toLowerCase();
const password = 'Demo-P0B-' + stamp + '!3';

const log = (...a) => console.log(...a);
let failures = 0;
const ok = (c, m) => { if (c) log('  PASS ' + m); else { failures++; log('  FAIL ' + m); } };

async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const main = async () => {
  log('=== 1) 公网版本核验 ===');
  const v = await api('GET', '/api/version');
  ok(v.status === 200, '/api/version http=' + v.status + ' ' + JSON.stringify(v.json));
  ok(v.json?.protocol?.protocolVersion === 2, 'protocolVersion === 2');
  ok(v.json?.protocol?.rulesetVersion === 'formal-rules-v2', 'rulesetVersion === formal-rules-v2');

  const f = await api('GET', '/api/config/features');
  ok(f.json?.flags?.ratingBeta === false, 'ratingBeta 默认 OFF');
  ok(f.json?.flags?.invitusShadow === false, 'invitusShadow 默认 OFF');
  ok(f.json?.flags?.ratingBeta === false && f.json?.evidence?.[0]?.isDefault === true, '开关可被第三方复核（evidence.isDefault）');

  log('=== 2) 公网注册 DEMO 账号 ===');
  const reg = await api('POST', '/api/register', { email, username, password });
  ok(reg.status === 201, 'register http=' + reg.status);
  const token = reg.json?.token;
  ok(!!token, '拿到 token');

  log('=== 3) 公网 wss 连接 + P0B 命令信封 ===');
  const ws = new WebSocket(WS + '&token=' + encodeURIComponent(token));
  const msgs = [];
  let revision = 0;
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (typeof m.revision === 'number') revision = m.revision; msgs.push(m); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ok(true, 'wss://api.srszq.com/ws 已连接');

  const hello = await (async () => { const t = Date.now(); while (Date.now() - t < 6000) { const i = msgs.findIndex(m => m.type === 'hello'); if (i >= 0) return msgs.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 30)); } return null; })();
  ok(!!hello, '收到 hello');
  ok(hello?.protocol?.protocolVersion === 2, 'hello 携带 protocolVersion=2');

  await api('POST', '/api/tutorial/complete', {}, token);
  ws.send(JSON.stringify({ type: 'queue.join' }));

  // 生产队列超时为 60s（SRSZQ_QUEUE_TIMEOUT_MS=60000），1 真人需等 AI 补位，因此等 85s。
  const start = await (async () => { const t = Date.now(); while (Date.now() - t < 85000) { const i = msgs.findIndex(m => m.type === 'game.start'); if (i >= 0) return msgs.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 100)); } return null; })();
  ok(!!start, '匹配成功并收到 game.start');
  if (!start) { ws.close(); return; }
  ok(start.revision === 0, 'game.start.revision === 0');
  // 用 HTTP 端点报出的 releaseId 作基准，而不是写死某个批次号：
  // 断言的是「HTTP 与 WebSocket 报告同一个版本」，批次变了不该让测试失真。
  ok(start.protocol?.releaseId === v.json?.protocol?.releaseId,
    'game.start 的 releaseId 必须与 /api/version 一致（http=' + v.json?.protocol?.releaseId + ' ws=' + start.protocol?.releaseId + '）');
  const mySeat = start.yourSeat;
  const aiCount = Object.values(start.seats).filter(s => s.kind === 'ai').length;
  ok(aiCount === 2, '1H+2AI 补位，ai=' + aiCount);

  // 等轮到自己
  let state = start.state;
  let ack = null;
  let expectedAtSend = 0;
  const cmd = randomUUID();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === 'command.rejected') { log('  拒绝: ' + JSON.stringify(msgs[i])); failures++; }
    const ai = msgs.findIndex(m => m.type === 'ack'); if (ai >= 0) { ack = msgs.splice(ai, 1)[0]; break; }
    const si = msgs.findIndex(m => m.type === 'game.state');
    if (si >= 0) {
      const msg = msgs.splice(si, 1)[0];
      state = msg.state;
      const cur = state.turnOrder ? null : null;
      // 用共享规则判断是否轮到自己：直接看 moves 数量奇偶不可靠，改为按服务器 turnIndex 与座位映射
      const order = ['A','B','C'];
      const actor = order[state.turnIndex % 3];
      if (state.status === 'playing' && actor === mySeat) {
        const cells = [];
        for (let r = 0; r < state.boardSize; r++) for (let c = 0; c < state.boardSize; c++) if (!state.board[r][c]) cells.push({ r, c });
        if (cells.length) { const p = cells[0];
          expectedAtSend = revision;
          ws.send(JSON.stringify({ type: 'move', commandId: cmd, expectedRevision: expectedAtSend, row: p.r, col: p.c }));
          log('  已发送 move commandId=' + cmd.slice(0,8) + ' expectedRevision=' + expectedAtSend);
        }
      }
    } else await new Promise(r => setTimeout(r, 30));
  }
  ok(!!ack, '收到 ACK（命令已生效并落库）');
  if (ack) {
    ok(ack.commandId === cmd, 'ACK.commandId 与提交一致');
    // AI 座位可能先走过，所以断言必须是**相对**的：本命令让 revision 从
    // 提交时声明的 expectedRevision 恰好 +1，seq 与之同步。
    ok(ack.revision === expectedAtSend + 1, 'ACK.revision === expectedRevision+1（' + expectedAtSend + ' -> ' + ack.revision + '）');
    ok(ack.seq === ack.revision, 'ACK.seq 与 revision 同步（' + ack.seq + '）');
  }

  // 幂等重放：同 commandId 再发一次
  if (ack) {
    msgs.length = 0;
    ws.send(JSON.stringify({ type: 'move', commandId: cmd, expectedRevision: 0, row: ack.applied.row, col: ack.applied.col }));
    const ack2 = await (async () => { const t = Date.now(); while (Date.now() - t < 8000) { const i = msgs.findIndex(m => m.type === 'ack'); if (i >= 0) return msgs.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 30)); } return null; })();
    ok(!!ack2, '重发同一 commandId 得到 ACK 回放');
    ok(ack2?.revision === ack.revision && ack2?.seq === ack.seq, '重放不推进 revision/seq');
  }

  // 过期 revision 必须被拒
  msgs.length = 0;
  ws.send(JSON.stringify({ type: 'move', commandId: randomUUID(), expectedRevision: 999, row: 0, col: 0 }));
  const rej = await (async () => { const t = Date.now(); while (Date.now() - t < 8000) { const i = msgs.findIndex(m => m.type === 'command.rejected'); if (i >= 0) return msgs.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 30)); } return null; })();
  ok(!!rej, '过期 revision 被拒绝，code=' + rej?.code);
  ok(rej?.code === 'STALE_REVISION', 'code === STALE_REVISION');

  ws.send(JSON.stringify({ type: 'PLAYER_RESIGN' }));
  await new Promise(r => setTimeout(r, 1500));
  ws.close();

  // ---- P0C 公网安全断言 ----
  log('=== 4) 公网 P0C 安全边界 ===');
  const unauth = await new Promise((resolve) => {
    const bad = new WebSocket('wss://api.srszq.com/ws');
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    bad.on('unexpected-response', (_req, res) => { bad.terminate(); done({ rejectedBeforeUpgrade: true, statusCode: res.statusCode }); });
    bad.on('error', (e) => {
      const m = /Unexpected server response: (\d{3})/.exec(String(e?.message ?? ''));
      done(m ? { rejectedBeforeUpgrade: true, statusCode: Number(m[1]) } : { rejectedBeforeUpgrade: false, error: String(e?.message ?? e) });
    });
    bad.on('open', () => { bad.close(); done({ rejectedBeforeUpgrade: false }); });
    setTimeout(() => done({ rejectedBeforeUpgrade: false, error: 'timeout' }), 8000);
  });
  ok(unauth.rejectedBeforeUpgrade === true && unauth.statusCode === 401,
    '公网未认证 WSS 必须在握手前被 401 拒绝，实际 ' + JSON.stringify(unauth));

  const badOrigin = await new Promise((resolve) => {
    const evil = new WebSocket('wss://api.srszq.com/ws?token=' + encodeURIComponent(token), { headers: { Origin: 'https://evil.example' } });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    evil.on('unexpected-response', (_req, res) => { evil.terminate(); done({ rejectedBeforeUpgrade: true, statusCode: res.statusCode }); });
    evil.on('error', (e) => {
      const m = /Unexpected server response: (\d{3})/.exec(String(e?.message ?? ''));
      done(m ? { rejectedBeforeUpgrade: true, statusCode: Number(m[1]) } : { rejectedBeforeUpgrade: false, error: String(e?.message ?? e) });
    });
    evil.on('open', () => { evil.close(); done({ rejectedBeforeUpgrade: false }); });
    setTimeout(() => done({ rejectedBeforeUpgrade: false, error: 'timeout' }), 8000);
  });
  ok(badOrigin.rejectedBeforeUpgrade === true && badOrigin.statusCode === 403,
    '公网伪造 Origin 必须在握手前被 403 拒绝，实际 ' + JSON.stringify(badOrigin));

  log('=== 观测 ===');
  log('  DEMO_USER=' + username + ' seat=' + mySeat);
  log(failures === 0 ? 'PUBLIC E2E: ALL PASS 0' : 'PUBLIC E2E: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
