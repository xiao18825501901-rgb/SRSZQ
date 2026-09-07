/** BAC 资格时间线 —— 前端纯模型层（无 React 依赖，便于单元测试）。
 *  时间线视图一律来自共享引擎 qualification 模块（服务器 payload 或本地引擎页），
 *  前端绝不自行推导资格规则。 */
import type { GameState, Player } from '../../../shared/src/game/types';
import {
  nextEligibleRoundAfter,
  qualificationFromState,
  type QualificationView,
} from '../../../shared/src/game/qualification';

export interface SeatLite {
  kind: 'human' | 'ai';
  username?: string;
  stars?: number;
}

export interface TimelineRow {
  round: number;
  player: Player | null;
  isNow: boolean;
  isNext: boolean;
}

/** 解析视图：优先服务器 payload；本地/人机模式由共享引擎从 state 生成（同一规则源） */
export function resolveView(qualification: QualificationView | null | undefined, state?: GameState | null): QualificationView | null {
  if (qualification) return qualification;
  return state ? qualificationFromState(state) : null;
}

/** payload → 渲染行：当前轮（NOW）+ 未来窗口（NEXT…） */
export function rowsFromView(view: QualificationView): TimelineRow[] {
  const rows: TimelineRow[] = [
    { round: view.currentRound, player: view.currentEligible, isNow: true, isNext: false },
  ];
  view.upcoming.forEach((e, i) => {
    rows.push({ round: e.round, player: e.player, isNow: false, isNext: i === 0 });
  });
  return rows;
}

/** 当前轮之后下一次出现胜权的窗口（R1-5 展示用） */
export function nextWindowHint(view: QualificationView): { round: number; player: Player } | null {
  const e = nextEligibleRoundAfter(view.currentRound);
  return e && e.player ? { round: e.round, player: e.player } : null;
}

/** 当前轮起，指定座位最近一次胜权；只消费服务器/共享引擎提供的时间线窗口。 */
export function nextVictoryFor(view: QualificationView, seat: Player | null | undefined): { round: number; player: Player } | null {
  if (!seat) return null;
  const entry = [
    { round: view.currentRound, player: view.currentEligible },
    ...view.upcoming,
  ].find((item) => item.player === seat);
  return entry?.player ? { round: entry.round, player: entry.player } : null;
}

/** 座位显示名：你 / 真人用户名 / AI ★ */
export function seatName(seat: Player, seats?: Record<Player, SeatLite> | null, mySeat?: Player | null): string {
  if (mySeat === seat) return 'You';
  const s = seats?.[seat];
  if (!s) return `Player ${seat}`;
  if (s.kind === 'ai') return `AI ${'★'.repeat(Math.min(5, Math.max(1, s.stars ?? 1)))}`;
  return s.username ? `Player ${seat} · ${s.username}` : `Player ${seat}`;
}

/** 玩家视角文案：当前谁持有胜权（YOUR VICTORY WINDOW / 防守提示） */
export function perspectiveLines(
  mySeat: Player | null | undefined,
  eligible: Player | null,
  seats?: Record<Player, SeatLite> | null,
): { en: string; zh: string; yours: boolean } | null {
  if (!eligible) return null;
  if (mySeat && eligible === mySeat) {
    return { en: 'You currently have the legal winning right.', zh: '你现在拥有合法获胜权：你的 Victory Window', yours: true };
  }
  const holder = seatName(eligible, seats, mySeat);
  return {
    en: `${holder} currently has winning right.`,
    zh: `${holder} 当前拥有胜权，注意防守。`,
    yours: false,
  };
}
