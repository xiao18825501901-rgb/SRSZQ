import { formatDateTime } from "../i18n/core";
import { tx } from "../i18n/core";
/**
 * P2 文案层（R03/R04/R07）：把后端的 messageKey + args 翻成中文。
 *
 * 两条纪律：
 *  1. 只描述**已证明的事实**（坐标、回合、胜权归属、点的数量），不加评价词；
 *  2. 多威胁时绝不说成“解杀/唯一正解”，只说明“占掉其中一个，还剩几个”。
 */
import type { KeyMove } from '../api';
const SEAT: Record<string, string> = { get A() {
        return tx("红棋");
    }, get B() {
        return tx("绿棋");
    }, get C() {
        return tx("白棋");
    } };
const seat = (s: string | null | undefined): string => (s ? SEAT[s] ?? s : tx("无"));
const rc = (r: number, c: number): string => `(${r + 1}, ${c + 1})`;
export function explainKeyMove(km: KeyMove): string {
    const a = km.args ?? {};
    switch (km.messageKey) {
        case 'KEY_MOVE_IMMEDIATE_WIN':
            return tx("第 {p0} 轮 {p1} 在 {p2} 补上第四子\uFF0C连成四子终局。", { p0: km.round, p1: seat(km.actorSeat), p2: rc(km.row, km.col) });
        case 'KEY_MOVE_MISSED_WIN':
            return tx("第 {p0} 轮 {p1} 手里有 {p2} 个致胜点\uFF0C却落在 {p3}。", { p0: km.round, p1: seat(km.actorSeat), p2: a.points, p3: rc(km.row, km.col) });
        case 'KEY_MOVE_PREEMPTIVE_BLOCK':
            return tx("第 {p0} 轮 {p1} 占掉了{p2}在它下一个行动回合\uFF08第 {p3} 轮\uFF09的致胜点 {p4}。", { p0: km.round, p1: seat(km.actorSeat), p2: seat(String(a.threatened ?? '')), p3: a.eligibleRound, p4: rc(km.row, km.col) });
        default:
            return `${km.messageKey}`;
    }
}
export function keyMoveTitle(type: string): string {
    if (type === 'IMMEDIATE_WIN')
        return tx("终局致胜");
    if (type === 'MISSED_WIN')
        return tx("错失致胜点");
    if (type === 'PREEMPTIVE_BLOCK')
        return tx("跨轮提前防守");
    return type;
}
/** 关键片段脚注：把 certainty 与预算如实写出来，不写成“必胜”或胜率。 */
export function certaintyNote(km: KeyMove): string {
    const horizon = km.proofHorizon === 1 ? tx("精确一步") : tx("证明视界 {p0}", { p0: km.proofHorizon });
    return tx("{p0} \u00B7 检查 {p1} 格 \u00B7 {p2}ms \u00B7 {p3}", { p0: horizon, p1: km.nodes, p2: km.wallMs, p3: km.certainty });
}
export function explainPuzzle(messageKey: string, args: Record<string, string | number>): string {
    switch (messageKey) {
        case 'PUZZLE_WIN_NOW':
            return tx("轮到{p0}\uFF0C本轮胜权也在它手上。这个局面里有 {p1} 个致胜点\uFF1A在任意一个上补子都能连成四子。", { p0: seat(String(args.seat ?? '')), p1: args.points });
        case 'PUZZLE_PREEMPT_LAST':
            return tx("{p0}在它的下一个行动回合\uFF08第 {p1} 轮\uFF09就能用 {p2} 连成四\uFF0C而这是它**唯一**的致胜点 \u2014\u2014 占掉它就解除了。", { p0: seat(String(args.threatened ?? '')), p1: args.round, p2: rc(Number(args.row), Number(args.col)) });
        case 'PUZZLE_PREEMPT_ONE_OF':
            return tx("{p0}在第 {p1} 轮有 {p2} 个致胜点。占掉其中任何一个都能消掉一个威胁\uFF0C但它还剩 {p3} 个 \u2014\u2014 这一步不构成\u201C解杀\u201D。", { p0: seat(String(args.threatened ?? '')), p1: args.round, p2: args.points, p3: args.remaining });
        case 'PUZZLE_FORBIDDEN_BLOCK':
            return tx("你这一轮没有胜权\uFF0C同时还要防{p0}\uFF1A它有 {p1} 个致胜点可以被你合法占掉\uFF0C另有 {p2} 个因为会同时让你自己连成四子\uFF08禁手\uFF09而不能下。", { p0: seat(String(args.threatened ?? '')), p1: args.blocks, p2: args.forbidden });
        default:
            return messageKey;
    }
}
export const ACCEPTANCE_LABEL: Record<string, string> = {
    get WIN_NOW() {
        return tx("当前胜点");
    },
    get PREEMPT_LAST_THREAT() {
        return tx("跨轮提前防守\uFF08唯一威胁\uFF09");
    },
    get PREEMPT_ONE_THREAT() {
        return tx("跨轮提前防守\uFF08多个威胁\uFF09");
    },
    get FORBIDDEN_BLOCK() {
        return tx("禁手防守冲突");
    },
};
export const OUTCOME_LABEL: Record<string, string> = { get WIN() {
        return tx("胜");
    }, get LOSS() {
        return tx("负");
    }, get DRAW() {
        return tx("和");
    }, get VOID() {
        return tx("无效");
    } };
export const END_REASON_LABEL: Record<string, string> = {
    get NORMAL_WIN() {
        return tx("正常终局");
    },
    get BOARD_DRAW() {
        return tx("棋盘下满和棋");
    },
    get PLAYER_FORFEIT() {
        return tx("玩家退出");
    },
    get TIMEOUT() {
        return tx("超时");
    },
    get PLAYER_DISCONNECT() {
        return tx("掉线");
    },
    get SYSTEM_ABORT() {
        return tx("系统中止");
    },
};
export function formatTime(ms: number): string { return formatDateTime(ms); }

/** Translate known mode labels only; keep the stored protocol value untouched. */
export function modeLabel(mode: string): string {
    switch (mode) {
        case 'online': return tx('在线');
        case 'invite': return tx('好友对弈');
        case 'local': return tx('离线模式');
        case 'vsai': return tx('人机对战');
        default: return mode;
    }
}
