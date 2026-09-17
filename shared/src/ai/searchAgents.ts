import type { GameState } from '../game/types';
import { maxNSearch, type SearchResult } from './search';
import { TACTIC_CONFIG, OFFLINE_TACTIC_CONFIG } from './config/defaultWeights';

export interface SearchAgentOpts {
  timeBudgetMs?: number;
  candidateK?: number;
  maxDepth?: number;
  seed?: number;
  /** 离线（self-play/benchmark）使用更小预算 */
  offline?: boolean;
}

/** 3-PLY 计策：固定深度 3 的 MaxN 搜索（覆盖完整三人行动循环）。 */
export function threePlySearch(state: GameState, opts: SearchAgentOpts = {}): SearchResult {
  const cfg = (opts.offline ? OFFLINE_TACTIC_CONFIG : TACTIC_CONFIG)['3ply'];
  return maxNSearch(
    state,
    {
      timeBudgetMs: opts.timeBudgetMs ?? cfg.timeBudgetMs,
      maxDepth: 3,
      candidateK: opts.candidateK ?? cfg.candidateK ?? 12,
    },
    opts.seed,
  );
}

/**
 * MAXN 计策：宽候选 MaxN（k ≥ 3ply）+ 换位表 + 叶节点必胜稳定化。
 * 引擎保留迭代加深结构；当前静态评估下自对弈实测 d3 为最佳深度
 * （d4+ 净负收益，见 AI_TUNING_REPORT.md），预算内只完成 d3。
 */
export function maxnSearch(state: GameState, opts: SearchAgentOpts = {}): SearchResult {
  const cfg = (opts.offline ? OFFLINE_TACTIC_CONFIG : TACTIC_CONFIG).maxn;
  return maxNSearch(
    state,
    {
      timeBudgetMs: opts.timeBudgetMs ?? cfg.timeBudgetMs,
      maxDepth: opts.maxDepth ?? cfg.maxDepth ?? 3,
      candidateK: opts.candidateK ?? cfg.candidateK ?? 10,
    },
    opts.seed,
  );
}
