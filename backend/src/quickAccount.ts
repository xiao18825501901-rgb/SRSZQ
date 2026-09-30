/**
 * 一键账号（增量 C）：临时账号的命名、占位邮箱与限流常量。
 *
 * 三条纪律：
 *  1. 唯一性由数据库唯一约束兜底，这里只做“生成 + 冲突重试”，不做账号池；
 *  2. 随机昵称必须能通过**既有** validateUsername（不另造一套用户名校验）；
 *  3. 随机数一律 node:crypto，不用 Math.random。
 */
import { randomInt, randomUUID } from 'node:crypto';
import { validateUsername } from './auth.js';

/** 昵称词库：都是 2 个汉字，拼出来的名字落在 2–16 位之间且不需要额外校验规则。 */
const ADJECTIVES = [
  '青松', '白鹭', '长风', '远山', '流云', '寒星', '细雨', '朗月', '疏影', '惊鸿',
  '松风', '竹影', '沧海', '孤舟', '暮雪', '朝露', '静水', '微光', '磐石', '飞鸟',
];
const NOUNS = [
  '棋人', '棋士', '棋客', '闲人', '过客', '行客', '看山', '听雨', '执子', '观棋',
  '归人', '点灯', '煮茶', '扫地', '读书', '远行', '扶摇', '守拙', '知白', '守黑',
];

/** 生成一个唯一随机昵称（形如 `棋友青松4821`）。数据库还有唯一约束，这里只是先挑一个能用的。 */
export function makeProvisionalUsername(isTaken: (name: string) => boolean, attempts = 32): string {
  for (let i = 0; i < attempts; i += 1) {
    const name = '棋友' + ADJECTIVES[randomInt(0, ADJECTIVES.length)] + NOUNS[randomInt(0, NOUNS.length)] + String(randomInt(1000, 10_000));
    // 必须过既有校验：长度/字符集都不另立标准。
    if (validateUsername(name) === null && !isTaken(name)) return name;
  }
  // 极端情况下（词库 + 4 位数字都被占）退化为更高熵的形态，仍然满足既有校验。
  for (let i = 0; i < attempts; i += 1) {
    const name = '棋友' + String(randomInt(100_000, 1_000_000)) + String(randomInt(100_000, 1_000_000));
    if (validateUsername(name) === null && !isTaken(name)) return name;
  }
  throw new Error('无法生成唯一临时昵称');
}

/**
 * 临时账号的占位邮箱：users.email 是 NOT NULL UNIQUE，但临时账号**不要求**用户填邮箱。
 * 用 RFC 2606 保留域 + 用户 id，保证唯一、不可投递、且一眼能看出不是真实邮箱。
 */
export const PROVISIONAL_EMAIL_DOMAIN = 'provisional.invalid';
/** 生成一个唯一的占位邮箱（自带随机 UUID，不依赖用户 id）。 */
export function provisionalPlaceholderEmail(): string {
  return 'p-' + randomUUID() + '@' + PROVISIONAL_EMAIL_DOMAIN;
}
export function isProvisionalEmail(email: string): boolean {
  return email.endsWith('@' + PROVISIONAL_EMAIL_DOMAIN);
}

/** 一键建号的限流：单 IP 滑动窗口。够用即可，不因为校园网共用出口就永久封禁。 */
export const QUICK_START_RATE_LIMIT = 12;
export const QUICK_START_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 允许用环境变量覆盖限流阈值（测试要能验证限流本身，也要能不被限流挡住其它用例）。
 * 非法值一律回落默认值。
 */
export function resolveQuickStartRateLimit(raw?: string | number | null): number {
  if (raw === undefined || raw === null || raw === '') return QUICK_START_RATE_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return QUICK_START_RATE_LIMIT;
  return Math.round(n);
}

/** 闲置临时账号清理队列的门槛：30 天没有任何活动。 */
export const PROVISIONAL_IDLE_MS = 30 * 24 * 3600 * 1000;
