/**
 * Online Match 排队策略（增量 B）：真人等待超时的**唯一默认值**。
 *
 * 服务器权威：真正的到期判定在 backend/src/ws/matchmaking.ts（deadline 由服务器计算并广播）。
 * 这里只提供默认值与解析规则，避免前后端各写一个 60000/20000 的魔法数字。
 */

/** 生产默认：真人等待 20 秒。改动这个值必须同时更新本条注释与测试断言。 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 20_000;

/**
 * 解析排队超时：允许 CI 用环境变量缩短（例如 200ms），但默认必须是 20 秒。
 * 非法/非正数一律回落默认值，绝不因为一个错的环境变量把排队窗口变成 0 或负数。
 */
export function resolveQueueTimeoutMs(
  raw?: string | number | null,
  fallback: number = DEFAULT_QUEUE_TIMEOUT_MS,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}
