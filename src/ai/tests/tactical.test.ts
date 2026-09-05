import { describe, expect, it } from 'vitest';
import type { Board, GameState, Player } from '../../game/types';
import { createInitialState } from '../../game/rules';
import { getLegalMoves } from '../../game/legalMoves';
import { chooseAIMove } from '../chooseAIMove';
import type { AILevel } from '../types';

function emptyBoard(n: number): Board {
  return Array.from({ length: n }, () => Array<Player | null>(n).fill(null));
}

function stateWith(board: Board, turnIndex: number): GameState {
  return { ...createInitialState(board.length as 11 | 13, 'BAC'), board, turnIndex };
}

describe('Tactical：立即胜 / 关键封堵 / Pass', () => {
  it('自己 Eligible 且存在立即胜点 → 100% 获胜', () => {
    // BAC R5 起点 turnIndex=12 = A，R5 胜权 = A。A 已有三连 (0-based row 5, col 1-3)，
    // 唯一胜点 (5,4)（或 (5,0)）。A 必须选择胜点。
    const board = emptyBoard(11);
    board[5][1] = 'A';
    board[5][2] = 'A';
    board[5][3] = 'A';
    // 占位回合一致性（turnIndex 12 = A 在 R5 的第 1 手；前面 12 手未记录，但引擎只看状态）
    board[9][9] = 'B';
    board[8][8] = 'C';
    board[9][8] = 'B';
    board[8][9] = 'C';
    board[7][7] = 'B';
    board[6][6] = 'C';
    board[7][8] = 'B';
    board[6][7] = 'C';
    board[7][9] = 'B';
    board[6][8] = 'C';
    board[5][9] = 'B';
    board[4][4] = 'C';
    const st = stateWith(board, 12);
    expect(st.status).toBe('playing');
    const wins = getLegalMoves(st).filter((m) => m.row === 5 && (m.col === 0 || m.col === 4));
    expect(wins.length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      const d = chooseAIMove(st, 'A', 'tactical', { seed: i });
      expect(d.row === 5 && (d.col === 0 || d.col === 4), `tactical didn't win: (${d.row},${d.col})`).toBe(true);
    }
  });

  it('Eligible 对手单胜点且自己可堵 → 优先封堵', () => {
    // BAC R4 起点 turnIndex=9 = A 行动；R4 胜权 = B。B 已有三连 (row 7, col 1-3)，
    // B 的胜点 (7,4)/(7,0)。A 唯一可堵点 (7,0)（(7,4) 让 A 无法合法下的情况……）
    // 简化：只留一个可堵胜点 (7,0)，另一个 (7,4) 预先被 C 占据。
    const board = emptyBoard(11);
    board[7][1] = 'B';
    board[7][2] = 'B';
    board[7][3] = 'B';
    board[7][4] = 'C'; // 已占，B 只剩 (7,0) 一个胜点
    board[9][9] = 'C';
    board[8][8] = 'A';
    const st = stateWith(board, 9);
    const d = chooseAIMove(st, 'A', 'tactical', { seed: 3 });
    expect(d.row === 7 && d.col === 0, `tactical should block B's only winning point, got (${d.row},${d.col})`).toBe(true);
  });

  it('无合法步 → Pass', () => {
    // 构造 A 无合法步：A 三连 + 全盘只剩 (5,3) 一个空位（对 A 是禁手）
    const board = emptyBoard(11);
    board[5][0] = 'A';
    board[5][1] = 'A';
    board[5][2] = 'A';
    for (let r = 0; r < 11; r++) {
      for (let c = 0; c < 11; c++) {
        if (board[r][c] !== null) continue;
        if (r === 5 && c === 3) continue;
        board[r][c] = (r + c) % 2 === 0 ? 'B' : 'C';
      }
    }
    const st = stateWith(board, 0);
    expect(getLegalMoves(st).length).toBe(0);
    const d = chooseAIMove(st, 'A', 'tactical', { seed: 1 });
    expect(d.pass).toBe(true);
  });
});

describe('Selfish：自利而非见威胁就防', () => {
  it('自己 Eligible 立即胜 → 获胜', () => {
    const board = emptyBoard(11);
    board[5][1] = 'C';
    board[5][2] = 'C';
    board[5][3] = 'C';
    // R6 起点 turnIndex=15 = A；R6 胜权 = C。轮到 C 行动 = turnIndex 17。
    // C 在 R6 的回合 turnIndex 17（15=A,16=B,17=C），C 有胜点 (5,4)/(5,0)。
    board[9][9] = 'A';
    board[8][8] = 'B';
    board[9][8] = 'A';
    board[8][7] = 'B';
    const st = stateWith(board, 17);
    const d = chooseAIMove(st, 'C', 'selfish', { seed: 5 });
    expect(d.row === 5 && (d.col === 0 || d.col === 4), `selfish didn't take win: (${d.row},${d.col})`).toBe(true);
  });

  it('对手威胁不紧迫时优先自己下一资格轮的布局', () => {
    // 当前 turnIndex=14 = C 行动（R5 末手），R5 胜权 = A（本轮 A 已行动过 turnIndex12，且 R6 属 C）。
    // A 的 2 连 (9,0)(9,1) 只在一端开放（(9,-1) 出界），对 A 无即时价值：A 下次可行动为 R6 turnIndex15
    // 但 R6 胜权 = C → A 无法凭近端棋型获胜，威胁不紧迫。
    // C 的下一资格轮 = R6（很近）：C 斜线 2 连 (2,2)(3,3)，扩展 (1,1) 或 (4,4) 即成开放三并产生两个胜点。
    // Selfish 应选择自利扩展，而不是去堵 A 的远端开放端 (9,2)。
    const board = emptyBoard(11);
    board[9][0] = 'A';
    board[9][1] = 'A';
    board[8][0] = 'B'; // A 下方已被占，(9,2) 是 A 唯一延伸但只是 2→3
    board[2][2] = 'C';
    board[3][3] = 'C';
    board[0][0] = 'B';
    board[1][0] = 'B';
    const st = stateWith(board, 14); // C 行动
    for (let i = 0; i < 6; i++) {
      const d = chooseAIMove(st, 'C', 'selfish', { seed: i });
      const ownSetup = (d.row === 4 && d.col === 4) || (d.row === 1 && d.col === 1);
      expect(ownSetup, `selfish should prioritize own R6 setup, got (${d.row},${d.col}) reason=${d.reason}`).toBe(true);
    }
  });
});

describe('3-Ply / MaxN：短陷阱识别', () => {
  it('Eligible 对手唯一胜点 → 必须封堵（2-ply 内输棋陷阱）', () => {
    // R4 起点 turnIndex=9 = A 行动，R4 胜权 = B。
    // B 贴边三连 (0,0)(0,1)(0,2)：唯一延伸点 (0,3) 是 B 的唯一胜点（另一端出界）。
    // A 不堵 (0,3) → B 在 turnIndex 10 立即获胜。
    const board = emptyBoard(11);
    board[0][0] = 'B';
    board[0][1] = 'B';
    board[0][2] = 'B';
    board[9][9] = 'C';
    board[8][8] = 'C';
    board[7][7] = 'C';
    const st = stateWith(board, 9);
    for (const level of ['3ply', 'maxn'] as AILevel[]) {
      const d = chooseAIMove(st, 'A', level, { timeBudgetMs: 400, seed: 1 });
      expect(d.row === 0 && d.col === 3, `${level} failed to block B's only winning point: (${d.row},${d.col})`).toBe(true);
    }
  });

  it('3-Ply / MaxN 在胜点与封堵并存时优先即时获胜', () => {
    // R5 起点 turnIndex=12 = A（R5 胜权 A）：A 有贴边三连 (0,1)(0,2)(0,3) → 唯一胜点 (0,0)
    //（(0,4) 已被 C 占据）。
    // B 也有三连 (9,0)(9,1)(9,2)（B 无资格，仅几何威胁）。
    // A 必须选择 (0,0) 直接获胜而不是去堵 B。
    const board = emptyBoard(11);
    board[0][1] = 'A';
    board[0][2] = 'A';
    board[0][3] = 'A';
    board[0][4] = 'C'; // 封掉 (0,4)，A 只剩 (0,0) 一个胜点
    board[9][0] = 'B';
    board[9][1] = 'B';
    board[9][2] = 'B';
    board[8][8] = 'C';
    const st = stateWith(board, 12);
    for (const level of ['3ply', 'maxn'] as AILevel[]) {
      const d = chooseAIMove(st, 'A', level, { timeBudgetMs: 400, seed: 2 });
      expect(d.row === 0 && d.col === 0, `${level} should take immediate win: (${d.row},${d.col})`).toBe(true);
    }
  });
});
