import type { Player } from '../game/types';
import { PLAYERS } from '../game/types';
import { AI_LEVELS, type AILevel } from './types';

/**
 * SRSZQ 随机分配工具（seat / AI difficulty）。
 *
 * 设计约定：
 * - 随机只发生在 session / match initialization；调用方把结果固化为 immutable state，
 *   不得在 React render / rerender / selector / polling / WS 更新中重复调用。
 * - 生产使用普通随机源（Math.random）；测试注入 deterministic RNG。
 * - 这里只是“抽取/洗牌”，绝不复制或改写规则与 AI agent 实现。
 */

export type Rng = () => number; // 期望返回 [0,1)

export const defaultRng: Rng = () => Math.random();

export function pickUniform<T>(arr: readonly T[], rand: Rng = defaultRng): T {
  const n = arr.length;
  if (n === 0) throw new Error('pickUniform: empty array');
  const idx = Math.min(n - 1, Math.max(0, Math.floor(rand() * n)));
  return arr[idx];
}

/** Fisher–Yates，返回新数组（不修改入参） */
export function shuffled<T>(arr: readonly T[], rand: Rng = defaultRng): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(rand() * (i + 1))));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 教程真人座位：A/B/C 均匀随机（约 1/3 各） */
export function tutorialHumanSeat(rand: Rng = defaultRng): Player {
  return pickUniform(PLAYERS, rand);
}

/** 教程单个 AI 难度：真实 registry 全档均匀随机（1★–5★），独立可重复 */
export function tutorialAiLevel(rand: Rng = defaultRng): AILevel {
  return pickUniform(AI_LEVELS, rand);
}

/** Online Match 系统 AI 补位难度：仅 4★(3ply) / 5★(maxn)，独立随机，不全部固定 5★ */
export function onlineAiFillLevel(rand: Rng = defaultRng): AILevel {
  return pickUniform<AILevel>(['3ply', 'maxn'], rand);
}
