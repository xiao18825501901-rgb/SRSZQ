import { tx } from "../i18n/core";
/**
 * 每日一题的胜权时间线 —— 页面侧纯模型层（无 React/DOM 依赖，单测可直接跑）。
 *
 * 规则只有一个源：shared/src/game/qualification.ts（它内部只调 eligibility.ts），
 * 与 Online Match 用的是**同一个函数**。本模块不推导任何资格规则，只做两件事：
 *  1. 由当前 GameState 取时间线视图（当前轮 + 未来窗口）；
 *  2. 把视图翻成页面文案（当前 / 下一轮），页面与测试共用同一份文案。
 */
import type { GameState, Player } from '../../../shared/src/game/types';
import { playerName } from '../playerPresentation';
import { nextEligibleRoundAfter, qualificationFromState, type QualificationView } from '../../../shared/src/game/qualification';
/** 时间线视图：直接来自共享资格引擎（Online Match 用的是同一个 qualificationFromState）。 */
export function timelineOf(state: GameState): QualificationView {
    return qualificationFromState(state);
}
export interface PuzzleTimelineCopy {
    current: string;
    next: string;
    round: number;
    eligible: Player | null;
    nextRound: number | null;
    nextPlayer: Player | null;
}
/** 步骤边界：0 = 题目起始局面，total = 当前局面（最新一手）。 */
export function clampStep(step: number, total: number): number {
    if (!Number.isFinite(step))
        return total;
    return Math.max(0, Math.min(Math.round(step), total));
}
/** “当前 / 下一轮”文案：R1–5 无人持权时如实说明，并给出下一次胜权窗口（R6 白棋）。 */
export function timelineCopy(view: QualificationView): PuzzleTimelineCopy {
    const next = view.upcoming[0] ?? null;
    const holder = view.currentEligible;
    const current = holder
        ? tx("当前 \u00B7 Round {p0} \u00B7 {p1}拥有胜权", { p0: view.currentRound, p1: playerName(holder) }) : tx("当前 \u00B7 Round {p0} \u00B7 无人拥有胜权", { p0: view.currentRound });
    let nextText: string;
    if (next && next.player) {
        nextText = tx("下一轮 \u00B7 Round {p0} \u00B7 {p1}", { p0: next.round, p1: playerName(next.player) });
    }
    else if (!holder) {
        const w = nextEligibleRoundAfter(view.currentRound);
        nextText = w && w.player
            ? tx("下一次胜权 \u00B7 Round {p0} \u00B7 {p1}", { p0: w.round, p1: playerName(w.player) }) : tx("下一次胜权 \u00B7 窗口外\uFF08Round {p0} 起\uFF09", { p0: (view.currentRound + 1) });
    }
    else {
        nextText = tx("下一轮 \u00B7 Round {p0} \u00B7 无人拥有胜权", { p0: (next?.round ?? view.currentRound + 1) });
    }
    return {
        current,
        next: nextText,
        round: view.currentRound,
        eligible: holder,
        nextRound: next?.round ?? null,
        nextPlayer: next?.player ?? null,
    };
}
