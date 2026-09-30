/**
 * 每日一题胜权时间线（增量 A）——纯模型单测。
 *
 * 两条纪律：
 *  1. 期望值必须来自**正式规则**（R1–5 无胜权；R6 白、R7 绿、R8 红，之后白→绿→红循环），
 *     不是从被测代码里抄的；
 *  2. “跟随当前查看的局面”必须有断言：同一道题在第 k 手与第 k+1 手的时间线必须不同。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState, applyMove } from '../../../../shared/src/game/rules';
import { getEligiblePlayer, roundFromTurn } from '../../../../shared/src/game/eligibility';
import { getLegalMoves } from '../../../../shared/src/game/legalMoves';
import type { BoardSize, GameState, Player } from '../../../../shared/src/game/types';
import { buildStateFromMoves } from '../replayState';
import { clampStep, timelineCopy, timelineOf } from '../puzzleTimeline';

/** 用引擎真实走 n 手（每手取第一个合法点），得到一串合法棋谱。 */
function legalMoves(n: number, size: BoardSize = 13): Array<{ row: number; col: number }> {
  let s: GameState = createInitialState(size);
  const out: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < n; i++) {
    const m = getLegalMoves(s)[0];
    out.push({ row: m.row, col: m.col });
    s = applyMove(s, m.row, m.col).state;
  }
  return out;
}

/** 第 round 轮的局面（引擎口径：round = floor(turn/3)+1）。 */
function stateAtRound(round: number, size: BoardSize = 13): GameState {
  return { ...createInitialState(size), turnIndex: (round - 1) * 3 };
}

describe('每日一题胜权时间线：规则正确性（正式规则 R1–5 / R6 白 / R7 绿 / R8 红 循环）', () => {
  const expectFor = (round: number): Player | null => {
    if (round <= 5) return null;
    const cycle: Player[] = ['C', 'B', 'A']; // 白 → 绿 → 红
    return cycle[(round - 6) % 3];
  };

  it('R1：当前无胜权，下一次胜权窗口是 R6 白棋', () => {
    const copy = timelineCopy(timelineOf(stateAtRound(1)));
    expect(copy.round).toBe(1);
    expect(copy.eligible).toBeNull();
    expect(copy.current).toContain('无人拥有胜权');
    expect(copy.next).toContain('Round 6');
    expect(copy.next).toContain('白棋');
  });

  it('R5：当前无胜权，下一轮就是 R6 白棋（边界）', () => {
    const copy = timelineCopy(timelineOf(stateAtRound(5)));
    expect(copy.eligible).toBeNull();
    expect(copy.nextRound).toBe(6);
    expect(copy.nextPlayer).toBe('C');
    expect(copy.next).toContain('白棋');
  });

  it('R6 白 / R7 绿 / R8 红：与共享规则逐轮一致', () => {
    expect(timelineCopy(timelineOf(stateAtRound(6))).eligible).toBe('C');
    expect(timelineCopy(timelineOf(stateAtRound(7))).eligible).toBe('B');
    expect(timelineCopy(timelineOf(stateAtRound(8))).eligible).toBe('A');
    expect(timelineCopy(timelineOf(stateAtRound(6))).current).toContain('白棋拥有胜权');
    expect(timelineCopy(timelineOf(stateAtRound(7))).current).toContain('绿棋拥有胜权');
    expect(timelineCopy(timelineOf(stateAtRound(8))).current).toContain('红棋拥有胜权');
  });

  it('R1–R40 全体与正式规则一致（含 R9 回到白棋、R100 正确循环）', () => {
    for (let round = 1; round <= 40; round++) {
      const view = timelineOf(stateAtRound(round));
      expect(view.currentRound).toBe(round);
      expect(view.currentEligible).toBe(expectFor(round));
      expect(view.currentEligible).toBe(getEligiblePlayer(round)); // 与共享引擎同一结果
    }
    const r100 = timelineCopy(timelineOf(stateAtRound(100)));
    expect(r100.round).toBe(100);
    expect(r100.eligible).toBe(expectFor(100));
    expect(r100.eligible).toBe(getEligiblePlayer(100));
    // R100：100-6=94，94%3=1 → 循环第二位 = 绿棋
    expect(r100.eligible).toBe('B');
  });
});

describe('每日一题胜权时间线：跟随当前查看的局面（复盘前进/后退）', () => {
  const moves = legalMoves(21); // 够走到 R8

  it('每一步的 Round 都由真实引擎局面算出，而不是题目初始轮次', () => {
    for (let k = 0; k <= moves.length; k++) {
      const { state, rejected } = buildStateFromMoves(13, moves, k);
      expect(rejected).toBe(0);
      expect(state.turnIndex).toBe(k);
      const copy = timelineCopy(timelineOf(state));
      expect(copy.round).toBe(roundFromTurn(k));
      expect(copy.eligible).toBe(getEligiblePlayer(roundFromTurn(k)));
    }
  });

  it('后退/前进一步会真的改变时间线（R5 无胜权 → R6 白棋）', () => {
    const atR5 = timelineCopy(timelineOf(buildStateFromMoves(13, moves, 14).state));
    const atR6 = timelineCopy(timelineOf(buildStateFromMoves(13, moves, 15).state));
    expect(atR5.round).toBe(5);
    expect(atR5.eligible).toBeNull();
    expect(atR6.round).toBe(6);
    expect(atR6.eligible).toBe('C');
    // 回到同一手必须回到同一结论（可重放，不是一次性状态）
    expect(timelineCopy(timelineOf(buildStateFromMoves(13, moves, 14).state)).eligible).toBeNull();
  });

  it('时间线窗口覆盖未来 8 轮，供页面显示未来 3–5 轮', () => {
    const view = timelineOf(buildStateFromMoves(13, moves, 15).state);
    expect(view.upcoming.length).toBeGreaterThanOrEqual(8);
    const rounds = view.upcoming.map((e) => e.round);
    expect(rounds[0]).toBe(7);
    expect(rounds.at(-1)).toBe(14);
    expect(view.upcoming[0].player).toBe('B'); // R7 绿
  });

  it('clampStep 把越界与非法步数夹回合法范围', () => {
    expect(clampStep(-5, 20)).toBe(0);
    expect(clampStep(999, 20)).toBe(20);
    expect(clampStep(7.6, 20)).toBe(8);
    expect(clampStep(Number.NaN, 20)).toBe(20);
  });
});
