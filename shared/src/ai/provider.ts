/**
 * SRSZQ P3B(B6) —— 统一 DecisionProvider / AnalysisProvider 接口（规格 6.3）。
 *
 * 规格要求：先实现统一接口，**五档现有 AI 是默认生产 provider**；Invitus 只在
 * “禁用 feature flag + shadow adapter”之后才可能接入。本模块把这句话变成类型：
 *
 *  - `resolveProvider` 返回的 `mover` 永远来自生产 provider；
 *  - shadow 只出现在 `telemetry` 字段里，它的决策在类型上就没有位置可以变成落子；
 *  - flag 关闭（默认）时 shadow 根本不会被调用；
 *  - Invitus 适配器在权重/元数据不全时返回 refused，绝不“猜一手”顶上。
 *
 * 这里不做任何训练：本批次只评测**现有**五档，不编造训练完成。
 */
import type { GameState, Player } from '../game/types.js';
import type { AIDecision, AiDifficulty } from './types.js';
import { chooseAIMove } from './chooseAIMove.js';
import { createInitialState } from '../game/rules.js';
import { getLegalMoves } from '../game/legalMoves.js';
import { validateResumeClaim, type CheckpointMeta, type ResumeClaim } from './checkpoint.js';

export type ProviderKind = 'PRODUCTION' | 'SHADOW' | 'RESEARCH';

export interface DecisionRequest {
  state: GameState;
  player: Player;
  level: AiDifficulty;
  seed?: number;
  timeBudgetMs?: number;
  /** 固定深度：与宽松时间预算一起用，才能让同种子重跑逐手一致。 */
  maxDepth?: number;
}

export type DecisionOutcome =
  | { kind: 'decided'; decision: AIDecision; providerId: string }
  | { kind: 'refused'; reason: string; missing: string[]; providerId: string };

export interface DecisionProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  decide(request: DecisionRequest): DecisionOutcome;
}

export interface AnalysisRequest {
  state: GameState;
  /** 已有的合法手候选（由调用方用引擎算出，provider 不得自己改棋盘）。 */
  legalMoves: Array<{ row: number; col: number }>;
}

export interface AnalysisProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  analyze(request: AnalysisRequest): { ok: true; evidence: Record<string, unknown> } | { ok: false; reason: string };
}

/**
 * 可复现搜索预算。
 *
 * 实测结论（见 P3B 批次记录）：现有引擎用**墙钟时间预算**控制搜索，没有节点预算旋钮。
 * 一旦时间预算成为约束，同一 seed 会因运行时速度（JIT 冷热、机器负载）搜到不同深度，
 * 走出不同的棋。因此评测/研究运行必须给一个“搜索一定跑得完”的预算，
 * 并把实际耗时与预算的比值记录下来，证明预算没有卡住搜索。
 *
 * 这是本批次相对规格 6.3“固定节点预算”的已知差距：我们只能用固定深度 + 宽松时间预算逼近。
 */
export const DETERMINISTIC_SEARCH_BUDGET = { timeBudgetMs: 3000, maxDepth: 3 } as const;

/** 生产 provider：直接使用现有五档 AI（默认且唯一会真正落子的实现）。 */
export function createProductionProvider(): DecisionProvider {
  return {
    id: 'production-five-levels',
    kind: 'PRODUCTION',
    label: '现有五档 AI（生产默认）',
    decide(request: DecisionRequest): DecisionOutcome {
      const decision = chooseAIMove(request.state, request.player, request.level, {
        seed: request.seed,
        timeBudgetMs: request.timeBudgetMs,
        maxDepth: request.maxDepth,
      });
      // 合法性由引擎复核：provider 说合法不算合法。
      const legal = getLegalMoves(request.state).some((m) => m.row === decision.row && m.col === decision.col);
      if (!legal && !decision.pass) {
        return { kind: 'refused', reason: 'PROVIDER_ILLEGAL_MOVE', missing: [], providerId: 'production-five-levels' };
      }
      return { kind: 'decided', decision, providerId: 'production-five-levels' };
    },
  };
}

export interface ShadowAdapterOptions {
  id: string;
  label: string;
  meta: CheckpointMeta;
  /** 适配器声称的续训方式；校验不通过就拒绝运行。 */
  claim: ResumeClaim;
  /** 元数据齐全时的实际决策函数（测试里可注入桩）。 */
  decideWith?: (request: DecisionRequest) => AIDecision;
}

/**
 * research/shadow 适配器（例如 Invitus）。它的存在意义是**观察**：
 * 元数据不全时返回 refused 并说明缺什么，绝不返回一个“看起来能用”的落子。
 */
export function createShadowAdapter(options: ShadowAdapterOptions): DecisionProvider {
  return {
    id: options.id,
    kind: 'SHADOW',
    label: options.label,
    decide(request: DecisionRequest): DecisionOutcome {
      const validation = validateResumeClaim(options.meta, options.claim);
      if (!validation.ok) {
        return {
          kind: 'refused',
          reason: options.claim === 'EXACT_RESUME' ? 'MISSING_FIELDS_FOR_EXACT_RESUME' : 'MISSING_WEIGHTS',
          missing: validation.missing.map(String),
          providerId: options.id,
        };
      }
      if (!options.decideWith) {
        return { kind: 'refused', reason: 'ADAPTER_NOT_CONNECTED', missing: [], providerId: options.id };
      }
      return { kind: 'decided', decision: options.decideWith(request), providerId: options.id };
    },
  };
}

export interface ProviderFlags {
  /** 默认 false：规格 6.3 要求 Invitus 只在禁用 flag 的 shadow 形态下接入。 */
  invitusShadow?: boolean;
}

export interface ResolvedProviders {
  mover: DecisionProvider;
  shadow: DecisionProvider | null;
  shadowMode: 'OFF' | 'OBSERVE_ONLY';
  policy: string;
}

export function resolveProvider(flags: ProviderFlags, shadow?: DecisionProvider | null): ResolvedProviders {
  const mover = createProductionProvider();
  const enabled = flags.invitusShadow === true;
  if (!enabled || !shadow) {
    return {
      mover,
      shadow: null,
      shadowMode: 'OFF',
      policy: '生产决策只来自五档 AI；shadow provider 未启用（SRSZQ_INVITUS_SHADOW 默认关闭）。',
    };
  }
  return {
    mover,
    shadow,
    shadowMode: 'OBSERVE_ONLY',
    policy: 'shadow provider 只做观察记录：它的决策不会成为落子、不会影响胜负、合法性或评分。',
  };
}

export interface ResolvedMove {
  /** 真正会被应用的落子 —— 只可能来自 mover。 */
  move: AIDecision | null;
  providerId: string;
  telemetry: {
    shadowProviderId: string | null;
    shadowOutcome: 'OFF' | 'DECIDED' | 'REFUSED' | 'AGREES' | 'DIFFERS';
    shadowDetail: string;
  };
}

/**
 * 一次决策的完整解析。返回结构里 `move` 只能来自 mover，
 * shadow 的结果只落在 telemetry —— 这样“shadow 不得影响对局”是编译期保证，而不是靠约定。
 */
export function resolveMove(resolved: ResolvedProviders, request: DecisionRequest): ResolvedMove {
  const outcome = resolved.mover.decide(request);
  const move = outcome.kind === 'decided' ? outcome.decision : null;
  let shadowOutcome: ResolvedMove['telemetry']['shadowOutcome'] = 'OFF';
  let shadowDetail = resolved.shadowMode === 'OFF' ? '未启用' : '';

  if (resolved.shadow) {
    const shadowResult = resolved.shadow.decide(request);
    if (shadowResult.kind === 'refused') {
      shadowOutcome = 'REFUSED';
      shadowDetail = shadowResult.reason + (shadowResult.missing.length ? '（缺 ' + shadowResult.missing.join(', ') + '）' : '');
    } else if (move && shadowResult.decision.row === move.row && shadowResult.decision.col === move.col) {
      shadowOutcome = 'AGREES';
      shadowDetail = '与生产决策一致';
    } else {
      shadowOutcome = 'DIFFERS';
      shadowDetail = '与生产决策不同（仅记录，不采用）';
    }
  }

  return {
    move,
    providerId: resolved.mover.id,
    telemetry: {
      shadowProviderId: resolved.shadow?.id ?? null,
      shadowOutcome,
      shadowDetail,
    },
  };
}

/** 分析 provider：复用精确一步事实（不产生搜索估计，与 Phase A 口径一致）。 */
export function createExactAnalysisProvider(): AnalysisProvider {
  return {
    id: 'analysis-exact-one-ply',
    kind: 'PRODUCTION',
    label: '精确一步分析（无搜索估计）',
    analyze(request: AnalysisRequest) {
      if (request.state.status !== 'playing') return { ok: false, reason: 'GAME_NOT_PLAYING' };
      return {
        ok: true,
        evidence: {
          legalMoves: request.legalMoves.length,
          turnIndex: request.state.turnIndex,
          note: '只给精确一步事实：本 provider 不输出胜率或搜索估计。',
        },
      };
    },
  };
}

/** 供模型卡引用的现状说明（不美化）。 */
export function describeProviderStatus(flags: ProviderFlags): string[] {
  return [
    '生产决策：现有五档 AI（production-five-levels），由共享引擎复核落子合法性。',
    'Invitus：未接入。' + (flags.invitusShadow === true ? '当前 shadow flag 为开，但仅观察。' : 'SRSZQ_INVITUS_SHADOW 默认关闭，shadow provider 不会被调用。'),
    '分析：只用精确一步事实（analysis-exact-one-ply），不产生搜索估计或胜率。',
    '本仓库未训练任何模型；不存在可声明的训练完成度。',
  ];
}

/** 便于测试与脚本构造一个空局面。 */
export function emptyState(boardSize: 13 | 17 = 13): GameState {
  return createInitialState(boardSize);
}
