import type { Board, CellPos, GameState, Player } from './types';
import { getEligiblePlayer, playerFromTurn, roundFromTurn } from './eligibility';
import { createsFourThroughCell } from './winDetection';

export interface LegalCell extends CellPos {
  /** 若当前玩家无胜权且此格会形成四连 → 禁手（仅供展示，不属于合法落子） */
  forbidden?: boolean;
}

/** 当前轮到谁 */
export function currentPlayerOf(state: GameState): Player {
  return playerFromTurn(state.turnIndex);
}

/** 当前 Round（1-based） */
export function currentRoundOf(state: GameState): number {
  return roundFromTurn(state.turnIndex);
}

/** 当前 Round 的胜权玩家（Round1-5 为 null） */
export function eligibleOf(state: GameState): Player | null {
  return getEligiblePlayer(currentRoundOf(state));
}

/** 当前玩家是否拥有胜权 */
export function currentPlayerIsEligible(state: GameState): boolean {
  const eligible = eligibleOf(state);
  return eligible !== null && eligible === currentPlayerOf(state);
}

/** 某格是否为空 */
export function isEmptyCell(board: Board, row: number, col: number): boolean {
  return row >= 0 && row < board.length && col >= 0 && col < board[0].length && board[row][col] === null;
}

/**
 * 在 (row,col) 落子是否构成「当前玩家自己的 ≥4 连」。
 */
export function wouldFormFour(state: GameState, row: number, col: number): boolean {
  return createsFourThroughCell(state.board, row, col, currentPlayerOf(state));
}

/**
 * 对「当前玩家」而言，(row,col) 是否合法：
 * - 格子必须为空；
 * - 若当前玩家拥有胜权：所有空格原则上均可落子（形成 ≥4 则直接获胜）；
 * - 若当前玩家没有胜权：任何会形成自己 ≥4 连的位置都是禁手（非法）。
 */
export function isLegalMove(state: GameState, row: number, col: number): boolean {
  if (state.status !== 'playing') return false;
  if (!isEmptyCell(state.board, row, col)) return false;
  if (currentPlayerIsEligible(state)) return true;
  return !wouldFormFour(state, row, col);
}

/**
 * 当前玩家的全部合法落子（空位中扣除禁手）。不含禁手格。
 */
export function getLegalMoves(state: GameState): LegalCell[] {
  if (state.status !== 'playing') return [];
  const legal: LegalCell[] = [];
  const eligible = currentPlayerIsEligible(state);
  const n = state.boardSize;
  const player = currentPlayerOf(state);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (state.board[row][col] !== null) continue;
      if (eligible || !createsFourThroughCell(state.board, row, col, player)) {
        legal.push({ row, col });
      }
    }
  }
  return legal;
}

/**
 * 当前玩家的禁手格（空位且会形成 ≥4）—— 仅当当前玩家没有胜权时才有禁手。
 * 供 UI 展示（淡红 X / 悬停提示）使用。
 */
export function getForbiddenCells(state: GameState): CellPos[] {
  if (state.status !== 'playing') return [];
  if (currentPlayerIsEligible(state)) return [];
  const cells: CellPos[] = [];
  const player = currentPlayerOf(state);
  const n = state.boardSize;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (state.board[row][col] !== null) continue;
      if (createsFourThroughCell(state.board, row, col, player)) {
        cells.push({ row, col });
      }
    }
  }
  return cells;
}

/**
 * 对玩家 p 而言的「胜点」：下一手在此落子即可形成 ≥4 的位置（与资格无关）。
 * 若 p 是当前玩家且没有胜权，这些位置同时就是它的禁手。
 */
export function getWinningPoints(board: Board, player: Player): CellPos[] {
  const points: CellPos[] = [];
  const n = board.length;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (board[row][col] !== null) continue;
      if (createsFourThroughCell(board, row, col, player)) {
        points.push({ row, col });
      }
    }
  }
  return points;
}

/** 棋盘是否已满 */
export function isBoardFull(board: Board): boolean {
  return board.every((row) => row.every((c) => c !== null));
}
