/**
 * 公网行为验收（P3B）：AI provider 现状与线上可用性。
 *
 *   npx tsx scripts/dev/public-provider-check.mts
 *
 * 这一批改动集中在共享的决策/分析接口上，因此公网要证明两件事：
 *  1. Invitus **没有**被接入：shadow flag 在线上是默认关闭值（可经 /api/config/features 复核）；
 *  2. 线上 AI 仍然真的在下棋：开一局 1H+2AI，要求 AI 座位在真实后端上走出合法手。
 * 第 2 条是行为回归——接口重构如果碰坏了决策路径，这里会立刻暴露。
 */
import { WebSocket } from 'ws';
import { api, registerDemo } from './lib/scriptedGame.mjs';
// 同上：期望版本从 shared 唯一真源来，不写死（曾写死 p3b-20260930）。
import { RELEASE_ID } from '../../shared/src/product/protocol.js';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const WSURL = process.env.SRSZQ_WS_URL ?? 'wss://api.srszq.com/ws';
const stamp = Date.now().toString(36);

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== 版本与开关（可外部复核） ===');
  const v = await api(API, 'GET', '/api/version');
  ok(v.json?.protocol?.releaseId === RELEASE_ID, 'releaseId=' + v.json?.protocol?.releaseId + '（期望 ' + RELEASE_ID + '）');
  const f = await api(API, 'GET', '/api/config/features');
  ok(f.json?.flags?.invitusShadow === false, 'Invitus shadow 关闭（' + f.json?.flags?.invitusShadow + '）');
  const evidence = (f.json?.evidence ?? []) as Array<{ key: string; parsedValue: boolean; isDefault: boolean; rawValue: string | null }>;
  const shadow = evidence.find((e) => e.key === 'invitusShadow');
  ok(!!shadow && shadow.isDefault === true, 'shadow 是**默认值**而非被谁打开过：isDefault=' + shadow?.isDefault + ' rawValue=' + String(shadow?.rawValue));
  ok(f.json?.flags?.ratingBeta === false, '评分 Beta 仍关闭');

  console.log('=== 线上 AI 仍然会下棋（行为回归） ===');
  const me = await registerDemo(API, 'pv', stamp, 'Demo-PB-' + stamp + '!3');
  const msgs: any[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(WSURL + '?protocol=2&ruleset=formal-rules-v2&token=' + encodeURIComponent(me.token));
    s.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
  const grab = async (type: string, ms: number): Promise<any> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = msgs.findIndex((m) => m.type === type);
      if (i >= 0) return msgs.splice(i, 1)[0];
      await sleep(50);
    }
    return null;
  };

  ws.send(JSON.stringify({ type: 'queue.join' }));
  const start = await grab('game.start', 90000);
  ok(!!start, '匹配成功（等待 AI 补位）');
  if (!start) { ws.close(); process.exit(1); }
  const aiSeats = Object.entries(start.seats as Record<string, { kind: string }>).filter(([, s]) => s.kind === 'ai').map(([k]) => k);
  ok(aiSeats.length === 2, '1H+2AI 快速局，AI 座位=' + aiSeats.join(','));
  const mySeat = start.yourSeat as 'A' | 'B' | 'C';
  ok(['A', 'B', 'C'].includes(mySeat), '本人座位=' + mySeat);

  // 座位是随机的（A→B→C 顺序行动）。要让**两个** AI 座位都走到，真人必须在自己回合落一手，
  // 除非真人正好是 C 座（两个 AI 都在他之前）。
  // 只处理 'A' 是不够的：真人 B 座时，A 走完就轮到真人，不落子永远只会有 1 手
  // —— 线上实测踩到，表现为“AI 只走出 1 手”的假失败（产品行为其实是正常的）。
  const board = (start.state?.board ?? []) as Array<Array<string | null>>;
  const emptyCell = (): { row: number; col: number } => {
    for (let r = 0; r < board.length; r += 1) for (let c = 0; c < board.length; c += 1) if (board[r][c] === null) return { row: r, col: c };
    return { row: 0, col: 0 };
  };
  if (mySeat !== 'C') {
    // 等轮到真人（场上已有 mySeatIndex 手）再落子。
    const myIndex = ({ A: 0, B: 1, C: 2 } as const)[mySeat];
    const waitT0 = Date.now();
    while (Date.now() - waitT0 < 20000) {
      const m = await grab('game.state', 2000);
      const moves = (m?.state?.moves?.length ?? 0) as number;
      if (moves >= myIndex) break;
    }
    const cell = emptyCell();
    ws.send(JSON.stringify({ type: 'move', commandId: 'pb-' + stamp, ...cell }));
    const ack = await grab('ack', 15000);
    ok(!!ack, '真人轮到后落子被接受（座位 ' + mySeat + '）');
  }

  let plies = 0;
  let illegal = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && plies < 3) {
    const m = await grab('game.state', 2000);
    if (!m) continue;
    plies = m.state?.moves?.length ?? plies;
    // 服务端每次广播的状态里，已落子的坐标必须是合法坐标
    const moves = (m.state?.moves ?? []) as Array<{ row?: number; col?: number; pass?: boolean }>;
    for (const mv of moves) {
      if (mv.pass) continue;
      if (!Number.isInteger(mv.row) || !Number.isInteger(mv.col)
        || (mv.row as number) < 0 || (mv.col as number) < 0
        || (mv.row as number) >= (m.state?.boardSize ?? 13) || (mv.col as number) >= (m.state?.boardSize ?? 13)) illegal += 1;
    }
    if (plies >= 3) break;
  }
  ws.close();
  ok(plies >= 2, 'AI 在真实后端上走出了棋：累计 ' + plies + ' 手');
  ok(illegal === 0, '线上广播的落子坐标全部合法（非法=' + illegal + '）');

  console.log('=== 站点可用性 ===');
  const rank = await api(API, 'GET', '/api/ranking?limit=5');
  ok(rank.status === 200, '/api/ranking 200');
  const site = await fetch('https://srszq.com', { method: 'GET' });
  ok(site.status === 200, 'srszq.com ' + site.status);

  console.log('=== 观测 ===');
  console.log('  release=' + v.json?.protocol?.releaseId);
  console.log('  invitusShadow=' + JSON.stringify(shadow));
  console.log('  demoUser=' + me.username + ' seat=' + mySeat + ' aiSeats=' + aiSeats.join(',') + ' plies=' + plies);
  console.log(failures === 0 ? 'PUBLIC PROVIDER CHECK: ALL PASS 0' : 'PUBLIC PROVIDER CHECK: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
