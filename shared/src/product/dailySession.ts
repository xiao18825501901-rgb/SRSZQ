/**
 * 每日训练 Session（本轮新增）：每天最多 20 道**已验证**题的固定顺序。
 *
 * 纪律：
 *  - 只用通过验证的正式题（status=PUBLISHED 且答案集完整）；PENDING/未验证一律不进来凑数；
 *  - 顺序在当天创建后**固定**：以 (userId, dailyKey) 为种子做确定性洗牌，刷新/重登不会重新随机；
 *  - 题型尽量均衡（按题型轮转），同一 session 内排除重复局面（stateDigest+题型 去重）；
 *  - 上限 20 是 upper bound；当天不足 N 道就 total=N。
 *
 * 纯函数、零 IO：选择逻辑可单测，服务器只负责把它落库。
 */
import type { Puzzle } from './puzzleBank.js';

/** 每天的训练题上限（upper bound，不是目标值）。 */
export const DAILY_SESSION_MAX = 20;

/** 确定性 PRNG（mulberry32）+ 字符串散列（FNV-1a）：同样的种子必须给出同样的顺序。 */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 只有这类题才允许进每日训练：正式发布 + 答案集已证明。 */
export function isVerifiedPuzzle(p: Puzzle): boolean {
  return p.status === 'PUBLISHED' && p.answerSetComplete === true;
}

/** 同一 session 内的“重复局面”口径：局面摘要 + 题型。 */
export function sessionDedupeKey(p: Puzzle): string {
  return p.stateDigest + '|' + p.acceptanceType;
}

export interface DailySelection {
  puzzleIds: string[];
  total: number;
  /** 可供选择的已验证题总量（用于如实报告“今天为什么不是 20 道”）。 */
  verifiedAvailable: number;
}

/**
 * 选出 (userId, dailyKey) 当天的训练题序列。
 *
 * 步骤：
 *  1. 过滤：只要已验证题；
 *  2. 去重：按 sessionDedupeKey 去掉同局面同题型；
 *  3. 轮转：按题型分组后轮流取（题型均衡），组内顺序由种子决定；
 *  4. 截断：最多 DAILY_SESSION_MAX 道。
 */
export function buildDailySession(input: {
  puzzles: readonly Puzzle[];
  userId: string;
  dailyKey: string;
  max?: number;
}): DailySelection {
  const max = Math.max(1, Math.min(input.max ?? DAILY_SESSION_MAX, DAILY_SESSION_MAX));
  const verified = input.puzzles.filter(isVerifiedPuzzle);
  const rnd = mulberry32(hashSeed(input.userId + '@' + input.dailyKey));
  const seen = new Set<string>();
  const byType = new Map<string, Puzzle[]>();
  // 先按种子打乱，保证同一题型内部的顺序也是确定但非字典序的
  const shuffled = [...verified].sort(() => rnd() - 0.5);
  for (const p of shuffled) {
    const key = sessionDedupeKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byType.get(p.acceptanceType) ?? [];
    list.push(p);
    byType.set(p.acceptanceType, list);
  }
  const groups = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, list]) => list);
  const picked: string[] = [];
  let round = 0;
  while (picked.length < max) {
    let progressed = false;
    for (const group of groups) {
      if (round < group.length) {
        picked.push(group[round].puzzleId);
        progressed = true;
        if (picked.length >= max) break;
      }
    }
    if (!progressed) break;
    round += 1;
  }
  return { puzzleIds: picked, total: picked.length, verifiedAvailable: new Set(verified.map(sessionDedupeKey)).size };
}

/** 今日键（服务器时区口径与既有 dayKey 一致）。 */
export function isValidDailyKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}
