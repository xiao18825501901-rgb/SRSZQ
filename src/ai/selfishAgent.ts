import type { GameState, Player } from '../game/types';
import { getLegalMoves } from '../game/legalMoves';
import { applyMove } from '../game/rules';
import { evaluateForPlayer, roundsUntilEligible } from './evaluation';
import type { AIDecision } from './types';
import type { RNG } from './rng';

/**
 * LEVEL 3 — SELFISH：1-ply BAC 资格感知评估的「自利」AI。
 *
 * 与 Tactical 的本质区别：不「见威胁就防」。
 * 它把「自己未来获胜概率」作为唯一目标 —— 评估函数已包含：
 * - 己方/对方棋型按 BAC 资格距离加权（roundsUntilEligible）；
 * - 自己即将获权时进攻棋型价值上升；
 * - 对方获权时的威胁上升（但防守只是分数的一部分：若防守让第三人渔利或自损过大，会选择不防）；
 * - 禁手自陷惩罚（无资格时自己的三连可能是双刃剑）。
 */
export function selfishAgent(state: GameState, player: Player, rng: RNG): AIDecision {
  const legal = getLegalMoves(state);
  if (legal.length === 0) return { row: -1, col: -1, pass: true, reason: 'No legal move' };

  let bestScore = -Infinity;
  const bestMoves: Array<{ row: number; col: number }> = [];
  let winMove: { row: number; col: number } | null = null;

  for (const m of legal) {
    const res = applyMove(state, m.row, m.col);
    if (res.rejected) continue; // 引擎二次校验（不应发生）
    if (res.state.status === 'won' && res.state.winner === player) {
      winMove = { row: m.row, col: m.col };
      break; // 立即胜点：直接获胜
    }
    const score = evaluateForPlayer(res.state, player);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      bestMoves.length = 0;
      bestMoves.push({ row: m.row, col: m.col });
    } else if (Math.abs(score - bestScore) <= 1e-9) {
      bestMoves.push({ row: m.row, col: m.col });
    }
  }

  if (winMove) return { row: winMove.row, col: winMove.col, pass: false, reason: 'Immediate win' };

  const pick = bestMoves[Math.floor(rng.next() * bestMoves.length)];
  const dist = roundsUntilEligible(state, player);
  const reason =
    dist === 0
      ? 'Selfish best (own eligibility now)'
      : `Selfish best (own eligibility in ${dist} round${dist === 1 ? '' : 's'})`;
  return { row: pick.row, col: pick.col, pass: false, reason, score: [bestScore] };
}
