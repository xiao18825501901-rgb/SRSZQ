import { tx } from "./i18n/core";
import type { Player } from '../../shared/src/game/types';
/** Display-only mapping. Canonical engine and network seat ids stay unchanged. */
export const PLAYER_COLOR_NAMES: Record<Player, string> = { get A() {
        return tx("红");
    }, get B() {
        return tx("绿");
    }, get C() {
        return tx("白");
    } };
export const colorName = (p: Player | null | undefined): string => p ? PLAYER_COLOR_NAMES[p] : tx("无");
export const playerName = (p: Player): string => tx("{p0}棋", { p0: PLAYER_COLOR_NAMES[p] });
