import { useCallback, useMemo, useState } from 'react';
import type { BoardSize, GameState, Player } from '../game/types';
import { BOARD_SIZES } from '../game/types';
import { createInitialState, applyMove, undoMove, undoN, skipCurrentPlayer } from '../game/rules';
import { eligibleOf, currentPlayerOf, currentRoundOf, currentPlayerIsEligible, getLegalMoves } from '../game/legalMoves';

export interface GameController {
  state: GameState;
  current: Player;
  round: number;
  eligible: Player | null;
  currentHasEligible: boolean;
  legalCells: ReturnType<typeof getLegalMoves>;
  /** 当前玩家是否有合法落子 */
  hasLegalMove: boolean;
  /** 最近一次真实落子（用于最后一步标记） */
  lastMove: { player: Player; row: number; col: number } | null;
  placeStone: (row: number, col: number) => void;
  /** 手动跳过（当前玩家无合法步时使用；引擎会自动处理整条 Pass 链） */
  passTurn: () => void;
  newGame: (boardSize?: BoardSize) => void;
  undo: () => void;
  /** 原子撤销 n 条记录（不触发中间状态副作用） */
  undoN: (n: number) => void;
  /** 外部注入完整状态（用于导入重放） */
  replaceState: (state: GameState) => void;
}

export function useGame(initialSize: BoardSize = 13): GameController {
  const [state, setState] = useState<GameState>(() => createInitialState(initialSize));

  const current = currentPlayerOf(state);
  const round = currentRoundOf(state);
  const eligible = eligibleOf(state);
  const currentHasEligible = currentPlayerIsEligible(state);
  const legalCells = useMemo(() => getLegalMoves(state), [state]);
  const hasLegalMove = legalCells.length > 0;

  const lastMove = useMemo(() => {
    for (let i = state.moves.length - 1; i >= 0; i--) {
      const m = state.moves[i];
      if (!m.pass && m.row !== undefined && m.col !== undefined) {
        return { player: m.player, row: m.row, col: m.col };
      }
    }
    return null;
  }, [state.moves]);

  const placeStone = useCallback((row: number, col: number) => {
    setState((s) => {
      if (s.status !== 'playing') return s;
      const res = applyMove(s, row, col);
      if (res.rejected) return s;
      return res.state;
    });
  }, []);

  const newGame = useCallback((size?: BoardSize) => {
    setState((s) => createInitialState(size ?? s.boardSize));
  }, []);

  const undo = useCallback(() => {
    setState((s) => (s.moves.length === 0 ? s : undoMove(s)));
  }, []);

  const undoNCallback = useCallback((n: number) => {
    setState((s) => undoN(s, n));
  }, []);

  const passTurn = useCallback(() => {
    setState((s) => (s.status !== 'playing' ? s : skipCurrentPlayer(s)));
  }, []);

  const replaceState = useCallback((next: GameState) => {
    setState(next);
  }, []);

  return {
    state,
    current,
    round,
    eligible,
    currentHasEligible,
    legalCells,
    hasLegalMove,
    lastMove,
    placeStone,
    passTurn,
    newGame,
    undo,
    undoN: undoNCallback,
    replaceState,
  };
}

export const SIZES = BOARD_SIZES;
