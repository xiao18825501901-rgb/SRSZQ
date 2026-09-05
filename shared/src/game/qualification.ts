import type { GameState, Player } from './types';
import { getEligiblePlayer, roundFromTurn } from './eligibility';

/**
 * BAC 资格时间线视图 —— 唯一数据源（后端 WS payload 与本地/人机页面共用）：
 * 规则仍来自 eligibility.getEligiblePlayer（R1–5 = NONE；R6 起 C→B→A 循环），
 * 本模块只负责“取窗口”，绝不重复实现资格规则。
 */

export interface QualificationEntry {
  round: number;
  player: Player | null; // R1-5 恒为 null（无人拥有胜权）
}

export interface QualificationView {
  currentRound: number;
  currentEligible: Player | null;
  /** 当前轮之后的连续窗口（默认 8 轮） */
  upcoming: QualificationEntry[];
}

/** 时间线未来窗口长度：Current Round + 未来 8 轮（避免 UI 过长；数据层可扩展） */
export const QUALIFICATION_LOOKAHEAD = 8;

/** 由当前 Round 构建资格时间线视图（lookahead 可扩展） */
export function qualificationOf(currentRound: number, lookahead: number = QUALIFICATION_LOOKAHEAD): QualificationView {
  const upcoming: QualificationEntry[] = [];
  for (let r = currentRound + 1; r <= currentRound + lookahead; r++) {
    upcoming.push({ round: r, player: getEligiblePlayer(r) });
  }
  return { currentRound, currentEligible: getEligiblePlayer(currentRound), upcoming };
}

/** 由棋局状态构建（后端 WS 广播 / 本地引擎页共用） */
export function qualificationFromState(state: GameState, lookahead?: number): QualificationView {
  return qualificationOf(roundFromTurn(state.turnIndex), lookahead);
}

/** currentRound 之后第一个有人获权的轮次（R1-5 期间给玩家的“下次胜权窗口”提示） */
export function nextEligibleRoundAfter(currentRound: number): QualificationEntry | null {
  for (let r = currentRound + 1; r <= currentRound + QUALIFICATION_LOOKAHEAD; r++) {
    const p = getEligiblePlayer(r);
    if (p) return { round: r, player: p };
  }
  return null;
}
