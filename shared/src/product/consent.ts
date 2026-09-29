/**
 * SRSZQ P3A(B5) —— 训练许可（规格 6.1 / 7.2）。
 *
 * 三条写在代码里的红线：
 *  1. **默认不纳入**：私密真人棋谱必须有当前版本的显式许可才进训练数据集；
 *     没有记录、版本不符、已撤回 —— 三种情况都按“不许”处理。
 *  2. 撤回只阻止**新的纳入**，并且可追踪；规格明写不能承诺已训练模型自动遗忘，
 *     所以这里既不假装遗忘，也不阻止用户撤回。
 *  3. 许可版本是字符串且必须精确匹配：改了版本就等于需要重新取得许可。
 */

export const TRAINING_CONSENT_VERSION = 'train-consent-v1';
export type ConsentKind = 'TRAINING';

export interface ConsentRecord {
  userId: string;
  kind: ConsentKind;
  /** 授予时的版本；撤回后仍保留原版本以便审计。 */
  version: string;
  grantedAt: number;
  revokedAt: number | null;
}

export type ConsentDecision =
  | { allowed: true; version: string }
  | { allowed: false; reason: 'NO_RECORD' | 'REVOKED' | 'VERSION_MISMATCH' };

/** 某个用户的许可是否**此刻**允许其棋谱进入训练数据集。 */
export function decideTrainingConsent(
  record: ConsentRecord | null | undefined,
  requiredVersion: string = TRAINING_CONSENT_VERSION,
): ConsentDecision {
  if (!record) return { allowed: false, reason: 'NO_RECORD' };
  if (record.revokedAt !== null) return { allowed: false, reason: 'REVOKED' };
  if (record.version !== requiredVersion) return { allowed: false, reason: 'VERSION_MISMATCH' };
  return { allowed: true, version: record.version };
}

/**
 * 一局的训练可用性：只要有**任何一位**参与者不允许，这一局就不纳入。
 * 理由：一局里混合了多人的棋谱，不能因为其中一个同意就替其他人做主。
 */
export interface ParticipantConsent { userId: string; decision: ConsentDecision }

export function decideGameTrainingEligibility(
  participantUserIds: string[],
  consentOf: (userId: string) => ConsentDecision,
): { allowed: boolean; blockedBy: Array<{ userId: string; reason: string }>; version: string | null } {
  const blockedBy: Array<{ userId: string; reason: string }> = [];
  let version: string | null = null;
  for (const userId of participantUserIds) {
    const decision = consentOf(userId);
    if (!decision.allowed) blockedBy.push({ userId, reason: decision.reason });
    else version = decision.version;
  }
  return { allowed: blockedBy.length === 0, blockedBy, version };
}

/** 给用户看的说明：撤回的后果必须写清楚，不能含糊。 */
export const TRAINING_CONSENT_NOTICE = {
  title: '把棋谱用于训练',
  grant: '同意后，你的对局棋谱可以进入训练数据集（不含邮箱、IP、会话信息）。',
  revoke: '撤回后立即停止纳入**新**数据集；已经进入历史数据集的样本不会被追回，也无法要求已训练模型遗忘 —— 这一点我们不会含糊其辞。',
  defaultState: '默认不纳入：没有明确同意就不会进训练数据集。',
};