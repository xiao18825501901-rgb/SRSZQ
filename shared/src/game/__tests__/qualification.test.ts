import { describe, expect, it } from 'vitest';
import { createInitialState } from '../rules';
import {
  QUALIFICATION_LOOKAHEAD,
  nextEligibleRoundAfter,
  qualificationFromState,
  qualificationOf,
} from '../qualification';
import type { Player } from '../types';

describe('qualificationOf：BAC 资格时间线窗口（单一数据源，规则复用 eligibility）', () => {
  it('Round 1：无人拥有胜权，upcoming 完整覆盖 R2–R9', () => {
    const q = qualificationOf(1);
    expect(q.currentRound).toBe(1);
    expect(q.currentEligible).toBeNull();
    expect(q.upcoming).toHaveLength(QUALIFICATION_LOOKAHEAD);
    expect(q.upcoming[0]).toEqual({ round: 2, player: null }); // R2-5 无胜权
    expect(q.upcoming[4]).toEqual({ round: 6, player: 'C' }); // R6=C
    expect(q.upcoming[5]).toEqual({ round: 7, player: 'B' });
    expect(q.upcoming[6]).toEqual({ round: 8, player: 'A' });
    expect(q.upcoming[7]).toEqual({ round: 9, player: 'C' });
  });

  it('Round 4（引擎真实输出：R<6 仍无人胜权）', () => {
    const q = qualificationOf(4);
    expect(q.currentEligible).toBeNull();
    expect(q.upcoming[0]).toEqual({ round: 5, player: null });
    expect(q.upcoming[1]).toEqual({ round: 6, player: 'C' });
    expect(q.upcoming[2]).toEqual({ round: 7, player: 'B' });
  });

  it('Round 6：当前胜权 = C', () => {
    const q = qualificationOf(6);
    expect(q.currentEligible).toBe('C');
    expect(q.upcoming[0]).toEqual({ round: 7, player: 'B' });
    expect(q.upcoming[1]).toEqual({ round: 8, player: 'A' });
    expect(q.upcoming[2]).toEqual({ round: 9, player: 'C' });
  });

  it('Round 100：循环周期正确（C→B→A mod 3）', () => {
    const q = qualificationOf(100);
    expect(q.currentEligible).toBe('B'); // (100-6) % 3 = 1 → B
    expect(q.upcoming[0]).toEqual({ round: 101, player: 'A' });
    expect(q.upcoming[1]).toEqual({ round: 102, player: 'C' });
    expect(q.upcoming[2]).toEqual({ round: 103, player: 'B' });
  });

  it('lookahead 可扩展（数据层支持更长窗口）', () => {
    const q = qualificationOf(6, 20);
    expect(q.upcoming).toHaveLength(20);
    // R26：(26-6)%3 = 2 → ELIGIBLE_ORDER[2] = 'A'
    expect(q.upcoming[19]).toEqual({ round: 26, player: 'A' });
  });

  it('nextEligibleRoundAfter：R1-5 提示首次获权轮 C@R6', () => {
    expect(nextEligibleRoundAfter(1)).toEqual({ round: 6, player: 'C' });
    expect(nextEligibleRoundAfter(5)).toEqual({ round: 6, player: 'C' });
    expect(nextEligibleRoundAfter(6)).toEqual({ round: 7, player: 'B' });
  });
});

describe('qualificationFromState：随棋局推进自动更新', () => {
  const stateAt = (turnIndex: number) => ({ ...createInitialState(13), turnIndex });

  it('开局 turnIndex=0 → Round 1', () => {
    const q = qualificationFromState(stateAt(0));
    expect(q.currentRound).toBe(1);
    expect(q.currentEligible).toBeNull();
  });

  it('第 15 手后（turnIndex=15）→ Round 6 = C', () => {
    const q = qualificationFromState(stateAt(15));
    expect(q.currentRound).toBe(6);
    expect(q.currentEligible).toBe('C');
  });

  it('第 18 手后（turnIndex=18）→ Round 7 = B', () => {
    const q = qualificationFromState(stateAt(18));
    expect(q.currentRound).toBe(7);
    expect(q.currentEligible).toBe('B');
  });
});
