/** 本地对局座位配置模型（纯函数，可测）。
 *  本地局的 Human/AI 选择与 AI 难度（含随机）在“开始对局”时解析一次，
 *  之后作为 immutable SeatConfigs 交给 App（复用同一 shared 引擎）。 */
import type { Player } from '../../../shared/src/game/types';
import { PLAYERS } from '../../../shared/src/game/types';
import { AI_LEVELS, type AILevel, type SeatConfigs } from '../../../shared/src/ai/types';
import { defaultRng, pickUniform, type Rng } from '../../../shared/src/ai/assignment';

export type LocalDraftSeat = { kind: 'human' } | { kind: 'ai'; level: AILevel | 'auto' };
export type LocalDraft = Record<Player, LocalDraftSeat>;

export function localHumanCount(draft: LocalDraft): number {
  return PLAYERS.filter((p) => draft[p].kind === 'human').length;
}

/** 校验：至少一名真人（禁止 AI-only 作为默认产品行为） */
export function isLocalDraftValid(draft: LocalDraft): boolean {
  return localHumanCount(draft) >= 1;
}

/** 解析 draft → SeatConfigs：'auto'（随机）难度在 game initialization 时解析一次 */
export function resolveLocalSeats(draft: LocalDraft, rand: Rng = defaultRng): SeatConfigs {
  const seats = {} as SeatConfigs;
  for (const p of PLAYERS) {
    const d = draft[p];
    seats[p] =
      d.kind === 'human'
        ? { kind: 'human' }
        : { kind: 'ai', level: d.level === 'auto' ? pickUniform(AI_LEVELS, rand) : d.level };
  }
  return seats;
}
