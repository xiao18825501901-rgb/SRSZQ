
/**
 * 公网行为验收（P2）：历史 / 全谱重放 / 关键三手 / 跨轮防守 / 去标识分享。
 *
 * 为什么要在真实域名上跑：本地测试用的是本机 GameServer + 临时库，
 * 只能证明代码逻辑成立；只有真实域名 + 真实 nginx + 真实 PM2 进程 +
 * 真实 SQLite 才能证明“部署上去之后是这么工作的”。
 *
 * 流程：注册 3 个 DEMO 账号 -> 三人同房 -> 按固定脚本走 20 手真实对局
 *      -> 用 HTTPS 校验历史/重放/关键片段/分享撤销，并核对竞技分。
 */
import { WebSocket } from 'ws';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const WSURL = process.env.SRSZQ_WS_URL ?? 'wss://api.srszq.com/ws';
const stamp = Date.now().toString(36);
const password = 'Demo-P2-' + stamp + '!3';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS ' + m); else { failures++; console.log('  FAIL ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), json: null };
}
async function apiJson(method, path, body, token) {
  const r = await api(method, path, body, token);
  try { r.json = JSON.parse(r.text); } catch { r.json = null; }
  return r;
}

const SCRIPT = [
  [5, 5], [6, 1], [0, 1],
  [10, 10], [6, 2], [0, 2],
  [10, 11], [6, 3], [0, 3],
  [10, 12], [11, 11], [12, 12],
  [5, 6], [11, 12], [12, 11],
  [0, 0], [11, 10], [2, 2],
  [5, 7], [6, 4],
];
const SEATS = ['A', 'B', 'C'];

function connect(token, msgs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL + '?protocol=2&ruleset=formal-rules-v2&token=' + encodeURIComponent(token));
    ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
async function grab(msgs, type, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = msgs.findIndex((m) => m.type === type);
    if (i >= 0) return msgs.splice(i, 1)[0];
    await sleep(50);
  }
  return null;
}

const main = async () => {
  console.log('=== 公网版本 ===');
  const v = await apiJson('GET', '/api/version');
  ok(v.json?.protocol?.protocolVersion === 2, 'protocolVersion=2 release=' + v.json?.protocol?.releaseId);
  const release = v.json?.protocol?.releaseId;

  console.log('=== 注册 3 个 DEMO 账号并完成教学 ===');
  const users = [];
  for (const tag of ['a', 'b', 'c']) {
    const username = ('dshp2' + tag + stamp).slice(0, 16);
    const email = ('dsh.p2.' + tag + '.' + stamp + '@example.invalid').toLowerCase();
    const reg = await apiJson('POST', '/api/register', { email, username, password });
    ok(reg.status === 201, 'register ' + tag + ' http=' + reg.status);
    if (reg.status !== 201) { console.log('FATAL: 注册失败 ' + reg.text.slice(0, 200)); process.exit(1); }
    await apiJson('POST', '/api/tutorial/complete', {}, reg.json.token);
    const me = await apiJson('GET', '/api/me', undefined, reg.json.token);
    users.push({ tag, username, email, token: reg.json.token, id: reg.json.user.id, rating: me.json.user.rating });
  }
  console.log('  DEMO_USERS=' + users.map((u) => u.username).join(',') + ' 初始分=' + users.map((u) => u.rating).join('/'));

  console.log('=== 三人同房，按脚本走 20 手 ===');
  const msgs = [[], [], []];
  const wss = [];
  for (let i = 0; i < 3; i += 1) wss.push(await connect(users[i].token, msgs[i]));
  for (const ws of wss) ws.send(JSON.stringify({ type: 'queue.join' }));
  const starts = await Promise.all([0, 1, 2].map((i) => grab(msgs[i], 'game.start', 90000)));
  ok(starts.every(Boolean), '三人匹配成功');
  if (!starts.every(Boolean)) { wss.forEach((w) => w.close()); process.exit(1); }
  const gameId = starts[0].gameId;
  const human = Object.values(starts[0].seats).filter((s) => s.kind === 'human').length;
  ok(human === 3, '必须是 3 真人同房，human=' + human);
  ok(starts[0].protocol?.releaseId === release, 'game.start 的 releaseId 与 /api/version 一致');
  const ofSeat = {};
  for (let i = 0; i < 3; i += 1) ofSeat[starts[i].yourSeat] = i;
  ok(Object.keys(ofSeat).sort().join('') === 'ABC', '三个座位都有主人：' + JSON.stringify(ofSeat));

  let ackFail = 0;
  for (let i = 0; i < SCRIPT.length; i += 1) {
    const idx = ofSeat[SEATS[i % 3]];
    const [row, col] = SCRIPT[i];
    wss[idx].send(JSON.stringify({ type: 'move', commandId: 'pub-' + gameId + '-' + i, row, col }));
    const ack = await grab(msgs[idx], 'ack', 15000);
    if (!ack) ackFail += 1;
  }
  ok(ackFail === 0, '20 手全部被服务端接受（ackFail=' + ackFail + '）');
  const ended = await grab(msgs[ofSeat.B], 'MATCH_ENDED', 15000);
  ok(!!ended && ended.winner === 'B', '终局胜者为座位 B：' + JSON.stringify(ended?.winner));
  await sleep(1500);
  wss.forEach((w) => { try { w.close(); } catch { /* noop */ } });

  console.log('=== R01 历史：三人各自可读，胜者 WIN、其余 LOSS，手数 20 ===');
  const hists = [];
  for (const u of users) hists.push(await apiJson('GET', '/api/history?limit=10&offset=0', undefined, u.token));
  ok(hists.every((h) => h.status === 200), '三人 /api/history 均 200');
  const items = hists.map((h) => (h.json.history || []).find((x) => x.gameId === gameId));
  ok(items.every(Boolean), '本局出现在三人的历史里');
  ok(items.every((x) => x.moveCount === SCRIPT.length), 'moveCount 均为 ' + SCRIPT.length + '：' + JSON.stringify(items.map((x) => x.moveCount)));
  ok(items.every((x) => x.winnerSeat === 'B' && x.endReason === 'NORMAL_WIN'), 'endReason/winnerSeat 正确');
  const bySeat = {};
  items.forEach((x) => { bySeat[x.seat] = x.outcome; });
  ok(bySeat.A === 'LOSS' && bySeat.B === 'WIN' && bySeat.C === 'LOSS', '名次：' + JSON.stringify(bySeat));
  const histBlob = JSON.stringify(hists.map((h) => h.json));
  ok(!users.some((u) => histBlob.includes(u.email)), '历史响应不含任何邮箱');
  ok(!users.some((u) => histBlob.includes(u.id)), '历史响应不含任何用户 id');

  console.log('=== R02/R03 全谱重放与关键三手（由胜者账号读取） ===');
  const winner = users[ofSeat.B];
  const rep = await apiJson('GET', '/api/games/' + gameId + '/replay', undefined, winner.token);
  ok(rep.status === 200, '重放 http=' + rep.status);
  const rp = rep.json?.replay;
  ok(rp?.replayOk === true, 'replayOk=true errors=' + JSON.stringify(rp?.replayErrors));
  ok(rp?.hashMatches === true, '重放摘要与服务器持久快照一致 hashMatches=' + rp?.hashMatches);
  ok((rp?.finalHash || '').length === 32, 'finalHash 为 32 位十六进制：' + rp?.finalHash);
  ok(rp?.moveCount === SCRIPT.length, 'moveCount=' + rp?.moveCount);
  const km = rp?.keyMoves || [];
  ok(km.length === 3, '恰好 3 个关键片段：' + JSON.stringify(km.map((k) => k.type + '@' + k.ply + '/' + k.actorSeat + '(' + k.row + ',' + k.col + ')')));
  ok(km.map((k) => k.type).join(',') === 'IMMEDIATE_WIN,MISSED_WIN,PREEMPTIVE_BLOCK', '三个片段类型与顺序正确');
  ok(km.every((k) => k.certainty === 'EXACT_ONE_PLY' && k.proofHorizon === 1), 'certainty 全为精确一步');
  ok(km.every((k) => k.wallMs >= 0 && k.nodes > 0), '每个片段都报告了预算口径');
  const block = km.find((k) => k.type === 'PREEMPTIVE_BLOCK');
  ok(block?.args?.threatened === 'C', '遮挡的是本轮胜权持有者 C');
  ok(block?.defenseWindow?.resolvedBySeat === 'A' && block?.defenseWindow?.resolvedAtPly === block?.ply, '遮挡窗口与实际动作对应');
  ok(block?.defenseWindow?.actions?.length === 7, '窗口收录从威胁出现到兑现的 7 手（不只数遮挡者）');
  const missed = km.find((k) => k.type === 'MISSED_WIN');
  ok(missed?.points?.length === 1 && missed.points[0].row === 0 && missed.points[0].col === 4, '错失的致胜点为 (0,4)：' + JSON.stringify(missed?.points));
  const repBlob = JSON.stringify(rep.json);
  ok(!repBlob.includes('胜率') && !repBlob.includes('winRate'), '重放响应不含胜率措辞');

  console.log('=== R06 分享：创建 -> 匿名读取 -> 撤销 ===');
  const created = await apiJson('POST', '/api/games/' + gameId + '/share', {}, winner.token);
  ok(created.status === 201, '创建分享 http=' + created.status);
  const share = created.json?.share;
  ok(share?.ttlMs === 7 * 24 * 3600 * 1000, 'TTL 为 7 天：' + share?.ttlMs);
  const pub = await api('GET', '/api/shared/' + share.token);
  ok(pub.status === 200, '匿名读取 http=' + pub.status);
  ok(!pub.text.includes(gameId), '公开视图不含 gameId');
  ok(!users.some((u) => pub.text.includes(u.id) || pub.text.includes(u.username) || pub.text.includes(u.email)), '公开视图不含任何用户标识/邮箱/用户名');
  const pubJson = JSON.parse(pub.text);
  ok(pubJson.shared?.moveCount === SCRIPT.length, '公开视图手数=' + pubJson.shared?.moveCount);
  ok(pubJson.shared?.keyMoves?.length === 3, '公开视图带 3 个已证实片段');
  ok(pubJson.shared?.seats?.length === 3 && pubJson.shared.seatLabels?.C, '公开视图有 3 个座位与棋色标签（白棋可辨）');
  const revoked = await apiJson('DELETE', '/api/share/' + share.token, undefined, winner.token);
  ok(revoked.status === 200 && revoked.json?.revoked === true, '撤销 http=' + revoked.status);
  const after = await api('GET', '/api/shared/' + share.token);
  ok(after.status === 410, '撤销后不可访问 http=' + after.status + ' ' + after.text.slice(0, 60));

  console.log('=== 竞技分：3 真人 online 局在 beta 关闭时按 legacy 结算 ===');
  const after2 = [];
  for (const u of users) {
    const me = await apiJson('GET', '/api/me', undefined, u.token);
    after2.push(me.json.user.rating);
  }
  const deltas = after2.map((v2, i) => v2 - users[i].rating);
  const winIdx = ofSeat.B;
  ok(deltas[winIdx] === 30, '胜者 +30，实际 ' + deltas[winIdx]);
  ok(deltas.filter((d, i) => i !== winIdx).every((d) => d === -10), '两名败者 -10，实际 ' + JSON.stringify(deltas));

  console.log('=== 观测 ===');
  console.log('  RELEASE=' + release);
  console.log('  GAME=' + gameId);
  console.log('  finalHash=' + rp?.finalHash + ' reviewCacheKey=' + rp?.reviewCacheKey);
  console.log('  keyMoves=' + JSON.stringify(km.map((k) => k.type + '@' + k.ply)));
  console.log('  ratingDeltas=' + JSON.stringify(deltas));
  console.log(failures === 0 ? 'PUBLIC REPLAY CHECK: ALL PASS 0' : 'PUBLIC REPLAY CHECK: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });