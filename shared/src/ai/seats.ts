import type { Player } from '../game/types';
import { PLAYERS } from '../game/types';
import { AI_LEVELS, type AiDifficulty, type SeatConfig, type SeatConfigs, type TacticId } from './types';

/**
 * SRSZQ AI 座位配置工具。
 *
 * 约束（对网页用户）：每局 0–2 个 AI，至少 1 个真人；
 * 三人全 AI 仅供内部 self-play / benchmark 脚本使用（用户界面禁止）。
 */

export const ALL_HUMAN_SEATS: SeatConfigs = {
  A: { kind: 'human' },
  B: { kind: 'human' },
  C: { kind: 'human' },
};

export function allHumanSeats(): SeatConfigs {
  return { A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'human' } };
}

export function countAI(seats: SeatConfigs): number {
  return PLAYERS.filter((p) => seats[p]?.kind === 'ai').length;
}

export function countHuman(seats: SeatConfigs): number {
  return PLAYERS.filter((p) => seats[p]?.kind !== 'ai').length;
}

export function isAISeat(seats: SeatConfigs, player: Player): boolean {
  return seats[player]?.kind === 'ai';
}

export function seatLevel(seats: SeatConfigs, player: Player): AiDifficulty {
  const cfg = seats[player];
  if (cfg?.kind === 'ai' && cfg.level) return cfg.level;
  return 1;
}

const LEGACY_DIFFICULTY: Record<TacticId, AiDifficulty> = {
  random: 1, tactical: 2, selfish: 3, '3ply': 4, maxn: 5,
};

export function parseAiDifficulty(raw: unknown): AiDifficulty {
  if (typeof raw === 'number' && AI_LEVELS.includes(raw as AiDifficulty)) return raw as AiDifficulty;
  if (typeof raw === 'string' && raw in LEGACY_DIFFICULTY) return LEGACY_DIFFICULTY[raw as TacticId];
  const numeric = Number(raw);
  return AI_LEVELS.includes(numeric as AiDifficulty) ? numeric as AiDifficulty : 1;
}

export function aiMode(seats: SeatConfigs): boolean {
  return countAI(seats) > 0;
}

/** 网页用户座位合法性：至少 1 真人（0–2 AI）。 */
export function isUserSeatsValid(seats: SeatConfigs): boolean {
  return countAI(seats) >= 0 && countAI(seats) <= 2 && countHuman(seats) >= 1;
}

/** 把某座位设为 AI 是否被允许（网页约束：不许三 AI）。 */
export function canSetAISeat(seats: SeatConfigs, player: Player): boolean {
  if (seats[player]?.kind === 'ai') return true; // 已在 AI，无需再加
  return countAI(seats) < 2;
}

/**
 * 从任意 JSON 值解析座位配置（导入/持久化）。
 * 非对象 / 缺字段一律回退全人类；非法 level 回退 1★；
 * 三 AI（内部格式）在用户侧回退为「A 人类 + 其余原样」。
 */
export function parseSeatConfigs(raw: unknown): SeatConfigs {
  const out = allHumanSeats();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const p of PLAYERS) {
    const seat = obj[p] as { kind?: unknown; level?: unknown } | undefined;
    if (!seat || typeof seat !== 'object') continue;
    const kind = seat.kind;
    if (kind === 'ai') {
      out[p] = { kind: 'ai', level: parseAiDifficulty(seat.level) };
    }
  }
  // 用户约束：至少 1 真人
  if (countHuman(out) < 1) {
    const firstAI = PLAYERS.find((p) => out[p].kind === 'ai');
    if (firstAI) out[firstAI] = { kind: 'human' };
  }
  return out;
}

/** 序列化（仅含 kind/level） */
export function serializeSeats(seats: SeatConfigs): Record<Player, SeatConfig> {
  const out = {} as Record<Player, SeatConfig>;
  for (const p of PLAYERS) {
    const s = seats[p];
    out[p] = s?.kind === 'ai' ? { kind: 'ai', level: s.level ?? 1 } : { kind: 'human' };
  }
  return out;
}

/** 座位变化检测（深层比较） */
export function seatsEqual(a: SeatConfigs, b: SeatConfigs): boolean {
  return PLAYERS.every((p) => {
    const sa = a[p];
    const sb = b[p];
    if (sa?.kind !== sb?.kind) return false;
    if (sa?.kind === 'ai' && sb?.kind === 'ai') return (sa.level ?? 1) === (sb.level ?? 1);
    return true;
  });
}
