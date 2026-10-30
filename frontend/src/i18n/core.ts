/** Presentation-only internationalization. No route, network, auth or game writes. */
import { EN } from './messages';

export type Locale = 'zh-CN' | 'en';
export type MessageArgs = Readonly<Record<string, string | number | boolean | null | undefined>>;
export const LOCALE_KEY = 'srszq.locale.v1';
export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en'];

export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== 'string') return null;
  if (/^zh(?:-|$)/i.test(value)) return 'zh-CN';
  if (/^en(?:-|$)/i.test(value)) return 'en';
  return null;
}
export function detectLocale(saved: unknown, languages: readonly string[] = []): Locale {
  const explicit = normalizeLocale(saved);
  if (explicit) return explicit;
  for (const language of languages) {
    const supported = normalizeLocale(language);
    if (supported) return supported;
  }
  return 'zh-CN';
}
function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-CN';
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(LOCALE_KEY); } catch { /* Storage can be denied. */ }
  return detectLocale(saved, typeof navigator === 'undefined' ? [] : navigator.languages);
}
let locale: Locale = initialLocale();
const listeners = new Set<() => void>();
export const getLocale = (): Locale => locale;
export const getServerLocale = (): Locale => 'zh-CN';
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function syncDocumentLanguage(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = 'ltr';
  document.documentElement.dataset.locale = locale;
  document.title = locale === 'en' ? 'SRSZQ · Three-Player Four-in-a-Row' : '三人四子棋';
}
export function setLocale(next: Locale, persist = true): void {
  if (!SUPPORTED_LOCALES.includes(next)) return;
  if (persist && typeof window !== 'undefined') {
    try { window.localStorage.setItem(LOCALE_KEY, next); } catch { /* In-memory switch still works. */ }
  }
  if (next === locale) { syncDocumentLanguage(); return; }
  locale = next;
  syncDocumentLanguage();
  for (const listener of [...listeners]) listener();
}
// Explicitly one listener per module. It neither attaches sockets nor changes game deadlines.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_KEY) return;
    const next = normalizeLocale(event.newValue);
    if (next) setLocale(next, false);
  });
  syncDocumentLanguage();
}

/** Curated source-message catalog. Never translates user names or edits DOM text. */
export function translate(source: string, args: MessageArgs = {}, language: Locale = locale): string {
  const template = language === 'en' ? (EN[source as keyof typeof EN] ?? source) : source;
  return template.replace(/\{(p\d+|[a-zA-Z][\w]*)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(args, key) ? String(args[key] ?? '') : whole,
  );
}
export const tx = translate;

const MESSAGE_PREFIX = '\uE000srszq-i18n:';
/** Local UI notices keep descriptors, not text fixed to the old language. Never send to APIs. */
export function encodeMessage(source: string, args: MessageArgs = {}): string {
  return MESSAGE_PREFIX + JSON.stringify({ source, args });
}
export function messageText(value: string | null | undefined): string {
  if (!value) return '';
  if (!value.startsWith(MESSAGE_PREFIX)) return tx(value);
  try {
    const parsed: unknown = JSON.parse(value.slice(MESSAGE_PREFIX.length));
    if (!parsed || typeof parsed !== 'object' || !('source' in parsed) || typeof parsed.source !== 'string') return tx('操作失败，请重试。');
    const args = 'args' in parsed && parsed.args && typeof parsed.args === 'object' ? parsed.args as MessageArgs : {};
    return tx(parsed.source, args);
  } catch { return tx('操作失败，请重试。'); }
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}
export function formatPercent(value: number): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
}
export function formatDateTime(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export function errorText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  if (!text) return '';
  if (text.startsWith(MESSAGE_PREFIX)) return messageText(text);
  if (Object.prototype.hasOwnProperty.call(EN, text)) return tx(text);
  const matchers: readonly [RegExp, string][] = [
    [/CURRENT_PUZZLE_NOT_SOLVED/i, '先答对当前这道题，才能进入下一题。'],
    [/STALE_INDEX|REVISION_MISMATCH/i, '进度已更新，请重试。'],
    [/Failed to fetch|NetworkError|load failed|WebSocket|network/i, '网络连接中断，请重试。'],
    [/HTTP 401|unauthorized|session.*expired|unauthenticated/i, '登录状态已过期，请重新登录后再试。'],
    [/HTTP 403|forbidden|not allowed|permission/i, '你没有执行此操作的权限。'],
    [/HTTP 404|not found/i, '内容不存在或已更新，请重新加载。'],
    [/HTTP 410|revoked|expired share/i, '这个分享链接已经失效。'],
    [/HTTP 429|rate.limit|too many/i, '操作太频繁，请稍后再试。'],
    [/username.*(?:taken|exists)|already.*(?:exists|taken)|用户名.*(?:占用|存在)/i, '这个名字已被使用，请换一个。'],
    [/invalid.*credentials|wrong.*password|密码.*错误/i, '用户名或密码不正确。'],
    [/HTTP 5\d\d/i, '服务暂时不可用，请稍后重试。'],
  ];
  for (const [pattern, source] of matchers) if (pattern.test(text)) return tx(source);
  // Existing Chinese copy remains available in zh; English never receives untranslated internals.
  return locale === 'zh-CN' && /[㐀-鿿]/.test(text) ? text : tx('操作失败，请重试。');
}
export function colorLabel(seat: string | null | undefined, full = true): string {
  const source = seat === 'A' ? (full ? '红棋' : '红') : seat === 'B' ? (full ? '绿棋' : '绿') : seat === 'C' ? (full ? '白棋' : '白') : '无';
  return tx(source);
}
