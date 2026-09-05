import type { GameState, Player } from '../game/types';

/** 五档 AI 难度 */
export type AILevel = 'random' | 'tactical' | 'selfish' | '3ply' | 'maxn';

export const AI_LEVELS: readonly AILevel[] = ['random', 'tactical', 'selfish', '3ply', 'maxn'];

export const AI_LEVEL_LABELS: Record<AILevel, string> = {
  random: 'Random',
  tactical: 'Tactical',
  selfish: 'Selfish',
  '3ply': '3-Ply',
  maxn: 'MaxN',
};

export const AI_LEVEL_STARS: Record<AILevel, string> = {
  random: '★☆☆☆☆',
  tactical: '★★☆☆☆',
  selfish: '★★★☆☆',
  '3ply': '★★★★☆',
  maxn: '★★★★★',
};

export const AI_LEVEL_DESCRIPTIONS: Record<AILevel, string> = {
  random: '随机选择合法动作。适合熟悉规则。',
  tactical: '能识别即时胜负与明显威胁（立即胜点 / 关键封堵）。',
  selfish: '考虑 BAC 资格轮并优先最大化自己的获胜机会，不做无谓防守。',
  '3ply': '搜索一个完整的三人行动循环（MaxN 向量评估）。',
  maxn: 'BAC-aware MaxN 搜索：更宽候选的完整三人循环 + 叶节点必胜稳定化，最强难度。',
};

/** 座位类型 */
export type SeatKind = 'human' | 'ai';

export interface SeatConfig {
  kind: SeatKind;
  level?: AILevel;
}

export type SeatConfigs = Record<Player, SeatConfig>;

/** AI 决策结果 */
export interface AIDecision {
  /** 落子坐标（0-based）；pass=true 表示无合法步自动 Pass */
  row: number;
  col: number;
  pass: boolean;
  /** 叶节点效用向量 [uA, uB, uC]（搜索类 AI）或启发式分数 */
  score?: number[];
  depth?: number;
  nodes?: number;
  thinkTimeMs?: number;
  ttHits?: number;
  candidates?: number;
  reason?: string;
}

export interface AIOptions {
  /** 决策时间预算（毫秒）。random/tactical/selfish 通常远小于预算 */
  timeBudgetMs?: number;
  /** MaxN 最大深度上限 */
  maxDepth?: number;
  /** 确定性随机种子（调试可复现） */
  seed?: number;
  /** 候选动作上限（3ply / maxn 剪枝） */
  candidateK?: number;
}

/** 决策上下文 */
export interface AIDecisionContext {
  state: GameState;
  player: Player;
  level: AILevel;
  options?: AIOptions;
}

export const DEFAULT_AI_OPTIONS: Required<Pick<AIOptions, 'timeBudgetMs' | 'maxDepth' | 'candidateK'>> = {
  timeBudgetMs: 1500,
  maxDepth: 8,
  candidateK: 12,
};
