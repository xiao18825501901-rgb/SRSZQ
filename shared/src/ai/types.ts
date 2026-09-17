import type { GameState, Player } from '../game/types';
import type { RNG } from './rng';

export type AiDifficulty = 1 | 2 | 3 | 4 | 5;
/** Compatibility name for existing seat/UI call sites; values are numeric stars. */
export type AILevel = AiDifficulty;
export type TacticId = 'random' | 'tactical' | 'selfish' | '3ply' | 'maxn';

export const AI_DIFFICULTIES: readonly AiDifficulty[] = [1, 2, 3, 4, 5];
export const AI_LEVELS = AI_DIFFICULTIES;
export const TACTIC_IDS: readonly TacticId[] = ['random', 'tactical', 'selfish', '3ply', 'maxn'];

export const AI_LEVEL_LABELS: Record<AiDifficulty, string> = {
  1: '1-Star', 2: '2-Star', 3: '3-Star', 4: '4-Star', 5: '5-Star',
};
export const TACTIC_LABELS: Record<TacticId, string> = {
  random: 'Random', tactical: 'Tactical', selfish: 'Selfish', '3ply': '3-Ply', maxn: 'MaxN',
};
export const AI_LEVEL_STARS: Record<AiDifficulty, string> = {
  1: '★☆☆☆☆', 2: '★★☆☆☆', 3: '★★★☆☆', 4: '★★★★☆', 5: '★★★★★',
};
export const AI_LEVEL_DESCRIPTIONS: Record<AiDifficulty, string> = {
  1: '偏向轻松与随机，但每一手都可能使用任一种计策。',
  2: '偏向浅层计策，并保留完整的五计策变化。',
  3: '五种计策均衡混合。',
  4: '更常采用深层计策，同时保留不可预测性。',
  5: '最偏向深层搜索，但仍会偶尔采用其他计策。',
};

export type SeatKind = 'human' | 'ai';
export interface SeatConfig { kind: SeatKind; level?: AiDifficulty; }
export type SeatConfigs = Record<Player, SeatConfig>;

export interface AIDecision {
  row: number;
  col: number;
  pass: boolean;
  score?: number[];
  depth?: number;
  nodes?: number;
  thinkTimeMs?: number;
  ttHits?: number;
  candidates?: number;
  reason?: string;
  /** Internal experiment/telemetry field; ordinary player UI must not render it. */
  selectedTactic?: TacticId;
  fallbackUsed?: boolean;
}

export interface MatchPolicyContext {
  protectSingleHuman?: boolean;
  humanSeat?: Player;
  defenseFastestThreat?: boolean;
}

export interface TacticRunOptions {
  timeBudgetMs?: number;
  maxDepth?: number;
  seed?: number;
  candidateK?: number;
  policy?: MatchPolicyContext;
}
export type TacticRunner = (
  tactic: TacticId,
  state: GameState,
  player: Player,
  rng: RNG,
  options: TacticRunOptions,
) => AIDecision;
export interface AIOptions extends TacticRunOptions {
  rng?: RNG;
  tacticRunner?: TacticRunner;
}
export interface AIDecisionContext {
  state: GameState;
  player: Player;
  difficulty: AiDifficulty;
  options?: AIOptions;
}
export const DEFAULT_AI_OPTIONS: Required<Pick<AIOptions, 'timeBudgetMs' | 'maxDepth' | 'candidateK'>> = {
  timeBudgetMs: 1500,
  maxDepth: 8,
  candidateK: 12,
};
