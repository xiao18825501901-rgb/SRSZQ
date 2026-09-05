import { describe, expect, it, vi } from 'vitest';
import type { AILevel } from '../types';
import type { Board, GameState, Player } from '../../game/types';
import { chooseAIMove } from '../chooseAIMove';
import { getLegalMoves } from '../../game/legalMoves';
import { randomMidGameState } from './helpers';
import { createInitialState, applyMove } from '../../game/rules';
import { currentPlayerOf } from '../../game/legalMoves';

const LEVELS: AILevel[] = ['random', 'tactical', 'selfish', '3ply', 'maxn'];

function emptyBoard(n: number): Board {
  return Array.from({ length: n }, () => Array<Player | null>(n).fill(null));
}

/** 扫掠：所有档位 AI 的决策必须 100% 属于引擎合法集（或合法 Pass） */
describe('AI legality sweep（正式规则 v2）', () => {
  it.each(LEVELS)('%s 在大量随机局面上返回合法动作', { timeout: 240000 }, (level) => {
    const count = level === '3ply' || level === 'maxn' ? 40 : 400;
    const budget = level === 'maxn' ? 150 : level === '3ply' ? 120 : undefined;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < count; i++) {
        const s = randomMidGameState(1000 + i, i % 2 === 0 ? 13 : 17, 34);
        if (s.status !== 'playing') continue; // 终局不请求 AI
        const legal = getLegalMoves(s);
        const d = chooseAIMove(s, currentPlayerOf(s), level, { timeBudgetMs: budget, seed: i });
        if (legal.length === 0) {
          expect(d.pass, `${level} zero-legal -> pass`).toBe(true);
        } else {
          expect(d.pass, `${level} should move`).toBe(false);
          const ok = legal.some((m) => m.row === d.row && m.col === d.col);
          expect(ok, `illegal decision by ${level} on seed ${i}: (${d.row},${d.col})`).toBe(true);
        }
      }
      // 任何内部 fallback（AI_INVALID_DECISION）都视为失败 —— 不允许依赖兜底掩盖逻辑缺陷
      const fallbacks = errorSpy.mock.calls.filter((c) => String(c[0]).includes('AI_INVALID_DECISION'));
      expect(fallbacks, `${level} 触发内部非法动作兜底 ${fallbacks.length} 次`).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('AI 与人类共享引擎规则（正式规则 v2）', () => {
  it('AI 绝不选择禁手（无资格成四）', { timeout: 120000 }, () => {
    // R6 起点 = turnIndex 15 = A 行动，R6 胜权 = C → A 无资格。
    // 构造 A 三连 A(5,0)(5,1)(5,2)（0-based）：(5,3) 会形成 AAAA → 禁手。
    const board = emptyBoard(13);
    board[5][0] = 'A';
    board[5][1] = 'A';
    board[5][2] = 'A';
    board[9][9] = 'B';
    board[8][8] = 'C';
    const st: GameState = { ...createInitialState(13), board, turnIndex: 15 };
    const legal = getLegalMoves(st);
    expect(legal.some((m) => m.row === 5 && m.col === 3)).toBe(false);
    expect(applyMove(st, 5, 3).rejected).toBe('forbidden');
    for (const level of LEVELS) {
      for (let i = 0; i < 8; i++) {
        const d = chooseAIMove(st, 'A', level, { timeBudgetMs: 120, seed: i });
        expect(d.row === 5 && d.col === 3, `${level} chose forbidden four`).toBe(false);
        expect(legal.some((m) => m.row === d.row && m.col === d.col)).toBe(true);
      }
    }
  });

  it('座位不匹配抛错；终局请求返回 Pass', () => {
    const s = createInitialState(13);
    expect(() => chooseAIMove(s, 'B', 'random')).toThrow();
    const s2: GameState = { ...createInitialState(13), status: 'won', winner: 'A' };
    expect(chooseAIMove(s2, 'A', 'random').pass).toBe(true);
  });
});
