/** 密码哈希与会话令牌（node:crypto，无外部依赖） */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('hex');
}

export function makeSalt(): string {
  return randomBytes(16).toString('hex');
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 简单校验：最少 6 位 */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 6) return '密码至少 6 位';
  return null;
}

export function validateEmail(email: string): string | null {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确';
  return null;
}

export function validateUsername(username: string): string | null {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/.test(username)) {
    return '用户名需 2-16 位（字母/数字/下划线/中文）';
  }
  return null;
}

export function createSessionToken(): string {
  return randomUUID() + randomBytes(24).toString('hex');
}

export function sessionExpiry(): number {
  return Date.now() + SESSION_TTL_MS;
}

/** 头像：基于用户名生成稳定颜色圆点 SVG data URI */
export function avatarFor(username: string): string {
  const hue = (createHash('sha1').update(username).digest()[0] % 360).toString();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="hsl(${hue},60%,45%)"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="#fff" font-family="sans-serif">${(username[0] ?? '?').toUpperCase()}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
