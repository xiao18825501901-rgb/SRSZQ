import type { RNG } from './rng';
import { TACTIC_IDS, type AiDifficulty, type TacticId } from './types';

export type TacticProfile = Readonly<Record<TacticId, number>>;
export const TACTIC_PROFILES: Readonly<Record<AiDifficulty, TacticProfile>> = {
  1: { random: 0.45, tactical: 0.22, selfish: 0.15, '3ply': 0.10, maxn: 0.08 },
  2: { random: 0.31, tactical: 0.22, selfish: 0.19, '3ply': 0.15, maxn: 0.13 },
  3: { random: 0.20, tactical: 0.20, selfish: 0.20, '3ply': 0.20, maxn: 0.20 },
  4: { random: 0.12, tactical: 0.16, selfish: 0.19, '3ply': 0.24, maxn: 0.29 },
  5: { random: 0.08, tactical: 0.12, selfish: 0.16, '3ply': 0.25, maxn: 0.39 },
};

/** Selection depends only on difficulty and exactly one RNG draw. */
export function selectTactic(difficulty: AiDifficulty, rng: RNG): TacticId {
  const profile = TACTIC_PROFILES[difficulty];
  const draw = Math.max(0, Math.min(1 - Number.EPSILON, rng.next()));
  let cumulative = 0;
  for (const tactic of TACTIC_IDS) {
    cumulative += profile[tactic];
    if (draw < cumulative) return tactic;
  }
  return 'maxn';
}
