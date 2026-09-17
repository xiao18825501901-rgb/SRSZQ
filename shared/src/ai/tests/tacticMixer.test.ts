import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../game/rules';
import { selectTactic, TACTIC_PROFILES } from '../tacticMixer';
import { chooseAIMove } from '../chooseAIMove';
import { mulberry32 } from '../rng';
import { AI_DIFFICULTIES, TACTIC_IDS, type AiDifficulty, type AIDecision } from '../types';

describe('stochastic tactic profiles', () => {
  it('defines five non-zero tactics summing to 100% for every difficulty', () => {
    for (const difficulty of AI_DIFFICULTIES) {
      const profile = TACTIC_PROFILES[difficulty];
      expect(Object.keys(profile)).toEqual([...TACTIC_IDS]);
      expect(Object.values(profile).every((weight) => weight > 0)).toBe(true);
      expect(Object.values(profile).reduce((sum, weight) => sum + weight, 0)).toBe(1);
    }
  });

  it.each(AI_DIFFICULTIES)('%s-star seeded frequency stays within 1%', (difficulty: AiDifficulty) => {
    const rng = mulberry32(0x5a17c1 + difficulty);
    const counts = Object.fromEntries(TACTIC_IDS.map((tactic) => [tactic, 0])) as Record<(typeof TACTIC_IDS)[number], number>;
    const samples = 100_000;
    for (let i = 0; i < samples; i++) counts[selectTactic(difficulty, rng)]++;
    for (const tactic of TACTIC_IDS) {
      expect(counts[tactic]).toBeGreaterThan(0);
      expect(Math.abs(counts[tactic] / samples - TACTIC_PROFILES[difficulty][tactic])).toBeLessThanOrEqual(0.01);
    }
  });

  it('samples again on every move and reports the selected tactic internally', () => {
    const draws = [0.01, 0.99];
    let index = 0;
    const rng = { next: () => draws[index++], int: () => 0, pick: <T>(items: readonly T[]) => items[0] };
    const state = createInitialState(13);
    const first = chooseAIMove(state, 'A', 3, { rng });
    const second = chooseAIMove(state, 'A', 3, { rng });
    expect(first.selectedTactic).toBe('random');
    expect(second.selectedTactic).toBe('maxn');
  });

  it('falls back deterministically without a second tactic draw when a tactic throws', () => {
    let draws = 0;
    const rng = { next: () => { draws++; return 0; }, int: () => 0, pick: <T>(items: readonly T[]) => items[0] };
    const state = createInitialState(13);
    const decision = chooseAIMove(state, 'A', 1, {
      rng,
      tacticRunner: () => { throw new Error('synthetic tactic failure'); },
    });
    expect(decision.pass).toBe(false);
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.selectedTactic).toBe('random');
    expect(draws).toBe(1);
  });

  it('falls back on an invalid tactic move without resampling', () => {
    const state = createInitialState(13);
    const invalid: AIDecision = { row: 99, col: 99, pass: false };
    const decision = chooseAIMove(state, 'A', 5, {
      seed: 1,
      tacticRunner: () => invalid,
    });
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.row).toBe(0);
    expect(decision.col).toBe(0);
  });

  it('falls back when a tactic returns no decision', () => {
    const state = createInitialState(13);
    const decision = chooseAIMove(state, 'A', 2, {
      seed: 9,
      tacticRunner: () => undefined as unknown as AIDecision,
    });
    expect(decision.fallbackUsed).toBe(true);
    expect([decision.row, decision.col]).toEqual([0, 0]);
  });
});
