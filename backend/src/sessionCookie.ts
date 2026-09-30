/**
 * 增量 C：会话 Cookie（HttpOnly）。
 *
 * 为什么单独一个模块：一键账号的会话同时被 HTTP API 与 WebSocket 升级用到，
 * 两处必须用**同一份**解析与安全属性判定，否则很容易一边加了 Secure、另一边漏了。
 */
import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'srszq_sid';

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

/** 只有确定是 https 时才加 Secure —— 本地 http 调试加 Secure 浏览器会直接丢弃这个 cookie。 */
export function requestIsHttps(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function sessionCookieHeader(req: IncomingMessage, token: string, ttlMs: number): string {
  const parts = [
    SESSION_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    // srszq.com 与 api.srszq.com 属同一 site，Lax 足够且不引入跨站 cookie 的额外风险。
    'SameSite=Lax',
    'Max-Age=' + String(Math.floor(ttlMs / 1000)),
  ];
  if (requestIsHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookieHeader(): string {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/** 从请求里取会话令牌：Bearer（老流程）优先，其次 HttpOnly cookie（一键账号流程）。 */
export function sessionTokenFrom(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  return bearer || (parseCookies(req)[SESSION_COOKIE] ?? '');
}
