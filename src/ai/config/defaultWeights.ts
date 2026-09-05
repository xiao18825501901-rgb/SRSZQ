/** SRSZQ AI 评估权重（一套权重适用于 A/B/C 任意座位 —— 禁止座位特化） */

export interface EvalWeights {
  /** 己方几何胜点（近资格轮价值倍率放大） */
  ownWinningPoint: number;
  /** 对方几何胜点（威胁） */
  oppWinningPoint: number;
  /** 对方胜点且对方为「下一行动者且有资格」的紧急威胁 */
  immediateOppThreat: number;
  openThree: number;
  halfOpenThree: number;
  openTwo: number;
  fork: number;
  /** 每差一个资格轮，攻击/威胁型棋型的折扣/加成（roundsUntil 为 0 表示本轮有资格） */
  qualificationDistanceDiscount: number;
  /** 轮到自己有资格还需 >3 轮时，攻击棋型价值的保守系数 */
  farAttackDiscount: number;
  center: number;
  connectivity: number;
  /** 无资格时自身形成禁手点（自陷）的轻微惩罚系数 */
  forbiddenTrapPenalty: number;
  stones: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  ownWinningPoint: 55,
  oppWinningPoint: 45,
  immediateOppThreat: 80,
  openThree: 9,
  halfOpenThree: 4.5,
  openTwo: 1.6,
  fork: 14,
  qualificationDistanceDiscount: 0.22,
  farAttackDiscount: 0.55,
  center: 0.05,
  connectivity: 0.35,
  forbiddenTrapPenalty: 0.9,
  stones: 0.25,
};

/** 各档 AI 的运行参数（网页在线配置） */
export const LEVEL_CONFIG: Record<
  string,
  { timeBudgetMs: number; maxDepth?: number; candidateK?: number; minDisplayMs: number }
> = {
  random: { timeBudgetMs: 20, minDisplayMs: 220 },
  tactical: { timeBudgetMs: 120, minDisplayMs: 260 },
  selfish: { timeBudgetMs: 300, minDisplayMs: 300 },
  // 3-Ply 保证完成「完整一轮三人行动」：k7 → d3 ≈ 400-600 节点，中盘 ~150-300ms
  '3ply': { timeBudgetMs: 800, maxDepth: 3, candidateK: 7, minDisplayMs: 450 },
  // MaxN：宽候选 d3（k9 ⊇ 3ply 的 k7，同深度下严格不弱于 3ply）+ 叶必胜稳定化。
  // 预算必须保证 d3 在密盘也完整完成（k9 d3 ≈ 1.1k 节点 ≈ 1s 级），否则边界截断
  // 会退回 d2 —— 自对弈实测这是早期版本 maxn 偏弱的主因（见 AI_TUNING_REPORT.md）。
  maxn: { timeBudgetMs: 1500, maxDepth: 3, candidateK: 9, minDisplayMs: 500 },
};

/** 离线 self-play 使用更小的预算以加快评测 */
export const OFFLINE_LEVEL_CONFIG: Record<
  string,
  { timeBudgetMs: number; maxDepth?: number; candidateK?: number }
> = {
  random: { timeBudgetMs: 5 },
  tactical: { timeBudgetMs: 30 },
  selfish: { timeBudgetMs: 60 },
  '3ply': { timeBudgetMs: 500, maxDepth: 3, candidateK: 7 },
  maxn: { timeBudgetMs: 1200, maxDepth: 3, candidateK: 9 },
};
