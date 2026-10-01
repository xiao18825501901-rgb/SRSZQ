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

/**
 * WebSocket 关闭码：这条连接被**同一账号的更新连接**替换（多标签/刷新）。
 * 客户端收到它时不得自动重连——否则两个标签页会互相顶号、无限抖动。
 */
export const WS_CLOSE_REPLACED = 4000;

/* ---- S04：WebSocket 一次性认证票据 ---------------------------------- */

/**
 * 票据有效期（毫秒）。规格 S04：30 秒过期、**单次**消费、重复消费必须拒绝。
 * 票据换来的是一次握手资格，不是会话：拿到它也不能在 30 秒后继续用。
 */
export const WS_TICKET_TTL_MS = 30_000;

/**
 * 票据通过 **WebSocket 子协议头**（Sec-WebSocket-Protocol）传递，而不是查询串。
 *
 * 为什么不用 `?ticket=`：规格要求「session/ticket 不出现在 URL 或日志」。
 * URL 会进反向代理访问日志、浏览器历史、Referer；子协议头不会。
 * 票据本身 30 秒过期且只能消费一次，即使被中间设备记录，价值也极低。
 */
export const WS_TICKET_PROTOCOL_PREFIX = 'srszq.ticket.';

/** 从客户端声明的子协议头里取出票据（没有就返回空串）。 */
export function ticketFromProtocolHeader(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v.startsWith(WS_TICKET_PROTOCOL_PREFIX)) {
      const ticket = v.slice(WS_TICKET_PROTOCOL_PREFIX.length).trim();
      // 只接受十六进制票据（服务端签发的形状），避免把任意字符串当票据塞进查表。
      if (/^[0-9a-f]{32,128}$/.test(ticket)) return ticket;
    }
  }
  return '';
}

/** 规则集版本：唯一规则真源（shared/game）的语义标识。 */
export const RULESET_VERSION = 'formal-rules-v2';

/** 本批次发布标识，仅用于把证据绑定到一次具体构建。 */
export const RELEASE_ID = 'p4b-20260930';

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
