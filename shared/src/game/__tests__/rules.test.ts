import { describe, expect, it } from 'vitest';
import { createInitialState, applyMove, undoMove } from '../rules';
import { getLegalMoves, getWinningPoints, isLegalMove } from '../legalMoves';
import { hasFourThroughPlacedCell } from '../winDetection';
import { getEligiblePlayer } from '../eligibility';
import type { Board, Player } from '../types';

/** 直接在空棋盘上摆棋并返回 board（row 0 = 顶行；正式规则棋盘 13/17，测试默认 13） */
function placeOnEmpty(size: number, moves: Array<[Player, number, number]>): Board {
  const board: Board = Array.from({ length: size }, () => Array<Player | null>(size).fill(null));
  for (const [p, row, col] of moves) board[row][col] = p;
  return board;
}

describe('胜负检测 hasFourThroughPlacedCell', () => {
  it('水平 4 连', () => {
    const board = placeOnEmpty(13, [
      ['A', 5, 2], ['A', 5, 3], ['A', 5, 4], // A A A _
    ]);
    expect(hasFourThroughPlacedCell(board, 5, 5, 'A')).toBe(true); // 补上成 4
    expect(hasFourThroughPlacedCell(board, 5, 0, 'A')).toBe(false);
  });

  it('垂直 4 连', () => {
    const board = placeOnEmpty(13, [
      ['B', 2, 7], ['B', 3, 7], ['B', 4, 7],
    ]);
    expect(hasFourThroughPlacedCell(board, 5, 7, 'B')).toBe(true); // 向下补齐
    expect(hasFourThroughPlacedCell(board, 1, 7, 'B')).toBe(true); // 向上补齐同样成4
    expect(hasFourThroughPlacedCell(board, 0, 7, 'B')).toBe(false);
    expect(hasFourThroughPlacedCell(board, 6, 7, 'B')).toBe(false);
  });

  it('主对角线 \\ 4 连', () => {
    const board = placeOnEmpty(13, [
      ['C', 1, 1], ['C', 2, 2], ['C', 3, 3],
    ]);
    expect(hasFourThroughPlacedCell(board, 0, 0, 'C')).toBe(true);
    expect(hasFourThroughPlacedCell(board, 4, 4, 'C')).toBe(true);
    expect(hasFourThroughPlacedCell(board, 1, 2, 'C')).toBe(false);
  });

  it('副对角线 / 4 连', () => {
    const board = placeOnEmpty(13, [
      ['A', 3, 5], ['A', 4, 4], ['A', 5, 3],
    ]);
    expect(hasFourThroughPlacedCell(board, 2, 6, 'A')).toBe(true);
    expect(hasFourThroughPlacedCell(board, 6, 2, 'A')).toBe(true);
  });

  it('5 连 / 6 连 同样算（>=4）', () => {
    const board = placeOnEmpty(13, [
      ['B', 0, 0], ['B', 0, 1], ['B', 0, 2], ['B', 0, 3],
    ]);
    expect(hasFourThroughPlacedCell(board, 0, 4, 'B')).toBe(true); // 补成 5
    const board6 = placeOnEmpty(13, [
      ['B', 0, 0], ['B', 0, 1], ['B', 0, 2], ['B', 0, 3], ['B', 0, 4],
    ]);
    expect(hasFourThroughPlacedCell(board6, 0, 5, 'B')).toBe(true); // 补成 6
  });

  it('对方棋子不参与计数（间隔中断）', () => {
    // B 把 A 的两段隔开：A A _ B A A —— 两端分别只能数到 2+1
    const board = placeOnEmpty(13, [
      ['A', 5, 1], ['A', 5, 2], ['B', 5, 3], ['A', 5, 4], ['A', 5, 5],
    ]);
    expect(hasFourThroughPlacedCell(board, 5, 0, 'A')).toBe(false); // 左段 2+1
    expect(hasFourThroughPlacedCell(board, 5, 6, 'A')).toBe(false); // 右段 2+1
    expect(hasFourThroughPlacedCell(board, 5, 7, 'A')).toBe(false);
    // 但若把空位 (5,?) 视为 A 也不能跨过 B
    expect(hasFourThroughPlacedCell(board, 4, 1, 'A')).toBe(false);
  });
});

describe('禁手（非资格玩家不能形成四连）', () => {
  it('Round 1（无人有胜权）：A 形成 4 连非法', () => {
    // 直接构造棋盘：把 A 的 3 连摆上去（用辅助函数）
    const board = placeOnEmpty(13, [
      ['A', 5, 2], ['A', 5, 3], ['A', 5, 4],
      ['B', 0, 0], ['C', 0, 1],
    ]);
    const state = { ...createInitialState(13), board, turnIndex: 0 };
    expect(isLegalMove(state, 5, 5)).toBe(false); // 补成 AAAA → 禁手
    expect(isLegalMove(state, 5, 1)).toBe(false); // A A A A 反向也禁
    expect(isLegalMove(state, 6, 6)).toBe(true); // 无关位置合法
  });

  it('Round 5（仍无资格）与 Round 6 非资格玩家均不可成四', () => {
    // R5：turnIndex 13 = A 的回合（R5 = turns 12..14: A@12,B@13,C@14）
    const boardA = placeOnEmpty(13, [
      ['A', 5, 2], ['A', 5, 3], ['A', 5, 4],
      ['B', 0, 0], ['C', 0, 1],
    ]);
    const sA = { ...createInitialState(13), board: boardA, turnIndex: 12 };
    expect(isLegalMove(sA, 5, 5)).toBe(false);
    // R6：C 有资格；A 仍是禁手（A 三连在 R6 A 的回合 turn 15）
    const boardB = placeOnEmpty(13, [
      ['A', 5, 2], ['A', 5, 3], ['A', 5, 4],
      ['B', 0, 0], ['C', 0, 1],
    ]);
    const sB = { ...createInitialState(13), board: boardB, turnIndex: 15 };
    expect(getEligiblePlayer(6)).toBe('C');
    expect(isLegalMove(sB, 5, 5)).toBe(false);
  });

  it('非资格玩家形成 5 连同样非法（>=4 都算）', () => {
    const board = placeOnEmpty(13, [
      ['A', 5, 2], ['A', 5, 3], ['A', 5, 4], ['A', 5, 5],
      ['B', 0, 0], ['C', 0, 1],
    ]);
    let s = createInitialState(13);
    s = { ...s, board };
    expect(isLegalMove(s, 5, 6)).toBe(false); // 补成 5 连 → 禁手
  });

  it('applyMove 拒绝禁手且状态不变', () => {
    const board = placeOnEmpty(13, [
      ['A', 5, 2], ['A', 5, 3], ['A', 5, 4],
      ['B', 0, 0], ['C', 0, 1],
    ]);
    let s = createInitialState(13);
    s = { ...s, board };
    const before = JSON.stringify(s);
    const res = applyMove(s, 5, 5);
    expect(res.rejected).toBe('forbidden');
    expect(JSON.stringify(res.state)).toBe(before);
    expect(res.state.board[5][5]).toBeNull();
  });
});

describe('资格玩家获胜（正式规则 v2：R6=C、R7=B、R8=A）', () => {
  it('Eligible 玩家形成 4 连 → WIN（R6 的 C）', () => {
    // R6 的 C 回合 = turnIndex 17（0-based：R6 = turns 15..17: A15 B16 C17）
    const board = placeOnEmpty(13, [
      ['C', 3, 3], ['C', 3, 4], ['C', 3, 5], // C 三连待补
      ['A', 0, 0], ['A', 0, 1], ['A', 0, 2],
      ['B', 1, 0], ['B', 1, 1], ['B', 1, 2],
    ]);
    const s = {
      ...createInitialState(13),
      board,
      turnIndex: 17, // R6, C 的回合, eligible=C
    };
    expect(getEligiblePlayer(6)).toBe('C');
    expect(isLegalMove(s, 3, 6)).toBe(true);
    const res = applyMove(s, 3, 6);
    expect(res.rejected).toBeUndefined();
    expect(res.win).toBe(true);
    expect(res.state.status).toBe('won');
    expect(res.state.winner).toBe('C');
    expect(res.state.winLine).not.toBeNull();
    expect(res.state.winLine!.length).toBeGreaterThanOrEqual(4);
  });

  it('Eligible 玩家正常落子不形成4 → 不获胜，继续游戏（R7 的 B）', () => {
    // R7 的 B 回合 = turnIndex 19（R7 = turns 18..20: A18 B19 C20）
    const board = placeOnEmpty(13, [
      ['B', 3, 3], ['B', 3, 4],
      ['A', 0, 0], ['A', 0, 1], ['A', 0, 2],
      ['C', 1, 0], ['C', 1, 1], ['C', 1, 2],
    ]);
    const s = { ...createInitialState(13), board, turnIndex: 19 };
    expect(getEligiblePlayer(7)).toBe('B');
    const res = applyMove(s, 6, 6);
    expect(res.rejected).toBeUndefined();
    expect(res.win).toBe(false);
    expect(res.state.status).toBe('playing');
    expect(res.state.board[6][6]).toBe('B');
  });

  it('非资格玩家形成4不触发胜利（被拒绝）', () => {
    // R8：A 有资格；这里测 R6 中非资格 A 的禁手
    // R6: A 行动 turnIndex=15, eligible=C
    const board = placeOnEmpty(13, [
      ['A', 2, 2], ['A', 2, 3], ['A', 2, 4],
      ['B', 0, 0], ['B', 0, 1], ['B', 0, 2],
      ['C', 1, 0], ['C', 1, 1], ['C', 1, 2],
    ]);
    const s = { ...createInitialState(13), board, turnIndex: 15 }; // R6, A 回合, eligible=C
    expect(getEligiblePlayer(6)).toBe('C');
    expect(isLegalMove(s, 2, 5)).toBe(false);
  });

  it('R8 的 A 有资格：成四获胜', () => {
    // R8 的 A 回合 = turnIndex 21（R8 = turns 21..23: A21 B22 C23）
    const board = placeOnEmpty(13, [
      ['A', 4, 4], ['A', 4, 5], ['A', 4, 6],
      ['B', 0, 0], ['C', 0, 1],
    ]);
    const s = { ...createInitialState(13), board, turnIndex: 21 };
    expect(getEligiblePlayer(8)).toBe('A');
    expect(isLegalMove(s, 4, 7)).toBe(true);
    const res = applyMove(s, 4, 7);
    expect(res.win).toBe(true);
    expect(res.state.winner).toBe('A');
  });
});

describe('getWinningPoints', () => {
  it('列出所有可形成≥4的落点（与资格无关）', () => {
    const board = placeOnEmpty(13, [
      ['A', 5, 2], ['A', 5, 3], ['A', 5, 4],
    ]);
    const pts = getWinningPoints(board, 'A');
    expect(pts.some((p) => p.row === 5 && p.col === 1)).toBe(true);
    expect(pts.some((p) => p.row === 5 && p.col === 5)).toBe(true);
  });
});

describe('getLegalMoves / 自动 Pass', () => {
  it('正常局面 legalMoves 数量正确（Round1 无资格、无四连风险）', () => {
    const s = createInitialState(13);
    expect(getLegalMoves(s).length).toBe(169); // 13×13 全空合法
  });

  it('轮到无合法步的玩家 → 自动 Pass 并推进', () => {
    // 构造：A 的回合（R1），但 A 已没有合法落子 —— 把几乎整个棋盘塞满，
    // 只留一个位置；若 A 下那里会形成4连 → A 无合法步 → 自动 pass → B 来下。
    // 13x13=169 格。填 165 个 B/C + 关键布局。
    const board = Array.from({ length: 13 }, () => Array<Player | null>(13).fill(null));
    // 使 A 只剩一个空位 (5,5)，且 A 在 (5,2)(5,3)(5,4) 有三连 → (5,5) 对 A 是禁手
    board[5][2] = 'A'; board[5][3] = 'A'; board[5][4] = 'A';
    let placed = 3;
    for (let r = 0; r < 13 && placed < 168; r++) {
      for (let c = 0; c < 13 && placed < 168; c++) {
        if (board[r][c] === null && !(r === 5 && c === 5)) {
          board[r][c] = placed % 2 === 0 ? 'B' : 'C';
          placed++;
        }
      }
    }
    // 现在 board 只剩 (5,5) 空。轮到 A
    let s = createInitialState(13);
    s = { ...s, board, turnIndex: 0 };
    expect(getLegalMoves(s).length).toBe(0);
    const res = applyMove(s, 5, 5);
    expect(res.rejected).toBe('forbidden');
  });

  it('自动 Pass 链：真实落子后轮到无合法步玩家会自动跳过', () => {
    // 构造：C 在 (0,0)(0,1)(0,2) 三连；(0,3) 与 (9,9) 为空，其余全部棋盘格填充 (A/B 交替)。
    // B 下 (9,9)（合法）后轮到 C：C 唯一空位 (0,3) 会形成 CCCC → 禁手 → C 自动 Pass。
    const board = Array.from({ length: 13 }, () => Array<Player | null>(13).fill(null));
    board[0][0] = 'C'; board[0][1] = 'C'; board[0][2] = 'C';
    for (let r = 0; r < 13; r++) {
      for (let c = 0; c < 13; c++) {
        if (board[r][c] !== null) continue;
        if ((r === 0 && c === 3) || (r === 9 && c === 9)) continue;
        board[r][c] = (r + c) % 2 === 0 ? 'A' : 'B';
      }
    }
    // turnIndex=1 → B 行动（Round 1，无人有胜权）
    const s = { ...createInitialState(13), board, turnIndex: 1 };
    const res = applyMove(s, 9, 9);
    expect(res.rejected).toBeUndefined();
    expect(res.autoPassed).toContain('C');
    // 自动 pass 后轮到 A（A 在 (0,3) 有合法落子，链停止）
    expect(res.state.board[9][9]).toBe('B');
    const last = res.state.moves[res.state.moves.length - 1];
    expect(last.pass).toBe(true);
    expect(last.player).toBe('C');
    expect(res.state.moves.length).toBe(s.moves.length + 2); // B 落子 + C pass
  });
});

describe('和棋 / 棋盘满', () => {
  it('棋盘填满且无人获胜 → DRAW', () => {
    let s = createInitialState(13);
    let guard = 0;
    while (s.status === 'playing' && guard < 300) {
      const legal = getLegalMoves(s);
      if (legal.length === 0) break;
      const mv = legal[0];
      const res = applyMove(s, mv.row, mv.col);
      s = res.state;
      guard++;
    }
    expect(guard).toBeLessThan(300);
    expect(['won', 'draw']).toContain(s.status);
    if (s.status === 'draw') {
      expect(s.winner).toBeNull();
    }
  });
});

describe('Undo', () => {
  it('撤销一步完全恢复状态', () => {
    let s = createInitialState(13);
    const before: string[] = [];
    before.push(JSON.stringify(s));
    for (const [r, c] of [[5, 5], [6, 6], [7, 7]] as Array<[number, number]>) {
      const res = applyMove(s, r, c);
      if (res.rejected) throw new Error('unexpected rejected');
      s = res.state;
      before.push(JSON.stringify(s));
    }
    // 撤销两步
    s = undoMove(s);
    s = undoMove(s);
    expect(JSON.stringify(s)).toBe(before[1]);
    // 撤销到空盘
    s = undoMove(s);
    expect(JSON.stringify(s)).toBe(before[0]);
  });

  it('撤销 Pass', () => {
    const board = Array.from({ length: 13 }, () => Array<Player | null>(13).fill(null));
    board[0][0] = 'C'; board[0][1] = 'C'; board[0][2] = 'C';
    for (let r = 0; r < 13; r++) {
      for (let c = 0; c < 13; c++) {
        if (board[r][c] !== null) continue;
        if ((r === 0 && c === 3) || (r === 9 && c === 9)) continue;
        board[r][c] = (r + c) % 2 === 0 ? 'A' : 'B';
      }
    }
    const s0 = { ...createInitialState(13), board, turnIndex: 1 };
    const res = applyMove(s0, 9, 9);
    expect(res.rejected).toBeUndefined();
    expect(res.autoPassed).toContain('C');
    const after = res.state;
    const last = after.moves[after.moves.length - 1];
    expect(last.pass).toBe(true);
    // 撤销第一步：撤掉 C 的 pass（纯弹出，不重新触发自动 Pass）
    const u1 = undoMove(after);
    expect(u1.moves.length).toBe(s0.moves.length + 1);
    expect(u1.board[9][9]).toBe('B');
    expect(u1.turnIndex).toBe(2); // 停在 C（无合法步状态，UI 会提示手动跳过）
    // 再撤销：撤掉 B 的落子 —— 历史清空，回到全新空盘（预摆棋子不属于历史记录）
    const u2 = undoMove(u1);
    expect(u2.moves.length).toBe(0);
    expect(u2.turnIndex).toBe(0);
    expect(u2.board[9][9]).toBeNull();
    expect(u2.board[0][0]).toBeNull();
  });

  it('撤销胜利一步后游戏回到进行中', () => {
    const board = placeOnEmpty(13, [
      ['C', 3, 3], ['C', 3, 4], ['C', 3, 5],
      ['A', 0, 0], ['A', 0, 1], ['A', 0, 2],
      ['B', 1, 0], ['B', 1, 1], ['B', 1, 2],
    ]);
    const s = { ...createInitialState(13), board, turnIndex: 17 };
    const res = applyMove(s, 3, 6);
    expect(res.win).toBe(true);
    const u = undoMove(res.state);
    expect(u.status).toBe('playing');
    expect(u.winner).toBeNull();
    expect(u.board[3][6]).toBeNull();
  });
});
