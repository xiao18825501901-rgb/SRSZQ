import type { Player } from '../../shared/src/game/types';
/** Display-only mapping. Canonical engine and network seat ids stay unchanged. */
export const PLAYER_COLOR_NAMES: Record<Player, string> = { A: '红', B: '绿', C: '白' };
export const colorName = (p: Player | null | undefined): string => p ? PLAYER_COLOR_NAMES[p] : '无';
export const playerName = (p: Player): string => `${PLAYER_COLOR_NAMES[p]}棋`;
