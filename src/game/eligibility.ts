import type { Player } from './types';
import { ELIGIBLE_ORDER, ELIGIBLE_START_ROUND } from './types';

/**
 * SRSZQ.com 正式资格规则 v2：
 * - Round 1–5：没有任何玩家拥有胜权（返回 null）；
 * - Round ≥ 6：按 C → B → A 循环 —— R6=C, R7=B, R8=A, R9=C, …
 */
export function getEligiblePlayer(round: number): Player | null {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`invalid round: ${round}`);
  }
  if (round < ELIGIBLE_START_ROUND) return null;
  return ELIGIBLE_ORDER[(round - ELIGIBLE_START_ROUND) % ELIGIBLE_ORDER.length];
}

/** 由全局回合序号（0-based）计算 Round（1-based）：floor(turn/3)+1 */
export function roundFromTurn(turnIndex: number): number {
  return Math.floor(turnIndex / 3) + 1;
}

/** 由全局回合序号（0-based）计算当前玩家：0→A, 1→B, 2→C */
export function playerFromTurn(turnIndex: number): Player {
  return (['A', 'B', 'C'] as Player[])[turnIndex % 3];
}

/** 某玩家在正式规则下的首次获权轮（用于 R1-5 无资格期）：C@R6、B@R7、A@R8 */
export function firstEligibleRound(player: Player): number {
  const index = ELIGIBLE_ORDER.indexOf(player); // C→0, B→1, A→2
  return ELIGIBLE_START_ROUND + index;
}
