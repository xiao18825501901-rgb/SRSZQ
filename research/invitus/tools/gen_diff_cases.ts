/**
 * Invitus differential oracle generator：
 * 用生产 shared 引擎随机生成 N 个合法中间局面，输出每局面的权威字段
 * （currentPlayer/round/eligible/legal/forbidden + 首步 probe apply 结果），
 * 供 Python 训练引擎逐字段比对。
 * 运行：npx tsx research/invitus/tools/gen_diff_cases.ts <N> <out.jsonl>
 */
import { createInitialState, applyMove } from '../../../shared/src/game/rules.js';
import { currentPlayerOf, currentRoundOf, eligibleOf, getForbiddenCells, getLegalMoves } from '../../../shared/src/game/legalMoves.js';
import { writeFileSync } from 'node:fs';

const N = Number(process.argv[2] ?? 100000);
const out = process.argv[3] ?? 'research/invitus/logs/diff_cases.jsonl';

const lines: string[] = [];
for (let i = 0; i < N; i++) {
  const size = Math.random() < 0.8 ? 13 : 17;
  let st = createInitialState(size as 13 | 17);
  const k = Math.floor(Math.random() * 40);
  for (let j = 0; j < k; j++) {
    if (st.status !== 'playing') break;
    const legal = getLegalMoves(st);
    if (legal.length === 0) break;
    const m = legal[Math.floor(Math.random() * legal.length)];
    const res = applyMove(st, m.row, m.col);
    if (res.rejected) break;
    st = res.state;
  }
  // 若已终局，仍输出终局面（含 winner/status 对齐）；再选一个“进行中”局面做 probe
  const legal = st.status === 'playing' ? getLegalMoves(st) : [];
  const forbidden = st.status === 'playing' ? getForbiddenCells(st) : [];
  const probe = legal.length > 0 ? legal[Math.floor(Math.random() * legal.length)] : null;
  let post = null;
  if (probe) {
    const r = applyMove(st, probe.row, probe.col);
    post = { status: r.state.status, winner: r.state.winner, turnIndex: r.state.turnIndex, movesLen: r.state.moves.length };
  }
  lines.push(JSON.stringify({
    board: st.board,
    boardSize: st.boardSize,
    turnIndex: st.turnIndex,
    movesLen: st.moves.length,
    status: st.status,
    winner: st.winner,
    expected: {
      currentPlayer: st.status === 'playing' ? currentPlayerOf(st) : null,
      round: currentRoundOf(st),
      eligible: eligibleOf(st),
      legal: legal.map((m) => [m.row, m.col]),
      forbidden: forbidden.map((c) => [c.row, c.col]),
    },
    probe: probe ? { row: probe.row, col: probe.col, post } : null,
  }));
  if (i % 20000 === 0) process.stdout.write(`gen ${i}/${N}\n`);
}
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`WROTE ${N} cases -> ${out}`);
