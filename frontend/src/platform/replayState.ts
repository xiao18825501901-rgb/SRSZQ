/**
 * 用真实引擎把落子序列重建成局面（复盘 / 题库 / 分享复盘共用）。
 *
 * 纯函数、无 React/DOM 依赖：单测可直接跑。
 * `upto` 用于“正在查看第 N 步”的场景——棋盘与胜权时间线都必须跟随用户当前查看的局面，
 * 而不是永远停在最后一手。
 */
import type { BoardSize, GameState } from '../../../shared/src/game/types';
import { applyMove, createInitialState } from '../../../shared/src/game/rules';

/** 用真实引擎重建局面；任何一手被引擎拒绝都会被计数并暴露出来。 */
export function buildStateFromMoves(
  boardSize: BoardSize,
  moves: Array<{ row: number; col: number }>,
  upto?: number,
): { state: GameState; rejected: number } {
  const limit = upto === undefined ? moves.length : Math.max(0, Math.min(upto, moves.length));
  let state = createInitialState(boardSize);
  let rejected = 0;
  for (let i = 0; i < limit; i++) {
    const res = applyMove(state, moves[i].row, moves[i].col);
    if (res.rejected) { rejected += 1; continue; }
    state = res.state;
  }
  return { state, rejected };
}
