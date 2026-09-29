/**
 * P2 文案层（R03/R04/R07）：把后端的 messageKey + args 翻成中文。
 *
 * 两条纪律：
 *  1. 只描述**已证明的事实**（坐标、回合、胜权归属、点的数量），不加评价词；
 *  2. 多威胁时绝不说成“解杀/唯一正解”，只说明“占掉其中一个，还剩几个”。
 */
import type { KeyMove } from '../api';

const SEAT: Record<string, string> = { A: '红棋', B: '绿棋', C: '白棋' };
const seat = (s: string | null | undefined): string => (s ? SEAT[s] ?? s : '无');
const rc = (r: number, c: number): string => `(${r + 1}, ${c + 1})`;

export function explainKeyMove(km: KeyMove): string {
  const a = km.args ?? {};
  switch (km.messageKey) {
    case 'KEY_MOVE_IMMEDIATE_WIN':
      return `第 ${km.round} 轮 ${seat(km.actorSeat)} 在 ${rc(km.row, km.col)} 补上第四子，连成四子终局。`;
    case 'KEY_MOVE_MISSED_WIN':
      return `第 ${km.round} 轮 ${seat(km.actorSeat)} 手里有 ${a.points} 个致胜点，却落在 ${rc(km.row, km.col)}。`;
    case 'KEY_MOVE_PREEMPTIVE_BLOCK':
      return `第 ${km.round} 轮 ${seat(km.actorSeat)} 占掉了${seat(String(a.threatened ?? ''))}在它下一个行动回合（第 ${a.eligibleRound} 轮）的致胜点 ${rc(km.row, km.col)}。`;
    default:
      return `${km.messageKey}`;
  }
}

export function keyMoveTitle(type: string): string {
  if (type === 'IMMEDIATE_WIN') return '终局致胜';
  if (type === 'MISSED_WIN') return '错失致胜点';
  if (type === 'PREEMPTIVE_BLOCK') return '跨轮提前防守';
  return type;
}

/** 关键片段脚注：把 certainty 与预算如实写出来，不写成“必胜”或胜率。 */
export function certaintyNote(km: KeyMove): string {
  const horizon = km.proofHorizon === 1 ? '精确一步' : `证明视界 ${km.proofHorizon}`;
  return `${horizon} · 检查 ${km.nodes} 格 · ${km.wallMs}ms · ${km.certainty}`;
}

export function explainPuzzle(messageKey: string, args: Record<string, string | number>): string {
  switch (messageKey) {
    case 'PUZZLE_WIN_NOW':
      return `轮到${seat(String(args.seat ?? ''))}，本轮胜权也在它手上。这个局面里有 ${args.points} 个致胜点：在任意一个上补子都能连成四子。`;
    case 'PUZZLE_PREEMPT_LAST':
      return `${seat(String(args.threatened ?? ''))}在它的下一个行动回合（第 ${args.round} 轮）就能用 ${rc(Number(args.row), Number(args.col))} 连成四，而这是它**唯一**的致胜点 —— 占掉它就解除了。`;
    case 'PUZZLE_PREEMPT_ONE_OF':
      return `${seat(String(args.threatened ?? ''))}在第 ${args.round} 轮有 ${args.points} 个致胜点。占掉其中任何一个都能消掉一个威胁，但它还剩 ${args.remaining} 个 —— 这一步不构成“解杀”。`;
    case 'PUZZLE_FORBIDDEN_BLOCK':
      return `你这一轮没有胜权，同时还要防${seat(String(args.threatened ?? ''))}：它有 ${args.blocks} 个致胜点可以被你合法占掉，另有 ${args.forbidden} 个因为会同时让你自己连成四子（禁手）而不能下。`;
    default:
      return messageKey;
  }
}

export const ACCEPTANCE_LABEL: Record<string, string> = {
  WIN_NOW: '当前胜点',
  PREEMPT_LAST_THREAT: '跨轮提前防守（唯一威胁）',
  PREEMPT_ONE_THREAT: '跨轮提前防守（多个威胁）',
  FORBIDDEN_BLOCK: '禁手防守冲突',
};

export const OUTCOME_LABEL: Record<string, string> = { WIN: '胜', LOSS: '负', DRAW: '和', VOID: '无效' };
export const END_REASON_LABEL: Record<string, string> = {
  NORMAL_WIN: '正常终局', BOARD_DRAW: '棋盘下满和棋', PLAYER_FORFEIT: '玩家退出',
  TIMEOUT: '超时', PLAYER_DISCONNECT: '掉线', SYSTEM_ABORT: '系统中止',
};
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const z = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}