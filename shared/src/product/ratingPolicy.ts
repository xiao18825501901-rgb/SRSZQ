/**
 * 排位与评分策略（P1 / B3）。
 *
 * 本文件严格实现原规格 01_PRODUCT_IMPLEMENTATION_SPEC_CN.md 第 4 节，
 * 不自行发明语义。规格原文要点：
 *  - 4.1 分开记录：快速人机/好友/教学/本地**不改真人竞技分**；
 *        新赛季 beta 仅 3 真人随机匹配且满足门禁才 eligible；13/17 分池分开；
 *        ratingBeta 默认关闭；合成/测试/演示账号不进公开排行榜。
 *  - 4.2 V1 算法：初始化 R=1200，winner-only softmax：
 *        p_i = exp(ln10*(R_i - maxR)/400) / Σ_j exp(ln10*(R_j - maxR)/400)
 *        Delta_i = 24 * (y_i - p_i)
 *      正常胜者 y=1，另两人 y=0；真平局 y=1/3；
 *      单人退出/超时：forfeit 者 y=0，两位 survivor 各 1/2；
 *      两位都 forfeit 只剩一人则其 y=1；全部 forfeit 或 SYSTEM_ABORT **不更新 rating**。
 *      定点至少 1e-4，舍入残差在最大绝对 delta 项上校正以保持 ΣDelta = 0；
 *      不在 0 处 clamp（clamp 会让总和变正）。
 *  - 4.2 重复对手：同一三人组合 24 小时内第 4 局起竞技分变动为 0。
 *
 * 规格自带的两个例子可直接当回归基准：
 *   三人同分正常局 -> +16/-8/-8；三人同分单人退出 -> -8/+4/+4。
 */
import type { ParticipantOutcome, Seat, SettlementPlan } from './resultModel.js';

/* ------------------------------------------------------------------ */
/* 策略版本                                                            */
/* ------------------------------------------------------------------ */

/** 历史策略：只要 online 就 +/-30/-10。保留用于 3 真人局的过渡期与历史对账。 */
export const LEGACY_POLICY_ID = 'legacy-online-v1';
/** 新赛季产品 beta：规格 4.2 的 V1 算法。 */
export const BETA_V1_POLICY_ID = 'rating-beta-v1';
/** 不产生任何竞技分变动。 */
export const NO_RATING_POLICY_ID = 'none';

export type RatingPolicyId = typeof LEGACY_POLICY_ID | typeof BETA_V1_POLICY_ID | typeof NO_RATING_POLICY_ID;

/** 历史策略的固定增减（仅用于 3 真人局的过渡期）。 */
export const LEGACY_DELTA = Object.freeze({ win: 30, loss: -10 });

/** V1 基础分与缩放。 */
export const RATING_INITIAL = 1200;
export const RATING_SCALE = 24;
export const RATING_DECIMALS = 4; // 定点 >= 1e-4

/* ------------------------------------------------------------------ */
/* 开局前预判（规格 4.2：第 4 局起不计分「且开局前提示」）              */
/* ------------------------------------------------------------------ */

/**
 * 开局前能确定的部分：这一局**结束时会不会计竞技分**。
 *
 * 为什么需要它：规格 4.2 要求重复对手保护「第 4 局起不计竞技分，**且开局前提示**，
 * 不静默在赛后改政策」。此前只实现了前半句 —— 分数确实不变，但玩家是赛后才发现的。
 *
 * 口径与结算**共用同一套输入**（模式 / 座位是否真人 / 门禁 / 24h 内同组合第几局 / beta 开关），
 * 所以预判与最终结算不会各说各话。
 *
 * 唯一不可预知的是终局原因：`noContest`（全离场 / SYSTEM_ABORT）只有打完才知道，
 * 因此预判一律按 noContest=false 计算，并且**只用于提示**，绝不参与结算。
 */
export interface RatingPreview {
  /** 结束后是否会变动真人竞技分。 */
  ranked: boolean;
  policy: RatingPolicyId;
  /** 不计分的原因；计分时为 null。 */
  reason: IneligibilityReason | null;
}

/**
 * 预判入参：与结算同一组字段，但 `noContest` 是**可选且会被忽略**的
 * （调用方常常手里就有一个完整的 EligibilityInput，没必要先删字段再传）。
 */
export type RatingPreviewInput = Omit<EligibilityInput, 'noContest'> & { noContest?: boolean };

export function previewRatingAtStart(input: RatingPreviewInput): RatingPreview {
  // 注意：无论调用方传了什么 noContest，这里都按 false 算 —— 终局原因只有打完才知道。
  const base: EligibilityInput = { ...input, noContest: false };
  const policy = resolveRatingPolicy(base);
  if (policy !== NO_RATING_POLICY_ID) return { ranked: true, policy, reason: null };
  const beta = evaluateBetaEligibility(base);
  return { ranked: false, policy, reason: beta.eligible ? null : beta.reason };
}

/* ------------------------------------------------------------------ */
/* 资格判定（规格 4.1 / 55 / 142）                                      */
/* ------------------------------------------------------------------ */

export type IneligibilityReason =
  | 'NOT_ONLINE_MODE'
  | 'NOT_THREE_HUMANS'
  | 'NOT_TUTORIAL_COMPLETE'
  | 'BETA_DISABLED'
  | 'NO_CONTEST'
  | 'REPEAT_OPPONENTS';

export interface EligibilityInput {
  mode: 'online' | 'invite';
  /** 每个座位是否真人（AI 补位座位为 false）。 */
  seatIsHuman: Record<Seat, boolean>;
  /** 每个真人座位是否已通过门禁（当前口径：三步教学完成）。 */
  seatGatePassed: Record<Seat, boolean>;
  ratingBeta: boolean;
  /** 本局是否为「不产生竞技后果」的终局（全离场 / SYSTEM_ABORT）。 */
  noContest: boolean;
  /** 同一三人组合在 24 小时内的第几局（1 = 首局）。 */
  sameTrioMatchNumber: number;
}

export type Eligibility =
  | { eligible: true; policy: typeof BETA_V1_POLICY_ID }
  | { eligible: false; policy: RatingPolicyId; reason: IneligibilityReason };

/**
 * 判定本局是否进入**新赛季 beta** 排位。
 *
 * 注意这里的口径是「beta 是否生效」，不是「这局有没有积分」：
 * 快速人机局即使在 beta 关闭时也不会拿到 legacy 分（见 resolveRatingPolicy）。
 */
export function evaluateBetaEligibility(input: EligibilityInput): Eligibility {
  if (input.noContest) return { eligible: false, policy: NO_RATING_POLICY_ID, reason: 'NO_CONTEST' };
  if (input.mode !== 'online') return { eligible: false, policy: NO_RATING_POLICY_ID, reason: 'NOT_ONLINE_MODE' };
  const humans = (['A', 'B', 'C'] as Seat[]).filter((s) => input.seatIsHuman[s]);
  if (humans.length !== 3) return { eligible: false, policy: NO_RATING_POLICY_ID, reason: 'NOT_THREE_HUMANS' };
  if (humans.some((s) => !input.seatGatePassed[s])) {
    return { eligible: false, policy: NO_RATING_POLICY_ID, reason: 'NOT_TUTORIAL_COMPLETE' };
  }
  if (input.sameTrioMatchNumber >= 4) {
    return { eligible: false, policy: NO_RATING_POLICY_ID, reason: 'REPEAT_OPPONENTS' };
  }
  if (!input.ratingBeta) return { eligible: false, policy: NO_RATING_POLICY_ID, reason: 'BETA_DISABLED' };
  return { eligible: true, policy: BETA_V1_POLICY_ID };
}

/**
 * 本局实际采用的评分策略。
 *
 *  - beta 生效且 eligible            -> rating-beta-v1（V1 算法）
 *  - beta 关闭但**恰好 3 真人**在线局 -> legacy-online-v1（过渡期保留旧口径）
 *  - 其余一切（AI 补位、好友局、教学、本地、无竞技后果）
 *                                    -> none（**不改真人竞技分**）
 *
 * 最后一条正是规格 4.1/55 的硬要求：快速人机局带 AI 补位，必须标「不计真人排位」，
 * 绝不能因为「mode=online」就给真人加/减竞技分。
 */
export function resolveRatingPolicy(input: EligibilityInput): RatingPolicyId {
  const beta = evaluateBetaEligibility(input);
  if (beta.eligible) return BETA_V1_POLICY_ID;
  // 过渡期**唯一**允许走旧口径的例外：恰好 3 真人 online、有竞技后果、门禁通过，
  // 且不合格的原因仅仅是「beta 开关没打开」。
  //
  // 这里必须按 reason 精确判断，不能写成「不合格就回退 legacy」——
  // 那样重复对手保护（规格 4.2：24h 内第 4 局起变动为 0）会被 legacy 悄悄绕过，
  // 实测正是这个写法让第 4 局仍然 +/-30/-10。
  if (beta.reason === 'BETA_DISABLED') return LEGACY_POLICY_ID;
  return NO_RATING_POLICY_ID;
}

/* ------------------------------------------------------------------ */
/* V1 算法                                                             */
/* ------------------------------------------------------------------ */

export interface RatedParticipant {
  seat: Seat;
  userId: string;
  rating: number;
}

/** 规格 4.2 的 y 值分配（winner-only softmax，不比较两个败者）。 */
export interface ScoreTargets {
  /** seat -> y_i */
  y: Record<Seat, number>;
  /** 是否产生 rating 更新（全部 forfeit / SYSTEM_ABORT 时为 false）。 */
  updatesRating: boolean;
  reason: string;
}

/**
 * 从结算计划推导 y 值。只依赖 P0A 已经定好的名次语义，不重新解释棋局。
 */
export function deriveScoreTargets(plan: SettlementPlan): ScoreTargets {
  const seats = plan.participants.map((p) => p.seat);
  const y: Record<string, number> = {};
  for (const s of seats) y[s] = 0;

  if (plan.endReason === 'SYSTEM_ABORT') {
    return { y: y as Record<Seat, number>, updatesRating: false, reason: 'SYSTEM_ABORT' };
  }

  const humans = plan.participants.filter((p) => p.kind === 'human' && !!p.userId);
  const forfeited = humans.filter((p) => p.outcome === 'LOSS');
  const winners = humans.filter((p) => p.outcome === 'WIN');
  const drawn = humans.filter((p) => p.outcome === 'DRAW');

  // 真平局：y = 1/3
  if (plan.endReason === 'BOARD_DRAW' || (drawn.length > 0 && winners.length === 0 && forfeited.length === 0)) {
    for (const p of drawn) y[p.seat] = 1 / 3;
    return { y: y as Record<Seat, number>, updatesRating: true, reason: 'BOARD_DRAW' };
  }

  const isForfeitEnd = plan.endReason === 'PLAYER_FORFEIT' || plan.endReason === 'TIMEOUT' || plan.endReason === 'PLAYER_DISCONNECT';

  if (isForfeitEnd) {
    // 规格：forfeit 者 y=0；两位 survivor 各 1/2；两位都 forfeit 只剩一人则其 y=1。
    for (const p of forfeited) y[p.seat] = 0;
    const survivors = humans.filter((p) => p.outcome === 'WIN');
    if (survivors.length === 0) {
      // 没有幸存者：全部 forfeit -> 不更新
      if (forfeited.length === humans.length && humans.length > 0) {
        return { y: y as Record<Seat, number>, updatesRating: false, reason: 'ALL_FORFEIT' };
      }
      return { y: y as Record<Seat, number>, updatesRating: false, reason: 'NO_SURVIVOR' };
    }
    const share = survivors.length === 1 ? 1 : 1 / 2;
    for (const p of survivors) y[p.seat] = share;
    return { y: y as Record<Seat, number>, updatesRating: true, reason: 'FORFEIT' };
  }

  // 正常成四：胜者 y=1，其余 y=0
  for (const p of winners) y[p.seat] = 1;
  return { y: y as Record<Seat, number>, updatesRating: true, reason: 'NORMAL_WIN' };
}

export interface RatingDelta {
  seat: Seat;
  userId: string;
  ratingBefore: number;
  /** 定点后的变动（>=1e-4 精度），ΣDelta 精确为 0。 */
  delta: number;
  /** UI 展示用的整数（仅展示，不写回底层分）。 */
  deltaDisplay: number;
  y: number;
  p: number;
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * 计算 V1 的 Delta。纯函数，可穷举测试。
 *
 * ΣDelta = 0 的实现：先按 1e-4 定点，再把舍入残差**全部**加到 |delta| 最大的那一项上。
 * 残差最多几 e-5，相对该项可忽略，但能保证账本严格零和。
 */
export function computeRatingDeltas(
  participants: RatedParticipant[],
  targets: ScoreTargets,
  scale = RATING_SCALE,
  decimals = RATING_DECIMALS,
): RatingDelta[] {
  if (participants.length === 0) return [];
  const maxR = Math.max(...participants.map((p) => p.rating));
  const ln10 = Math.LN10;
  const exps = participants.map((p) => Math.exp((ln10 * (p.rating - maxR)) / 400));
  const sum = exps.reduce((a, b) => a + b, 0);
  const rows = participants.map((p, i) => {
    const prob = sum > 0 ? exps[i] / sum : 1 / participants.length;
    const y = targets.y[p.seat] ?? 0;
    return {
      seat: p.seat,
      userId: p.userId,
      ratingBefore: p.rating,
      delta: roundTo(scale * (y - prob), decimals),
      deltaDisplay: 0,
      y,
      p: prob,
    } as RatingDelta;
  });

  const residual = roundTo(rows.reduce((a, r) => a + r.delta, 0), decimals);
  if (residual !== 0) {
    let idx = 0;
    for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].delta) > Math.abs(rows[idx].delta)) idx = i;
    rows[idx].delta = roundTo(rows[idx].delta - residual, decimals);
  }
  for (const r of rows) r.deltaDisplay = Math.round(r.delta);
  return rows;
}

/** 旧策略的 Delta（仅 3 真人过渡期使用）。 */
export function computeLegacyDeltas(
  participants: Array<RatedParticipant & { outcome: ParticipantOutcome }>,
): RatingDelta[] {
  return participants.map((p) => {
    const raw = p.outcome === 'WIN' ? LEGACY_DELTA.win : p.outcome === 'LOSS' ? LEGACY_DELTA.loss : 0;
    return {
      seat: p.seat, userId: p.userId, ratingBefore: p.rating,
      delta: raw, deltaDisplay: raw, y: p.outcome === 'WIN' ? 1 : 0, p: 0,
    };
  });
}

/**
 * 应用 Delta 到分值。**不在 0 处 clamp** —— 规格明确：clamp 会让总和变正。
 * 产品 beta 如需最低显示分，只能改展示层。
 */
export function applyDeltas(participants: Array<{ rating: number }>, deltas: RatingDelta[]): number[] {
  return participants.map((p, i) => roundTo(p.rating + (deltas[i]?.delta ?? 0), RATING_DECIMALS));
}
