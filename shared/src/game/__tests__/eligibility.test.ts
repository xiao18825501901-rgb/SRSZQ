import { describe, expect, it } from 'vitest';
import { firstEligibleRound, getEligiblePlayer, playerFromTurn, roundFromTurn } from '../eligibility';
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
    expect(roundFromTurn(14)).toBe(5);
    expect(roundFromTurn(15)).toBe(6);
    expect(roundFromTurn(17)).toBe(6);
  });
});

describe('正式规则 v2：Round 1-5 无人拥有胜权', () => {
  it.each([1, 2, 3, 4, 5])('R%d eligible = null', (round) => {
    expect(getEligiblePlayer(round)).toBeNull();
  });
});

describe('正式规则 v2：Round 6 起 C→B→A 循环', () => {
  const cases: Array<[number, Player | null]> = [
    [6, 'C'], [7, 'B'], [8, 'A'],
    [9, 'C'], [10, 'B'], [11, 'A'],
    [12, 'C'], [13, 'B'], [14, 'A'],
    [15, 'C'], [100, 'B'], [101, 'A'], [102, 'C'],
  ];
  it.each(cases)('R%d → %s', (round, expected) => {
    expect(getEligiblePlayer(round)).toBe(expected);
  });
});

describe('首次获权轮 firstEligibleRound', () => {
  it('C@R6, B@R7, A@R8', () => {
    expect(firstEligibleRound('C')).toBe(6);
    expect(firstEligibleRound('B')).toBe(7);
    expect(firstEligibleRound('A')).toBe(8);
  });
});

describe('非法输入', () => {
  it('round 0 抛错', () => {
    expect(() => getEligiblePlayer(0)).toThrow();
  });
  it('非整数抛错', () => {
    expect(() => getEligiblePlayer(2.5)).toThrow();
  });
});
