import type { Board, BoardSize, CellPos, GameState, MoveRecord, Player, Schedule } from './types';
import { playerFromTurn, roundFromTurn } from './eligibility';
import { getLegalMoves, isBoardFull } from './legalMoves';
import { getWinLineThroughCell, hasFourThroughPlacedCell } from './winDetection';

export interface ApplyResult {
  state: GameState;
  /** 本次真实落子是否获胜 */
  win: boolean;
  /** 自动 Pass 的玩家序列（本次落子后发生的） */
  autoPassed: Player[];
  /** 是否被判定为禁手（未被应用） */
  rejected?: 'forbidden' | 'occupied' | 'not-playing';
}

function makeEmptyBoard(size: number): Board {
  return Array.from({ length: size }, () => Array<null>(size).fill(null));
}

export function createInitialState(boardSize: BoardSize, schedule: Schedule): GameState {
  return {
    boardSize,
    schedule,
    board: makeEmptyBoard(boardSize),
    turnIndex: 0,
    moves: [],
    status: 'playing',
    winner: null,
    winLine: null,
  };
}

/** 记录一条历史（真实落子或 pass） */
function record(state: GameState, move: MoveRecord): GameState {
  return {
    ...state,
    turnIndex: state.turnIndex + 1,
    moves: [...state.moves, move],
  };
}

/**
 * 自动 Pass 链：轮到某玩家且其合法落子数为 0 时，自动 Pass（不落子、不能获胜、正常消耗回合）。
 * 一直推进到出现有合法落子的玩家或棋盘已满。
 */
export function applyAutoPassChain(state: GameState): { state: GameState; autoPassed: Player[] } {
  let s = state;
  const autoPassed: Player[] = [];
  // 保护：最多推进 boardSize*boardSize 次，防止死循环
  for (let guard = 0; guard <= s.boardSize * s.boardSize; guard++) {
    if (isBoardFull(s.board)) {
      if (s.status === 'playing') {
        s = { ...s, status: 'draw' };
      }
      break;
    }
    const player = playerFromTurn(s.turnIndex);
    if (getLegalMoves(s).length > 0) break;
    autoPassed.push(player);
    s = record(s, {
      turn: s.turnIndex,
      round: roundFromTurn(s.turnIndex),
      player,
      pass: true,
    });
  }
  return { state: s, autoPassed };
}

/**
 * 应用一次真实落子。返回 rejected 表示该落子非法（禁手/占位/已结束），状态不变。
 */
export function applyMove(state: GameState, row: number, col: number): ApplyResult {
  if (state.status !== 'playing') return { state, win: false, autoPassed: [], rejected: 'not-playing' };
  if (row < 0 || row >= state.boardSize || col < 0 || col >= state.boardSize) {
    return { state, win: false, autoPassed: [], rejected: 'occupied' };
  }
  if (state.board[row][col] !== null) return { state, win: false, autoPassed: [], rejected: 'occupied' };

  const player = playerFromTurn(state.turnIndex);
  const round = roundFromTurn(state.turnIndex);

  // 禁手检查：非资格玩家不能形成自己的 ≥4
  // 资格检查在 legalMoves 层面已完成，这里再次校验以保证引擎自洽
  const legal = getLegalMoves(state).some((m) => m.row === row && m.col === col);
  if (!legal) return { state, win: false, autoPassed: [], rejected: 'forbidden' };

  const board = state.board.map((r) => r.slice());
  board[row][col] = player;

  let next: GameState = {
    ...state,
    board,
    turnIndex: state.turnIndex + 1,
    moves: [
      ...state.moves,
      { turn: state.turnIndex, round, player, row, col },
    ],
  };

  // 胜负判定：只有「当前合法落子」使包含新棋子的线形成 ≥4 才触发胜利
  if (hasFourThroughPlacedCell(board, row, col, player)) {
    const winLine = getWinLineThroughCell(board, row, col, player);
    next = { ...next, status: 'won', winner: player, winLine };
    return { state: next, win: true, autoPassed: [] };
  }

  // 棋盘已满且无人获胜 → 和棋
  if (isBoardFull(board)) {
    next = { ...next, status: 'draw' };
    return { state: next, win: false, autoPassed: [] };
  }

  // 自动 Pass 链
  const { state: afterPass, autoPassed } = applyAutoPassChain(next);
  return { state: afterPass, win: false, autoPassed };
}

/**
 * 撤销最后一步（真实落子或自动 Pass 都算一步）。
 * 通过重放历史重建状态，保证撤销后 board/turn/round/胜负 完全一致。
 * 注意：撤销不会重新触发自动 Pass —— 若撤销后当前玩家无合法步，
 * UI 会显示「跳过」按钮（手动 Pass），这样 Pass 本身也可以被撤销。
 */
export function undoMove(state: GameState): GameState {
  if (state.moves.length === 0) return state;
  const moves = state.moves.slice(0, -1);
  return replayMoves(state.boardSize, state.schedule, moves);
}

/**
 * 撤销一步（真实落子或自动 Pass 都算一步）。同 undoMove。
 */
export function undoOne(state: GameState): GameState {
  return undoMove(state);
}

/**
 * 撤销 n 条历史记录（真实落子/自动 Pass 都算），原子重放。
 * 供「悔棋到上一人类回合」等批量撤销使用（避免逐次撤销触发中间状态副作用）。
 */
export function undoN(state: GameState, n: number): GameState {
  if (n <= 0 || state.moves.length === 0) return state;
  const keep = Math.max(0, state.moves.length - n);
  return replayMoves(state.boardSize, state.schedule, state.moves.slice(0, keep));
}

/**
 * 手动/自动跳过当前无合法步的玩家（记录 Pass 并推进，直到出现可行动玩家或终局）。
 */
export function skipCurrentPlayer(state: GameState): GameState {
  if (state.status !== 'playing') return state;
  return applyAutoPassChain(state).state;
}

/** 由历史记录重放得到完整状态（用于撤销 / 导入） */
export function replayMoves(boardSize: BoardSize, schedule: Schedule, moves: MoveRecord[]): GameState {
  const board = makeEmptyBoard(boardSize);
  let turnIndex = 0;
  let status: GameState['status'] = 'playing';
  let winner: Player | null = null;
  let winLine: CellPos[] | null = null;

  for (const m of moves) {
    if (m.pass) {
      turnIndex = m.turn + 1;
      continue;
    }
    if (m.row === undefined || m.col === undefined) throw new Error(`invalid move record: ${JSON.stringify(m)}`);
    board[m.row][m.col] = m.player;
    turnIndex = m.turn + 1;
    if (status === 'playing' && hasFourThroughPlacedCell(board, m.row, m.col, m.player)) {
      status = 'won';
      winner = m.player;
      winLine = getWinLineThroughCell(board, m.row, m.col, m.player);
    }
  }
  if (status === 'playing' && isBoardFull(board)) status = 'draw';

  return {
    boardSize,
    schedule,
    board,
    turnIndex,
    moves: moves.slice(),
    status,
    winner,
    winLine,
  };
}

/**
 * 深拷贝（防御性，供 UI 状态使用）
 */
export function cloneState(state: GameState): GameState {
  return {
    ...state,
    board: state.board.map((r) => r.slice()),
    moves: state.moves.map((m) => ({ ...m })),
    winLine: state.winLine ? state.winLine.map((p) => ({ ...p })) : null,
  };
}

export interface ImportEntry {
  turn?: number;
  round?: number;
  player: string;
  row?: number;
  col?: number;
  pass?: boolean;
}

/**
 * 导入校验 + 重放：逐条验证（玩家顺序、占位、禁手规则、Pass 合法性），
 * 任一步非法即抛出带回合号的错误；全部合法则返回重放后的终态。
 * 约定：row/col 使用 1-based（与页面坐标一致）。
 */
export function importMoves(boardSize: BoardSize, schedule: Schedule, entries: ImportEntry[]): GameState {
  if (!Number.isInteger(boardSize) || (boardSize !== 11 && boardSize !== 13)) {
    throw new Error('boardSize 必须是 11 或 13');
  }
  if (schedule !== 'CBA' && schedule !== 'CBACC' && schedule !== 'BAC') {
    throw new Error(`schedule 必须是 CBA / CBACC / BAC，收到: ${String(schedule)}`);
  }
  let s = createInitialState(boardSize, schedule);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const player = e?.player as Player;
    if (!e || typeof e !== 'object' || !['A', 'B', 'C'].includes(player)) {
      throw new Error(`Invalid move at turn ${i}: player 缺失或非法 (${JSON.stringify(e)})`);
    }
    const expected = playerFromTurn(s.turnIndex);
    if (player !== expected) {
      throw new Error(`Invalid move at turn ${i}: 按顺序应为 ${expected}，却是 ${player}`);
    }
    if (e.pass) {
      const legalCount = getLegalMoves(s).length;
      if (legalCount > 0) {
        throw new Error(`Invalid move at turn ${i}: ${player} 声称 Pass，但实际有 ${legalCount} 个合法落子`);
      }
      s = record(s, { turn: s.turnIndex, round: roundFromTurn(s.turnIndex), player, pass: true });
      if (isBoardFull(s.board)) s = { ...s, status: 'draw' };
      continue;
    }
    if (s.status !== 'playing') {
      throw new Error(`Invalid move at turn ${i}: 棋局已结束（${s.status}）`);
    }
    const row = e.row === undefined ? NaN : Number(e.row) - 1;
    const col = e.col === undefined ? NaN : Number(e.col) - 1;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= boardSize || col < 0 || col >= boardSize) {
      throw new Error(`Invalid move at turn ${i}: 坐标 (${String(e.row)}, ${String(e.col)}) 超出 ${boardSize}×${boardSize} 棋盘`);
    }
    if (s.board[row][col] !== null) {
      throw new Error(`Invalid move at turn ${i}: 位置 (${row + 1}, ${col + 1}) 已有棋子`);
    }
    const legal = getLegalMoves(s).some((m) => m.row === row && m.col === col);
    if (!legal) {
      throw new Error(
        `Invalid move at turn ${i} (${player} → (${row + 1}, ${col + 1})): 禁手 —— ${player} 无胜权，此位置会形成四连`,
      );
    }
    const board = s.board.map((r) => r.slice());
    board[row][col] = player;
    let next: GameState = {
      ...s,
      board,
      turnIndex: s.turnIndex + 1,
      moves: [...s.moves, { turn: s.turnIndex, round: roundFromTurn(s.turnIndex), player, row, col }],
    };
    if (hasFourThroughPlacedCell(board, row, col, player)) {
      next = { ...next, status: 'won', winner: player, winLine: getWinLineThroughCell(board, row, col, player) };
    } else if (isBoardFull(board)) {
      next = { ...next, status: 'draw' };
    }
    s = next;
  }
  return s;
}
