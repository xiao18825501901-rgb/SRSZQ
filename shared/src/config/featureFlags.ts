/**
 * SRSZQ 显式功能开关（P0A 新增）。
 *
 * 背景：旧代码库中根本不存在 Rating Beta / Invitus shadow 开关，
 * 因此旧报告只能写“未实现”，不能写“默认关闭”。本模块把开关真实建出来：
 *  - 解析规则严格：只有 '1' / 'true' / 'on' / 'yes'（忽略大小写与空白）才为 true；
 *    其余一切输入（缺失、空串、'0'、'false'、'off'、垃圾值）一律为 false。
 *  - 默认值全部 false：不配置任何环境变量时，行为与历史版本完全一致。
 *  - 纯函数、零 IO：调用方自己决定从 process.env 还是测试夹具取值。
 *
 * 重要：本模块只描述“配置”，不代表任何生产环境已被远程关闭或开启。
 */

/** 受控开关集合 */
export interface FeatureFlags {
  /** 新评分公式 Beta（P1 实现）；false 时使用历史 legacy-online-v1 政策 */
  ratingBeta: boolean;
  /** Invitus 影子运行（研究模型并行评估）；false 时不加载、不参与决策 */
  invitusShadow: boolean;
}

export const FEATURE_FLAG_KEYS = ['ratingBeta', 'invitusShadow'] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/** 每个开关对应的环境变量名（服务端读取；测试可注入任意字典） */
export const FEATURE_FLAG_ENV: Readonly<Record<FeatureFlagKey, string>> = Object.freeze({
  ratingBeta: 'SRSZQ_RATING_BETA',
  invitusShadow: 'SRSZQ_INVITUS_SHADOW',
});

/** 默认值：全关。修改这里等于修改“未配置时的产品行为”，需评审。 */
export const FEATURE_FLAG_DEFAULTS: Readonly<FeatureFlags> = Object.freeze({
  ratingBeta: false,
  invitusShadow: false,
});

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/**
 * 严格布尔解析。任何非白名单输入（含 undefined / null / 数字 / 对象）都返回 false。
 * 不做 trim 以外的任何“智能”推断，避免 'no'、'0.0' 之类被误判为开启。
 */
export function parseBooleanFlag(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** 从环境字典解析全部开关；缺省项回落 FEATURE_FLAG_DEFAULTS。 */
export function parseFeatureFlags(env: Record<string, string | undefined> = {}): FeatureFlags {
  return {
    ratingBeta: parseBooleanFlag(env[FEATURE_FLAG_ENV.ratingBeta]),
    invitusShadow: parseBooleanFlag(env[FEATURE_FLAG_ENV.invitusShadow]),
  };
}

/** 单个开关的可审计证据行：用于证明“实际解析值”，而不是声称。 */
export interface FeatureFlagEvidence {
  key: FeatureFlagKey;
  envVar: string;
  rawValue: string | null;
  parsedValue: boolean;
  isDefault: boolean;
}

/** 生成可写入证据/日志的解析证据（含原始字符串，便于第三方复核）。 */
export function featureFlagEvidence(env: Record<string, string | undefined> = {}): FeatureFlagEvidence[] {
  const flags = parseFeatureFlags(env);
  return FEATURE_FLAG_KEYS.map((key) => {
    const raw = env[FEATURE_FLAG_ENV[key]];
    return {
      key,
      envVar: FEATURE_FLAG_ENV[key],
      rawValue: raw === undefined ? null : String(raw),
      parsedValue: flags[key],
      isDefault: raw === undefined,
    };
  });
}
