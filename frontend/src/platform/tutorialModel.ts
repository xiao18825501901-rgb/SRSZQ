/** 新手教程模型：exactly 1 Human + 2 AI。
 *  每次 tutorial session 初始化时：
 *   - 真人座位从 A/B/C 均匀随机；
 *   - 剩余两座为 AI，各自独立从真实 registry 均匀随机难度（1★–5★，可相同）。
 *  初始化结果 immutable；重开教程 = 重新初始化；普通 rerender/resize/切 tab 不改变。
 *  规则/引擎一律复用 shared（不建第二套）。 */
import type { Player } from '../../../shared/src/game/types';
import { PLAYERS } from '../../../shared/src/game/types';
import { AI_LEVELS, AI_LEVEL_LABELS, AI_LEVEL_STARS, type AILevel, type SeatConfigs } from '../../../shared/src/ai/types';
import { defaultRng, tutorialAiLevel, tutorialHumanSeat, type Rng } from '../../../shared/src/ai/assignment';

export type TutorialAssignment = SeatConfigs; // A/B/C → {human} | {ai, level}

/** 教程 session 一次性随机分配（immutable） */
export function createTutorialAssignment(rand: Rng = defaultRng): TutorialAssignment {
  const humanSeat: Player = tutorialHumanSeat(rand);
  const seats = {} as SeatConfigs;
  for (const p of PLAYERS) {
    seats[p] = p === humanSeat ? { kind: 'human' } : { kind: 'ai', level: tutorialAiLevel(rand) };
  }
  return seats;
}

/** 真人座位 */
export function humanSeatOf(seats: TutorialAssignment): Player {
  return PLAYERS.find((p) => seats[p].kind === 'human')!;
}

export function aiDisplayName(level: AILevel): string {
  return `${AI_LEVEL_LABELS[level]} ${AI_LEVEL_STARS[level]}`;
}

export interface RoleLine {
  seat: Player;
  role: '你' | '对手';
  detail: string; // 玩家 A（真人）/ 玩家 B · AI · Tactical ★★☆☆☆
}

/** 教程身份行（严格按 A/B/C 真实座位顺序，不把用户挪到第一行） */
export function tutorialRoleLines(seats: TutorialAssignment): RoleLine[] {
  return PLAYERS.map((p) => {
    const s = seats[p];
    if (s.kind === 'human') {
      return { seat: p, role: '你', detail: `玩家 ${p}（真人）` };
    }
    return { seat: p, role: '对手', detail: `玩家 ${p} · AI · ${aiDisplayName(s.level ?? 'random')}` };
  });
}

/** 教程是否合法：exactly 3 座、exactly 1 真人、exactly 2 AI，AI level 来自真实 registry */
export function isValidTutorialSeats(seats: SeatConfigs): boolean {
  const kinds = PLAYERS.map((p) => seats[p]?.kind);
  const humans = kinds.filter((k) => k === 'human').length;
  const ais = kinds.filter((k) => k === 'ai').length;
  const levelsValid = PLAYERS.every((p) => seats[p].kind !== 'ai' || AI_LEVELS.includes(seats[p].level as AILevel));
  return kinds.length === 3 && humans === 1 && ais === 2 && levelsValid;
}
