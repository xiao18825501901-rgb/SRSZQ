/**
 * 账号来源判定（规格 4.1：合成/测试/演示账号不进公开排行榜，也不能冒充真人）。
 *
 * 为什么把判定做进注册流程：之前“哪些是测试账号”靠事后手工改库，
 * 于是在真实环境上出现了一个真实缺口 —— 自动验收注册的账号默认是 HUMAN，
 * 它们打的局在分享/排行榜里看起来与真人无异。规则化之后就不需要谁来记得改库。
 *
 * 判定依据（都是客户端无法从中获益的标记：把自己标成 TEST 只会退出排行榜）：
 *  1. example.invalid / example.com 等 RFC 2606 保留域 —— 永远不可能属于真人；
 *  2. 环境变量 SRSZQ_TEST_ACCOUNT_PATTERN 命中的用户名前缀（默认 ^dsh）。
 */
/** 账号来源。只有 HUMAN 参与公开排行榜与竞技分（规格 4.1）。 */
export type AccountSource = 'HUMAN' | 'SYNTHETIC' | 'TEST' | 'ADMIN_DEMO';

export const ACCOUNT_SOURCES: readonly AccountSource[] = ['HUMAN', 'SYNTHETIC', 'TEST', 'ADMIN_DEMO'];

export const RESERVED_EMAIL_DOMAINS = ['example.invalid', 'example.com', 'example.net', 'example.org', 'localhost', 'test.invalid'];

export const DEFAULT_TEST_USERNAME_PATTERN = '^dsh';

export function isReservedExampleEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return RESERVED_EMAIL_DOMAINS.includes(domain) || domain.endsWith('.invalid');
}

export function matchesTestUsername(username: string, pattern: string = DEFAULT_TEST_USERNAME_PATTERN): boolean {
  try {
    return new RegExp(pattern, 'i').test(username);
  } catch {
    // 配置写错时不能把真人误判成测试账号：退回“不匹配”。
    return false;
  }
}

/** 注册时决定账号来源。默认 HUMAN；只有明确命中保留域/配置前缀才归为 TEST。 */
export function classifyAccountSource(
  email: string,
  username: string,
  env: { SRSZQ_TEST_ACCOUNT_PATTERN?: string } = {},
): AccountSource {
  if (isReservedExampleEmail(email)) return 'TEST';
  const pattern = env.SRSZQ_TEST_ACCOUNT_PATTERN ?? DEFAULT_TEST_USERNAME_PATTERN;
  if (pattern && matchesTestUsername(username, pattern)) return 'TEST';
  return 'HUMAN';
}
