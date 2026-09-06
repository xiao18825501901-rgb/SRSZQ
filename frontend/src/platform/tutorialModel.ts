/** 新手教程模型：exactly 1 Human（A）+ 2 AI（B/C），AI 对来自真实 registry。
 *  随机化只发生在 tutorial session 初始化（本模块纯函数 + TutorialPage 一次性调用），
 *  React 重渲染不会改变对局身份；重开教程 = 重新初始化 → 新随机对。
 *  规则/引擎一律复用 shared（不建第二套）。 */
import { AI_LEVELS, AI_LEVEL_LABELS, AI_LEVEL_STARS, type AILevel, type SeatConfigs } from '../../../shared/src/ai/types';

export const HUMAN_SEAT = 'A' as const;
export const TUTORIAL_AI_SEATS = ['B', 'C'] as const;

/** 均匀随机取两个不同 AI（真实 registry：AI_LEVELS）。rand 可注入（测试用确定性 RNG）。 */
export function sampleAiPair(rand: () => number = Math.random): [AILevel, AILevel] {
  const a = Math.min(AI_LEVELS.length - 1, Math.max(0, Math.floor(rand() * AI_LEVELS.length)));
  let b = Math.min(AI_LEVELS.length - 1, Math.max(0, Math.floor(rand() * (AI_LEVELS.length - 1))));
  if (b >= a) b += 1;
  return [AI_LEVELS[a], AI_LEVELS[b]];
}

/** 教程座位：A = 人类；B/C = 给定两个 AI（顺序稳定：b=B 的 AI、c=C 的 AI） */
export function tutorialSeats(pair: [AILevel, AILevel]): SeatConfigs {
  return {
    A: { kind: 'human' },
    B: { kind: 'ai', level: pair[0] },
    C: { kind: 'ai', level: pair[1] },
  };
}

export interface RoleLine {
  seat: string;
  role: string; // 你 / 对手
  detail: string; // 玩家 A（真人）/ 玩家 B · AI · Tactical ★★☆☆☆
}

export function aiDisplayName(level: AILevel): string {
  return `${AI_LEVEL_LABELS[level]} ${AI_LEVEL_STARS[level]}`;
}

/** 教程身份行（页面顶部展示；AI 显示真实档位名/星级，见 tutorial 规范） */
export function tutorialRoleLines(pair: [AILevel, AILevel]): RoleLine[] {
  return [
    { seat: 'A', role: '你', detail: '玩家 A（真人）' },
    { seat: 'B', role: '对手', detail: `玩家 B · AI · ${aiDisplayName(pair[0])}` },
    { seat: 'C', role: '对手', detail: `玩家 C · AI · ${aiDisplayName(pair[1])}` },
  ];
}

/** 教程是否可用给定 seats（1H + 2AI、A 人类、B/C AI） */
export function isValidTutorialSeats(seats: SeatConfigs): boolean {
  return (
    seats.A.kind === 'human' &&
    seats.B.kind === 'ai' &&
    seats.C.kind === 'ai' &&
    typeof seats.B.level === 'string' &&
    typeof seats.C.level === 'string' &&
    seats.B.level !== seats.C.level
  );
}
