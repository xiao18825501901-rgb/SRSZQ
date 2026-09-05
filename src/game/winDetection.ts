import type { Board, CellPos, Player } from './types';

/** 四个检测方向：水平、垂直、主对角线 \、副对角线 / */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function inBounds(board: Board, row: number, col: number): boolean {
  return row >= 0 && row < board.length && col >= 0 && col < board[0].length;
}

/**
 * 以 (row,col) 为起点（视为 player 的棋子），沿 (dr,dc) 方向统计连续棋子数（含该格）。
 * 用于判断「在此落子是否会形成 ≥4」以及「落子后是否获胜」。
 */
export function countLine(board: Board, row: number, col: number, player: Player, dr: number, dc: number): number {
  let n = 1;
  let r = row + dr;
  let c = col + dc;
  while (inBounds(board, r, c) && board[r][c] === player) {
    n++;
    r += dr;
    c += dc;
  }
  r = row - dr;
  c = col - dc;
  while (inBounds(board, r, c) && board[r][c] === player) {
    n++;
    r -= dr;
    c -= dc;
  }
  return n;
}

/**
 * 判断：若 player 在 (row,col)（视为已放置自己的棋子）落子，是否形成 ≥4 连续棋。
 * 横/竖/主对角/副对角任一方向 >= 4 即返回 true（4、5、6… 都算）。
 * 注意：只检测「穿过该格」的线，不做全局扫描 —— 胜利只能由当前新落的棋子触发。
 */
export function createsFourThroughCell(board: Board, row: number, col: number, player: Player): boolean {
  if (!inBounds(board, row, col)) return false;
  return DIRECTIONS.some(([dr, dc]) => countLine(board, row, col, player, dr, dc) >= 4);
}

/**
 * 与 createsFourThroughCell 相同语义的别名：落子后检测新子是否构成胜利线。
 */
export function hasFourThroughPlacedCell(board: Board, row: number, col: number, player: Player): boolean {
  return createsFourThroughCell(board, row, col, player);
}

/**
 * 返回穿过 (row,col) 的获胜线坐标（若存在）。用于高亮胜利连线。
 */
export function getWinLineThroughCell(board: Board, row: number, col: number, player: Player): CellPos[] | null {
  if (!inBounds(board, row, col)) return null;
  for (const [dr, dc] of DIRECTIONS) {
    if (countLine(board, row, col, player, dr, dc) >= 4) {
      const line: CellPos[] = [{ row, col }];
      let r = row + dr;
      let c = col + dc;
      while (inBounds(board, r, c) && board[r][c] === player) {
        line.push({ row: r, col: c });
        r += dr;
        c += dc;
      }
      r = row - dr;
      c = col - dc;
      while (inBounds(board, r, c) && board[r][c] === player) {
        line.push({ row: r, col: c });
        r -= dr;
        c -= dc;
      }
      return line;
    }
  }
  return null;
}
