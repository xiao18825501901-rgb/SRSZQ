import type { Player, Schedule } from './types';

/**
 * 计算指定 Round 的胜权（Eligible）玩家。
 *
 * 规则核心：
 * - Round 1–3：没有任何玩家拥有胜权（返回 null）。
 * - Round >= 4：按所选资格顺序循环。
 *
 * CBA   : cycle = [C, B, A]      eligible = cycle[(round - 4) % 3]
 * CBACC : cycle = [C, B, A, C, C] eligible = cycle[(round - 4) % 5]
 * BAC   : cycle = [B, A, C]      eligible = cycle[(round - 4) % 3]
 *
 * 注意 CBACC 的周期边界会出现连续三个 C 胜权轮（R7=C, R8=C, R9=C），这不是 Bug。
 */
export function getEligiblePlayer(round: number, schedule: Schedule): Player | null {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`invalid round: ${round}`);
  }
  if (round < 4) return null;
  const cycles: Record<Schedule, Player[]> = {
    CBA: ['C', 'B', 'A'],
    CBACC: ['C', 'B', 'A', 'C', 'C'],
    BAC: ['B', 'A', 'C'],
  };
  const cycle = cycles[schedule];
  return cycle[(round - 4) % cycle.length];
}

/** 由全局回合序号（0-based）计算 Round（1-based）：floor(turn/3)+1 */
export function roundFromTurn(turnIndex: number): number {
  return Math.floor(turnIndex / 3) + 1;
}

/** 由全局回合序号（0-based）计算当前玩家：0→A, 1→B, 2→C */
export function playerFromTurn(turnIndex: number): Player {
  return (['A', 'B', 'C'] as Player[])[turnIndex % 3];
}

/** 输出类似 "CBA: C,B,A 循环" 的说明文字 */
export function scheduleCycle(schedule: Schedule): Player[] {
  const cycles: Record<Schedule, Player[]> = {
    CBA: ['C', 'B', 'A'],
    CBACC: ['C', 'B', 'A', 'C', 'C'],
    BAC: ['B', 'A', 'C'],
  };
  return cycles[schedule];
}
