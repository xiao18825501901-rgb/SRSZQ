import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../game/rules';
import { chooseAIMove, chooseTacticMove } from '../chooseAIMove';
import { allHumanSeats, parseSeatConfigs, seatsEqual, serializeSeats } from '../seats';
import { AI_LEVEL_BRANDS, aiLevelBrand } from '../types';

describe('AI brand aliases', () => {
  it('maps only the existing top levels to Terra and Sol', () => {
    expect(AI_LEVEL_BRANDS[4]).toBe('Terra');
    expect(AI_LEVEL_BRANDS[5]).toBe('Sol');
    expect(aiLevelBrand(1)).toBeUndefined();
    expect(aiLevelBrand(2)).toBeUndefined();
    expect(aiLevelBrand(3)).toBeUndefined();
  });

  it('runs Astra as pure MaxN without consulting the mixed tactic runner', () => {
    const state = createInitialState(13);
    const runner = vi.fn((_tactic: string) => ({ row: 6, col: 6, pass: false }));
    const decision = chooseTacticMove(state, 'A', 'astra', { seed: 41, timeBudgetMs: 10, maxDepth: 1, candidateK: 1, tacticRunner: runner });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toBe('astra');
    expect(decision.selectedTactic).toBe('astra');
    expect([decision.row, decision.col]).toEqual([6, 6]);
  });

  it('routes the public AI entry point through Astra without a mixed draw', () => {
    const state = createInitialState(13);
    const runner = vi.fn((_tactic: string) => ({ row: 5, col: 6, pass: false }));
    const decision = chooseAIMove(state, 'A', 5, {
      strategy: 'astra',
      seed: 41,
      timeBudgetMs: 10,
      maxDepth: 1,
      candidateK: 1,
      tacticRunner: runner,
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toBe('astra');
    expect(decision.selectedTactic).toBe('astra');
  });

  it('maps Astra to the real MaxN engine', () => {
    const state = createInitialState(13);
    const decision = chooseTacticMove(state, 'A', 'astra', {
      seed: 42, timeBudgetMs: 10, maxDepth: 1, candidateK: 1,
    });
    expect(decision.reason).toContain('Astra pure MaxN');
    expect(decision.depth).toBe(1);
    expect(decision.fallbackUsed).toBeFalsy();
  });

  it('round-trips Astra seat strategy and treats mixed versus Astra as a change', () => {
    const seats = allHumanSeats();
    seats.B = { kind: 'ai', level: 5, strategy: 'astra' };

    expect(parseSeatConfigs(serializeSeats(seats))).toEqual(seats);
    expect(seatsEqual(seats, {
      ...seats,
      B: { kind: 'ai', level: 5 },
    })).toBe(false);
  });
});
