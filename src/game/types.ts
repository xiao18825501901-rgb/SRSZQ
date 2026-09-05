/** SRSZQ.com 正式规则 v2 —— 基础类型定义 */

/** 三名玩家，固定行动顺序 A → B → C */
export type Player = 'A' | 'B' | 'C';

export const PLAYERS: readonly Player[] = ['A', 'B', 'C'];

export const PLAYER_ORDER: Record<number, Player> = { 0: 'A', 1: 'B', 2: 'C' };

/* ------------------------------------------------------------------ */
/* 正式资格规则（唯一生效版本，无 schedule 选择）                          */
/* - Round 1–5：Eligible = NONE（任何玩家不可凭落子获胜；成四 = 禁手）      */
/* - Round ≥ 6：按 C → B → A 循环（R6=C, R7=B, R8=A, R9=C, …）           */
/* ------------------------------------------------------------------ */
export const ELIGIBLE_START_ROUND = 6;

/** R6 起循环的胜权顺序 */
export const ELIGIBLE_ORDER: readonly Player[] = ['C', 'B', 'A'];

/** 棋盘尺寸：正式版仅 13×13 与 17×17 */
export type BoardSize = 13 | 17;

export const BOARD_SIZES: readonly BoardSize[] = [13, 17];

export const BOARD_SIZE_LABELS: Record<BoardSize, string> = {
  13: '13 × 13',
  17: '17 × 17',
};

/** 棋盘格：null = 空 */
export type Cell = Player | null;

/** board[row][col]，row 0 = 顶行，col 0 = 最左列 */
export type Board = Cell[][];

export interface CellPos {
  row: number;
  col: number;
}

/** 一条历史记录：真实落子或自动 Pass */
export interface MoveRecord {
  /** 0-based 全局回合序号 */
  turn: number;
  /** 1-based Round */
  round: number;
  player: Player;
  /** 真实落子时有效 */
  row?: number;
  col?: number;
  pass?: boolean;
}

export type GameStatus = 'playing' | 'won' | 'draw';

export interface GameState {
  boardSize: BoardSize;
  board: Board;
  /** 0-based 全局回合序号；0=A,1=B,2=C */
  turnIndex: number;
  moves: MoveRecord[];
  status: GameStatus;
  winner: Player | null;
  winLine: CellPos[] | null;
}

export const PLAYER_COLORS: Record<Player, string> = {
  A: '#E5484D',
  B: '#30A46C',
  C: '#F7F7F7',
};

export const PLAYER_LABELS: Record<Player, string> = {
  A: '红棋',
  B: '绿棋',
  C: '白棋',
};
