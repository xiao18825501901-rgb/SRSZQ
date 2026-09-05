import type { GameState, Player } from '../game/types';
import { getLegalMoves } from '../game/legalMoves';
import type { AIDecision } from './types';
import type { RNG } from './rng';

/**
 * LEVEL 1 — RANDOM：均匀随机选择合法动作。
 * 只使用引擎 getLegalMoves；不做任何战术/防守/资格预测（除非只有一个合法动作）。
 */
export function randomAgent(state: GameState, player: Player, rng: RNG): AIDecision {
  const legal = getLegalMoves(state);
  if (legal.length === 0) {
    return { row: -1, col: -1, pass: true, reason: 'No legal move' };
  }
  const m = legal[Math.floor(rng.next() * legal.length)];
  void player;
  return { row: m.row, col: m.col, pass: false, reason: legal.length === 1 ? 'Only legal move' : 'Random legal move' };
}
