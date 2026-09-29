/**
 * SRSZQ P3B(B6) —— 检查点与“续训声明”校验（规格 6.3 / 验收 D07）。
 *
 * 为什么要有这个模块：研究协议的验收标准里写着“搜索 scaling、校准 ECE/Brier、100k 训练量”等门槛，
 * 而这些结论只有在**能证明是同一段训练被继续**时才成立。缺 RNG / optimizer / step 之类的状态，
 * 把权重读回来接着训与“精确续训”是两回事；把它说成后者就是在伪造可复现性。
 *
 * 规则：
 *  1. EXACT_RESUME 必须字段齐全；缺任何一项就**拒绝**这个声明，并给出缺什么、以及能支持的最强声明；
 *  2. WEIGHTS_ONLY_LOAD 只需要权重，但必须显式列出“没有恢复什么”（RNG/优化器/步数）——不做静默升级；
 *  3. 校验只回答“这份元数据能不能支持这个声明”，不判断训练质量。
 */

export const CHECKPOINT_SCHEMA_VERSION = 1;

export interface CheckpointMeta {
  schema?: number;
  /** 权重文件的 sha256（不是路径）。 */
  weightsSha?: string | null;
  /** RNG 状态：决定后续采样/探索是否与中断处一致。 */
  rngState?: string | null;
  /** 优化器状态（Adam 动量等）。 */
  optimizerState?: string | null;
  /** 已完成的训练步数与局数。 */
  step?: number | null;
  episodes?: number | null;
  seedFrom?: number | null;
  seedTo?: number | null;
  engineVersion?: string | null;
  rulesetVersion?: string | null;
  configHash?: string | null;
  trajectoryHash?: string | null;
  budget?: string | null;
  sourceSha?: string | null;
  createdAt?: number | null;
  /** 棋盘分布（研究协议要求 13/17 分别计数，17 路 >= 30%）。 */
  boardSizeMix?: { b13?: number; b17?: number } | null;
}

export type ResumeClaim = 'EXACT_RESUME' | 'WEIGHTS_ONLY_LOAD';

/** EXACT_RESUME 必须齐全的字段：缺一不可，这是“可复现”的最低要求。 */
export const EXACT_RESUME_REQUIRED: Array<keyof CheckpointMeta> = [
  'weightsSha', 'rngState', 'optimizerState', 'step', 'episodes',
  'seedFrom', 'seedTo', 'engineVersion', 'rulesetVersion', 'configHash', 'trajectoryHash', 'budget',
];

/** WEIGHTS_ONLY_LOAD 只要求权重。 */
export const WEIGHTS_ONLY_REQUIRED: Array<keyof CheckpointMeta> = ['weightsSha'];

/** 仅加载权重时明确“没有恢复什么”，避免把不完整的东西说成完整。 */
export const NOT_RESTORED_IN_WEIGHTS_ONLY: Array<keyof CheckpointMeta> = [
  'rngState', 'optimizerState', 'step', 'episodes', 'seedFrom', 'seedTo', 'trajectoryHash', 'budget',
];

export interface ResumeValidation {
  ok: boolean;
  claim: ResumeClaim;
  missing: Array<keyof CheckpointMeta>;
  strongestSupported: ResumeClaim | null;
  notRestored: Array<keyof CheckpointMeta>;
  reasons: string[];
}

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

/** 这份元数据能支持的最强声明；连权重标识都没有就返回 null。 */
export function strongestDefensibleClaim(meta: CheckpointMeta): ResumeClaim | null {
  if (!EXACT_RESUME_REQUIRED.every((f) => isPresent(meta[f]))) {
    return WEIGHTS_ONLY_REQUIRED.every((f) => isPresent(meta[f])) ? 'WEIGHTS_ONLY_LOAD' : null;
  }
  return 'EXACT_RESUME';
}

export function validateResumeClaim(meta: CheckpointMeta, claim: ResumeClaim): ResumeValidation {
  const required = claim === 'EXACT_RESUME' ? EXACT_RESUME_REQUIRED : WEIGHTS_ONLY_REQUIRED;
  const missing = required.filter((f) => !isPresent(meta[f]));
  const strongest = strongestDefensibleClaim(meta);
  const reasons: string[] = [];

  if (missing.length > 0) {
    reasons.push(
      claim === 'EXACT_RESUME'
        ? '缺少 ' + missing.join(', ') + ' 时不得声明精确续训：把权重读回来继续训练与“从中断处继续”不是一回事。'
        : '连权重标识都缺失，无法加载。',
    );
  }
  if (claim === 'WEIGHTS_ONLY_LOAD' && missing.length === 0) {
    reasons.push('仅加载权重：后续采样与优化器状态都从头开始，因此这一段不能算作同一次训练的继续。');
  }
  if (claim === 'EXACT_RESUME' && missing.length === 0) {
    reasons.push('字段齐全，可以声明精确续训（仅表示元数据完整，不代表训练质量）。');
  }

  return {
    ok: missing.length === 0,
    claim,
    missing,
    strongestSupported: strongest,
    notRestored: claim === 'WEIGHTS_ONLY_LOAD' ? NOT_RESTORED_IN_WEIGHTS_ONLY.filter((f) => isPresent(meta[f])) : [],
    reasons,
  };
}

/** 研究协议门槛检查（规格 6.3：100k 训练量与既有验收标准不在本轮取消）。 */
export interface TrainingGateInput {
  formalEpisodes: number;
  episodesByBoardSize: { b13: number; b17: number };
  seatsCovered: string[];
  illegalMoves: number;
  crashes: number;
  nanDetected: boolean;
  calibrationReported: boolean;
}

export const RESEARCH_GATES = {
  minFormalEpisodes: 100000,
  minB17Share: 0.3,
  requiredSeats: ['A', 'B', 'C'],
} as const;

export interface TrainingGateResult {
  /** 只取 READY / PARTIAL / BLOCKED —— 与研究协议一致，不新增中间态。 */
  status: 'READY' | 'PARTIAL' | 'BLOCKED';
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export function evaluateTrainingGates(input: TrainingGateInput): TrainingGateResult {
  const b17Share = input.formalEpisodes > 0 ? input.episodesByBoardSize.b17 / input.formalEpisodes : 0;
  const seatsOk = RESEARCH_GATES.requiredSeats.every((s) => input.seatsCovered.includes(s));
  const checks = [
    { name: 'EPISODES_100K', ok: input.formalEpisodes >= RESEARCH_GATES.minFormalEpisodes, detail: input.formalEpisodes + ' / ' + RESEARCH_GATES.minFormalEpisodes },
    { name: 'B17_SHARE_30PCT', ok: b17Share >= RESEARCH_GATES.minB17Share, detail: (b17Share * 100).toFixed(1) + '%' },
    { name: 'SEATS_ABC', ok: seatsOk, detail: input.seatsCovered.join(',') || '无' },
    { name: 'NO_ILLEGAL_MOVE', ok: input.illegalMoves === 0, detail: String(input.illegalMoves) },
    { name: 'NO_CRASH', ok: input.crashes === 0, detail: String(input.crashes) },
    { name: 'NO_NAN', ok: !input.nanDetected, detail: input.nanDetected ? '检测到 NaN' : 'ok' },
    { name: 'CALIBRATION_REPORTED', ok: input.calibrationReported, detail: input.calibrationReported ? 'ok' : '未报告 ECE/Brier/log-loss' },
  ];
  const failed = checks.filter((c) => !c.ok);
  // 训练量不足 -> PARTIAL（可以继续训练）；质量类硬伤 -> BLOCKED（不能当成果）。
  const hardFail = failed.some((c) => ['NO_ILLEGAL_MOVE', 'NO_CRASH', 'NO_NAN'].includes(c.name));
  const status: TrainingGateResult['status'] = hardFail ? 'BLOCKED' : failed.length === 0 ? 'READY' : 'PARTIAL';
  return { status, checks };
}
