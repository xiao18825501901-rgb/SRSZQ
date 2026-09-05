import { describe, expect, it } from 'vitest';
import { getEligiblePlayer, roundFromTurn, playerFromTurn } from '../eligibility';
import type { Player } from '../types';

describe('roundFromTurn / playerFromTurn', () => {
  it('固定行动顺序 A → B → C', () => {
    expect(playerFromTurn(0)).toBe('A');
    expect(playerFromTurn(1)).toBe('B');
    expect(playerFromTurn(2)).toBe('C');
    expect(playerFromTurn(3)).toBe('A');
    expect(playerFromTurn(5)).toBe('C');
    expect(playerFromTurn(6)).toBe('A');
  });

  it('Round = floor(turn/3)+1', () => {
    expect(roundFromTurn(0)).toBe(1);
    expect(roundFromTurn(2)).toBe(1);
    expect(roundFromTurn(3)).toBe(2);
    expect(roundFromTurn(8)).toBe(3);
    expect(roundFromTurn(9)).toBe(4);
    expect(roundFromTurn(11)).toBe(4);
    expect(roundFromTurn(12)).toBe(5);
  });
});

describe('Round 1-3: 无人拥有胜权', () => {
  it.each(['CBA', 'CBACC', 'BAC'] as const)('%s 前三轮 eligible = null', (schedule) => {
    for (let round = 1; round <= 3; round++) {
      expect(getEligiblePlayer(round, schedule)).toBeNull();
    }
  });
});

describe('资格顺序 CBA: R4=C R5=B R6=A 循环', () => {
  const schedule = 'CBA';
  const cases: Array<[number, Player | null]> = [
    [4, 'C'], [5, 'B'], [6, 'A'],
    [7, 'C'], [8, 'B'], [9, 'A'],
    [10, 'C'], [11, 'B'], [12, 'A'],
    [13, 'C'], [100, 'C'], [101, 'B'], [102, 'A'],
  ];
  it.each(cases)('R%d → %s', (round, expected) => {
    expect(getEligiblePlayer(round, schedule)).toBe(expected);
  });
});

describe('资格顺序 BAC: R4=B R5=A R6=C 循环', () => {
  const schedule = 'BAC';
  const cases: Array<[number, Player | null]> = [
    [4, 'B'], [5, 'A'], [6, 'C'],
    [7, 'B'], [8, 'A'], [9, 'C'],
    [10, 'B'], [11, 'A'], [12, 'C'],
  ];
  it.each(cases)('R%d → %s', (round, expected) => {
    expect(getEligiblePlayer(round, schedule)).toBe(expected);
  });
});

describe('资格顺序 CBACC: 5轮周期 C,B,A,C,C（周期边界连续C是规则，不是Bug）', () => {
  const schedule = 'CBACC';
  const cases: Array<[number, Player | null]> = [
    [4, 'C'], [5, 'B'], [6, 'A'], [7, 'C'], [8, 'C'],
    // 周期重新开始
    [9, 'C'], [10, 'B'], [11, 'A'], [12, 'C'], [13, 'C'],
    [14, 'C'], [15, 'B'], [16, 'A'], [17, 'C'], [18, 'C'],
    // 周期边界：R7=R8=R9 连续三个 C
    [7, 'C'], [8, 'C'], [9, 'C'],
  ];
  it.each(cases)('R%d → %s', (round, expected) => {
    expect(getEligiblePlayer(round, schedule)).toBe(expected);
  });
});

describe('非法输入', () => {
  it('round 0 抛错', () => {
    expect(() => getEligiblePlayer(0, 'CBA')).toThrow();
  });
});
