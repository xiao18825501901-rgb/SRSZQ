/** 基础类型定义 */

/** 三名玩家，固定行动顺序 A → B → C */
export type Player = 'A' | 'B' | 'C';

export const PLAYERS: readonly Player[] = ['A', 'B', 'C'];

export const PLAYER_ORDER: Record<number, Player> = { 0: 'A', 1: 'B', 2: 'C' };

/** 三种资格顺序（从 Round 4 开始生效） */
export type Schedule = 'CBA' | 'CBACC' | 'BAC';

export const SCHEDULES: readonly Schedule[] = ['CBA', 'CBACC', 'BAC'];

export const SCHEDULE_LABELS: Record<Schedule, string> = {
  CBA: 'C → B → A',
  CBACC: 'C → B → A → C → C',
  BAC: 'B → A → C',
};

export const SCHEDULE_DESCRIPTIONS: Record<Schedule, string> = {
  CBA: '从第4轮起按 C→B→A 循环授予胜权（每3轮一个周期）',
  CBACC: '从第4轮起按 C→B→A→C→C 循环授予胜权（每5轮一个周期，注意周期边界会出现连续 C）',
  BAC: '从第4轮起按 B→A→C 循环授予胜权（每3轮一个周期）',
};

/** 棋盘格：null = 空 */
export type Cell = Player | null;

/** board[row][col]，row 0 = 顶行，col 0 = 最左列 */
export type Board = Cell[][];

export type BoardSize = 11 | 13;

export const BOARD_SIZES: readonly BoardSize[] = [11, 13];

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
  schedule: Schedule;
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
