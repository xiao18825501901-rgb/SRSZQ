import type { GameState, Player } from '../game/types';
import { currentPlayerIsEligible, eligibleOf, getLegalMoves, getWinningPoints } from '../game/legalMoves';
import { getEligiblePlayer } from '../game/eligibility';
import { currentRoundOf } from '../game/legalMoves';
import type { AIDecision } from './types';
import type { RNG } from './rng';
import { maxRunThrough } from './threatAnalysis';

const OTHERS: Record<Player, Player[]> = {
  A: ['B', 'C'],
  B: ['A', 'C'],
  C: ['A', 'B'],
};

/**
 * LEVEL 2 — TACTICAL：只看当前局面的直接战术（无深层搜索）：
 * 1. 自己 Eligible 且有立即胜点 → 获胜；
 * 2. 当前轮 Eligible 对手有立即胜点且自己可堵 → 封堵；
 * 3. 即将获权的对手有直接胜点 → 预防；
 * 4. 制造自己的三连 / 二连；
 * 5. 中心性/邻接性；随机打破同分。
 */
export function tacticalAgent(state: GameState, player: Player, rng: RNG): AIDecision {
  const legal = getLegalMoves(state);
  if (legal.length === 0) return { row: -1, col: -1, pass: true, reason: 'No legal move' };
  const legalSet = new Set(legal.map((m) => `${m.row},${m.col}`));
  const meEligible = currentPlayerIsEligible(state);
  const round = currentRoundOf(state);
  const eligibleNow = eligibleOf(state);
  const winPoints = (p: Player) => getWinningPoints(state.board, p).filter((c) => legalSet.has(`${c.row},${c.col}`));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng.next() * arr.length)];
  const cells = legal.map((m) => ({ row: m.row, col: m.col }));

  // 1) 立即获胜
  if (meEligible) {
    const wins = winPoints(player);
    if (wins.length > 0) {
      const w = pick(wins);
      return { row: w.row, col: w.col, pass: false, reason: 'Immediate win' };
    }
  }

  // 2) 当前轮获权对手有立即胜点 → 封堵
  if (eligibleNow && eligibleNow !== player) {
    const oppWins = winPoints(eligibleNow);
    if (oppWins.length > 0) {
      const w = pick(oppWins);
      return { row: w.row, col: w.col, pass: false, reason: `Blocks ${eligibleNow} winning point` };
    }
  }

  // 3) 未来 2 轮内获权的对手有直接胜点 → 适度预防
  for (const opp of OTHERS[player]) {
    for (let r = round + 1; r <= round + 2; r++) {
      if (getEligiblePlayer(r) !== opp) continue;
      const oppWins = winPoints(opp);
      if (oppWins.length > 0) {
        const w = pick(oppWins);
        return { row: w.row, col: w.col, pass: false, reason: `Prevents ${opp} upcoming winning point` };
      }
    }
  }

  // 4) 制造三连 / 二连 / 阻止对方明显三连
  const threes: Array<{ row: number; col: number }> = [];
  const twos: Array<{ row: number; col: number }> = [];
  const blockThrees: Array<{ row: number; col: number }> = [];
  for (const c of cells) {
    const myRun = maxRunThrough(state.board, c.row, c.col, player);
    if (myRun === 3) threes.push(c);
    else if (myRun === 2) twos.push(c);
    // 阻止对手形成三连：对手在该点落子可成 3（其胜点已在 2/3 步覆盖）
    for (const opp of OTHERS[player]) {
      if (maxRunThrough(state.board, c.row, c.col, opp) >= 4) blockThrees.push(c);
    }
  }
  if (threes.length > 0) {
    const w = pick(threes);
    return { row: w.row, col: w.col, pass: false, reason: 'Create own three' };
  }
  if (blockThrees.length > 0) {
    // 仅当该点不会让自己形成 >=4（非资格禁手）时才属于 legal；这里都是 legal 点
    const w = pick(blockThrees);
    return { row: w.row, col: w.col, pass: false, reason: 'Blocks opponent threat' };
  }
  if (twos.length > 0) {
    const w = pick(twos);
    return { row: w.row, col: w.col, pass: false, reason: 'Create own two' };
  }

  // 5) 中心倾向 + 随机
  const center = (state.boardSize - 1) / 2;
  let best = cells[0];
  let bestScore = -1;
  const pool: Array<{ row: number; col: number }> = [];
  for (const c of cells) {
    const d = Math.max(Math.abs(c.row - center), Math.abs(c.col - center));
    const s = -d + rng.next() * 0.5;
    if (s > bestScore + 1e-9) {
      bestScore = s;
      best = c;
      pool.length = 0;
      pool.push(c);
    } else if (Math.abs(s - bestScore) <= 1e-9) {
      pool.push(c);
    }
  }
  if (pool.length > 0) best = pick(pool);
  return { row: best.row, col: best.col, pass: false, reason: 'Positional' };
}
