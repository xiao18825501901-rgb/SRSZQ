/**
 * WebSocket 安全边界（P0C / S05、S06）。
 *
 * 纯函数 + 一个小限流器，零 IO，便于穷举测试：
 *  - Origin 白名单：浏览器来源必须命中白名单；缺 Origin 的按策略决定（原生客户端/测试）。
 *  - 消息体积上限：64KB。超限直接拒绝，不解析。
 *  - 二进制帧：本协议只接受文本 JSON。
 *  - 逐连接滑窗限流：消息/命令速率有界，防止单连接打满事件循环。
 */

/** 单条消息上限（字节）。规格要求 64KB。 */
export const WS_MAX_MESSAGE_BYTES = 64 * 1024;

/** 逐连接命令速率上限：10 秒窗口内 60 条。正常对局远低于此。 */
export const WS_COMMAND_RATE_LIMIT = 60;
export const WS_COMMAND_RATE_WINDOW_MS = 10_000;

export interface OriginDecision {
  allowed: boolean;
  reason: 'ALLOWED_LISTED' | 'ALLOWED_NO_ORIGIN' | 'DENIED_NOT_LISTED';
  origin: string | null;
}

/**
 * 校验 WS 升级请求的 Origin。
 *  - Origin 存在且在白名单 → 允许。
 *  - Origin 存在但不在白名单 → **拒绝**（伪造来源/错序来源）。
 *  - Origin 缺失 → 允许（非浏览器客户端：原生客户端、健康检查、本机测试），
 *    但这只影响来源判定，不影响认证 —— 认证仍必须通过一次性票据。
 */
export function decideWebSocketOrigin(
  origin: string | null | undefined,
  allowedOrigins: ReadonlySet<string>,
): OriginDecision {
  const value = typeof origin === 'string' && origin.length > 0 ? origin : null;
  if (!value) return { allowed: true, reason: 'ALLOWED_NO_ORIGIN', origin: null };
  if (allowedOrigins.has(value)) return { allowed: true, reason: 'ALLOWED_LISTED', origin: value };
  return { allowed: false, reason: 'DENIED_NOT_LISTED', origin: value };
}

export type FrameRejection = 'BINARY_FRAME' | 'TOO_LARGE' | null;

/** 帧级校验：先看是不是二进制，再看体积。两者都不做 JSON 解析。 */
export function rejectFrame(raw: { length: number } | string, isBinary: boolean, maxBytes = WS_MAX_MESSAGE_BYTES): FrameRejection {
  if (isBinary) return 'BINARY_FRAME';
  const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
  if (size > maxBytes) return 'TOO_LARGE';
  return null;
}

/** 逐 key 滑窗限流器（内存态，单实例）。 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number = WS_COMMAND_RATE_LIMIT,
    private readonly windowMs: number = WS_COMMAND_RATE_WINDOW_MS,
  ) {}

  /** 记录一次并返回是否仍在限额内。超限时**不**写入，避免持续滥用把窗口越推越远。 */
  tryTake(key: string, now = Date.now()): boolean {
    const list = this.hits.get(key) ?? [];
    const cutoff = now - this.windowMs;
    while (list.length && list[0] <= cutoff) list.shift();
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  /** 释放某 key 的状态（连接关闭时调用，避免 Map 无限增长）。 */
  forget(key: string): void {
    this.hits.delete(key);
  }

  get trackedKeys(): number {
    return this.hits.size;
  }
}
