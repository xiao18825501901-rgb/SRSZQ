/**
 * SRSZQ 协议与发布版本（P0B 新增，纯常量，零 IO）。
 *
 * 目的（原验收 O06）：前端的规则/协议版本必须能被独立核查，
 * 版本不兼容时不允许静默继续——宁可拒绝，也不要让旧客户端用一个
 * 它不理解的 revision 语义去下棋。
 *
 *  - PROTOCOL_VERSION 变更 = 线协议不兼容（消息字段/语义变了）
 *  - RULESET_VERSION    变更 = 规则语义变了（会改变棋局结果）
 *  - RELEASE_ID         仅用于证据绑定，不参与兼容判断
 */

/** 线协议版本。P0B 引入 commandId/expectedRevision/revision/ACK 信封，故升为 2。 */
export const PROTOCOL_VERSION = 2;

/** 规则集版本：唯一规则真源（shared/game）的语义标识。 */
export const RULESET_VERSION = 'formal-rules-v2';

/** 本批次发布标识，仅用于把证据绑定到一次具体构建。 */
export const RELEASE_ID = 'p2-20260930';

/** 服务端在 hello / game.start 中下发的版本三元组。 */
export interface ProtocolInfo {
  protocolVersion: number;
  rulesetVersion: string;
  releaseId: string;
}

export const PROTOCOL_INFO: Readonly<ProtocolInfo> = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  rulesetVersion: RULESET_VERSION,
  releaseId: RELEASE_ID,
});

/** 客户端/服务端版本兼容判定：协议版本必须完全一致，规则集版本必须一致。 */
export function isProtocolCompatible(info: Partial<ProtocolInfo> | null | undefined): boolean {
  if (!info) return false;
  return info.protocolVersion === PROTOCOL_VERSION && info.rulesetVersion === RULESET_VERSION;
}

/** 命令被拒绝时的稳定错误码（客户端据此区分“重试”与“放弃”）。 */
export const COMMAND_ERRORS = Object.freeze({
  /** 缺少 commandId / expectedRevision */
  BAD_ENVELOPE: 'BAD_ENVELOPE',
  /** expectedRevision 与房间当前 revision 不一致：命令基于旧状态，必须丢弃 */
  STALE_REVISION: 'STALE_REVISION',
  /** 同一 commandId 但 payload 不同：拒绝，绝不覆盖已生效的命令 */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** 协议版本不兼容 */
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  /** 对局处于恢复暂停态，暂不接受落子 */
  RECOVERY_PAUSED: 'RECOVERY_PAUSED',
} as const);

export type CommandErrorCode = (typeof COMMAND_ERRORS)[keyof typeof COMMAND_ERRORS];

/** 稳定 payload 摘要：用于判断“同一 commandId 的 payload 是否相同”。 */
export function commandPayloadDigest(payload: unknown): string {
  const text = JSON.stringify(payload ?? null);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
