import type { GameState } from '../../game/types';
import { createInitialState, applyMove, undoMove } from '../../game/rules';
import { getLegalMoves } from '../../game/legalMoves';
import type { Player } from '../../game/types';
import { mulberry32 } from '../rng';

const P = ['A', 'B', 'C'] as const;

/** 用确定性随机对局生成一个处于正式规则 v2 对局中段的状态 */
export function randomMidGameState(seed: number, boardSize: 13 | 17 = 13, maxMoves = 40): GameState {
  const rng = mulberry32(seed);
  let s = createInitialState(boardSize);
  const target = Math.min(maxMoves, 1 + rng.int(boardSize * boardSize));
  for (let i = 0; i < target; i++) {
    if (s.status !== 'playing') break;
    const legal = getLegalMoves(s);
    if (legal.length === 0) break;
    const m = legal[rng.int(legal.length)];
    const res = applyMove(s, m.row, m.col);
    if (res.rejected) break;
    s = res.state;
  }
  return s;
}

/** 构造「某玩家在指定回合行动」的人工状态（棋盘预置棋子，turnIndex 指向其回合） */
export function stateWithTurn(boardSize: 13 | 17, stones: Array<[Player, number, number]>, turnIndex: number): GameState {
  const s = createInitialState(boardSize);
  const board = s.board.map((row) => row.slice());
  for (const [p, r, c] of stones) board[r][c] = p;
  return { ...s, board, turnIndex };
}

/** 深拷贝 game state（测试内安全修改） */
export function cloneState(s: GameState): GameState {
  return { ...s, board: s.board.map((r) => r.slice()), moves: s.moves.map((m) => ({ ...m })) };
}

export function applyN(s: GameState, moves: Array<[Player, number, number]>): GameState {
  let st = cloneState(s);
  for (const [p, r, c] of moves) {
    // 引擎 applyMove 以当前行动者落子；校验一致后应用
    const cur = P[st.turnIndex % 3];
    if (cur !== p) throw new Error(`turn mismatch: expected ${cur}, got ${p}`);
    const res = applyMove(st, r, c);
    if (res.rejected) throw new Error(`move rejected ${p} (${r},${c}): ${res.rejected}`);
    st = res.state;
  }
  return st;
}

export { undoMove };
export const PLAYERS = P;
export type { Player };
