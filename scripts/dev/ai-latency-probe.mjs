
// 正确测量：让 1ms 定时器先正常运行，再在它监控下执行一次同步 AI 决策，
// 观察被推迟的那次 tick。
import { performance } from 'node:perf_hooks';
import { createInitialState, applyMove } from './shared/src/game/rules.js';
import { getLegalMoves, currentPlayerOf } from './shared/src/game/legalMoves.js';
import { chooseAIMove } from './shared/src/ai/chooseAIMove.js';

function buildMidGame(boardSize, plies, seed) {
  let s = createInitialState(boardSize);
  let x = seed >>> 0;
  const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 0x100000000; };
  for (let i = 0; i < plies && s.status === 'playing'; i++) {
    const legal = getLegalMoves(s);
    if (!legal.length) break;
    const m = legal[Math.floor(rnd() * legal.length)];
    const r = applyMove(s, m.row, m.col);
    if (r.rejected) break;
    s = r.state;
  }
  return s;
}

async function measure(state, seat, level) {
  let maxLag = 0; let last = performance.now(); let ticks = 0;
  const timer = setInterval(() => { ticks++; const now = performance.now(); const lag = now - last - 1; if (lag > maxLag) maxLag = lag; last = now; }, 1);
  await new Promise((r) => setTimeout(r, 30));         // 让定时器先稳定跑一会儿
  const t0 = performance.now();
  const d = chooseAIMove(state, seat, level, { seed: 777, timeBudgetMs: 250 });
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 40));         // 让被推迟的 tick 有机会被观察到
  clearInterval(timer);
  return { ms, maxLag, ticks, tactic: d.selectedTactic };
}

const rows = [];
for (const [boardSize, plies] of [[13, 24], [17, 40]]) {
  const state = buildMidGame(boardSize, plies, 12345);
  const seat = currentPlayerOf(state);
  for (const level of [1, 3, 5]) {
    const m = await measure(state, seat, level);
    rows.push({ boardSize, level, decisionMs: Number(m.ms.toFixed(1)), blockedEventLoopMs: Number(m.maxLag.toFixed(1)), tactic: m.tactic });
  }
}
console.log('board  level  decision_ms  blocked_event_loop_ms  tactic');
for (const r of rows) console.log(String(r.boardSize).padEnd(7) + String(r.level).padEnd(7) + String(r.decisionMs).padEnd(13) + String(r.blockedEventLoopMs).padEnd(23) + r.tactic);
const worst = rows.reduce((a, b) => (b.blockedEventLoopMs > a.blockedEventLoopMs ? b : a));
const total = rows.reduce((a, b) => a + b.blockedEventLoopMs, 0);
console.log('WORST_BLOCK=' + JSON.stringify(worst));
console.log('TOTAL_BLOCK_MS_OVER_' + rows.length + '_MOVES=' + total.toFixed(1));
