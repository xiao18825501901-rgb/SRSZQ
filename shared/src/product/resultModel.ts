/**
 * SRSZQ 终局结果模型（P0A 新增，纯逻辑、零 IO）。
 *
 * 这一层把三件此前混在一起的事拆开：
 *  1. 棋局结果 —— 谁成四 / 是否满盘平局 / 是否被打断（棋色与真人 ID 分开保存）；
 *  2. 名次结果 —— 每个座位 WIN / LOSS / DRAW / VOID；
 *  3. 积分政策 —— 名次结果如何折算成排位分（历史上是胜 +30 / 负 -10）。
 *
 * 已知被修复的历史缺陷（基线代码实测）：
 *  - AI 成四时 `winnerSeat` 被置空，赢家棋色丢失；
 *  - 真平局走“没有真人胜者 → 全部人记负”的分支，平局被扣分；
 *  - 系统中止（abortRoom）完全不落盘，无 SYSTEM_ABORT 记录；
 *  - 单玩家离场时把“仍在自身宽限期内”的其他断线玩家一并判负。
 *
 * 本模块不读数据库、不发网络消息，因此可以被单元测试穷举。
 */
import type { GameStatus, Player } from '../game/types.js';

/** 座位复用规则引擎的 Player（A/B/C），避免第二套定义。 */
export type Seat = Player;

/**
 * 终局原因（持久化到 match_results.end_reason 与 MATCH_ENDED.reason）。
 *  - NORMAL_WIN         本手穿过新棋成 >=4 获胜
 *  - BOARD_DRAW         棋盘下满且无人成四（真平局，任何人不记负）
 *  - PLAYER_FORFEIT     主动 Leave（PLAYER_RESIGN）
 *  - TIMEOUT            在线真人超过服务器落子截止时间
 *  - PLAYER_DISCONNECT  掉线超过自身宽限期
 *  - SYSTEM_ABORT       服务器/对局编排中止（全员离开、进程级故障）
 */
export type EndReason =
  | 'NORMAL_WIN'
  | 'BOARD_DRAW'
  | 'PLAYER_FORFEIT'
  | 'TIMEOUT'
  | 'PLAYER_DISCONNECT'
  | 'SYSTEM_ABORT';

export const END_REASONS: readonly EndReason[] = [
  'NORMAL_WIN',
  'BOARD_DRAW',
  'PLAYER_FORFEIT',
  'TIMEOUT',
  'PLAYER_DISCONNECT',
  'SYSTEM_ABORT',
];

/** 名次结果。VOID = 本局对该玩家不产生竞技后果。 */
export type ParticipantOutcome = 'WIN' | 'LOSS' | 'DRAW' | 'VOID';

/** 计分政策标识；写入每一行账本，便于日后换算与追溯。 */
export const SCORE_POLICY_ID = 'legacy-online-v1';

/** 历史积分口径：仅在线排位的真人参与；AI 与 VOID 永不计分。 */
export const SCORE_POLICY = Object.freeze({ win: 30, loss: -10, draw: 0, void: 0 });

export const MATCH_MODE = Object.freeze({ ONLINE: 'online', INVITE: 'invite' } as const);
export type MatchMode = 'online' | 'invite';

export interface SettlementParticipantInput {
  seat: Seat;
  kind: 'human' | 'ai';
  userId?: string | null;
  /**
   * 本次结算中应记 LOSS 的离场者：
   * 主动 resign，或该座位自己的断线截止已经到达。
   */
  forfeited?: boolean;
  /**
   * 当前处于断线宽限期内、且**尚未**越过自己的截止时间。
   * 这类座位不得被提前判负 —— 记为 VOID，不扣分。
   */
  inGrace?: boolean;
}

export interface BuildSettlementInput {
  gameId: string;
  mode: MatchMode;
  boardSize: number;
  /** 引擎终局状态 */
  status: GameStatus;
  /** 引擎给出的获胜棋色（可能是 AI 座位）；平局为 null */
  boardWinner: Seat | null;
  endReason: EndReason;
  isRanked: boolean;
  participants: SettlementParticipantInput[];
}

export interface SettlementParticipant extends SettlementParticipantInput {
  outcome: ParticipantOutcome;
  /** 本次对该玩家的积分变化（未排位 / AI / VOID 恒为 0） */
  ratingDelta: number;
}

export interface SettlementPlan {
  gameId: string;
  mode: MatchMode;
  boardSize: number;
  endReason: EndReason;
  isRanked: boolean;
  scorePolicy: string;
  /** 保留获胜棋色，AI 获胜同样非空 */
  winnerSeat: Seat | null;
  /** 仅真人胜者（AI 获胜时为空数组，这是正常情况） */
  winnerUserIds: string[];
  loserIds: string[];
  participants: SettlementParticipant[];
}

/** 该名次结果在给定排位标志下折算的积分变化。 */
export function ratingDeltaFor(outcome: ParticipantOutcome, isRanked: boolean): number {
  if (!isRanked) return 0;
  switch (outcome) {
    case 'WIN':
      return SCORE_POLICY.win;
    case 'LOSS':
      return SCORE_POLICY.loss;
    // DRAW 与 VOID 都不产生竞技后果：平局不记败，中止不误扣。
    case 'DRAW':
    case 'VOID':
    default:
      return 0;
  }
}

/** 离场类终局：胜者由“谁还在场”推导，而不是由棋盘成四推导。 */
export function isForfeitReason(reason: EndReason): boolean {
  return reason === 'PLAYER_FORFEIT' || reason === 'TIMEOUT' || reason === 'PLAYER_DISCONNECT';
}

function humanSeats(participants: SettlementParticipantInput[]): SettlementParticipantInput[] {
  return participants.filter((p) => p.kind === 'human' && !!p.userId);
}

/**
 * 生成结算计划。纯函数：同样的输入必然产出同样的计划，便于测试与重放。
 *
 * 名次推导规则：
 *  - SYSTEM_ABORT：所有座位 VOID，winnerSeat 为空，零积分变化。
 *  - BOARD_DRAW  ：所有座位 DRAW，winnerSeat 为空，零积分变化（**不再全员记负**）。
 *  - NORMAL_WIN  ：
 *      · boardWinner 为真人 → 该座位 WIN，其余真人 LOSS；
 *      · boardWinner 为 AI   → winnerSeat 保留该 AI 棋色，全部真人 LOSS，无人 +30。
 *  - 离场类原因  ：
 *      · forfeited 座位 → LOSS；
 *      · inGrace 座位   → VOID（**不被提前处罚**）；
 *      · 其余在场真人   → WIN（若无人到场则 winnerSeat 为空，不虚构胜者）。
 */
export function buildSettlement(input: BuildSettlementInput): SettlementPlan {
  const { gameId, mode, boardSize, status, boardWinner, endReason, isRanked } = input;
  const participants = input.participants.map((p) => ({ ...p }));
  const outcomeBySeat = new Map<Seat, ParticipantOutcome>();
  const humans = humanSeats(participants);
  let winnerSeat: Seat | null = null;

  if (endReason === 'SYSTEM_ABORT') {
    for (const p of participants) outcomeBySeat.set(p.seat, 'VOID');
  } else if (endReason === 'BOARD_DRAW' || status === 'draw') {
    for (const p of participants) outcomeBySeat.set(p.seat, p.kind === 'human' ? 'DRAW' : 'VOID');
  } else if (isForfeitReason(endReason)) {
    const forfeited = humans.filter((p) => p.forfeited === true);
    const inGrace = humans.filter((p) => p.forfeited !== true && p.inGrace === true);
    const present = humans.filter((p) => p.forfeited !== true && p.inGrace !== true);
    for (const p of participants) {
      if (p.kind === 'ai') outcomeBySeat.set(p.seat, 'VOID');
      else if (p.forfeited === true) outcomeBySeat.set(p.seat, 'LOSS');
      else if (p.inGrace === true) outcomeBySeat.set(p.seat, 'VOID');
      else outcomeBySeat.set(p.seat, present.length > 0 ? 'WIN' : 'VOID');
    }
    // 仅当恰好只有一名在场真人时，才有明确的“获胜棋色”。
    winnerSeat = present.length === 1 ? present[0].seat : null;
    void forfeited;
    void inGrace;
  } else {
    // NORMAL_WIN：棋盘决胜。胜利棋色可能是 AI —— 必须原样保留。
    winnerSeat = boardWinner;
    for (const p of participants) {
      if (p.kind === 'ai') outcomeBySeat.set(p.seat, p.seat === boardWinner ? 'WIN' : 'VOID');
      else outcomeBySeat.set(p.seat, p.seat === boardWinner ? 'WIN' : 'LOSS');
    }
  }

  const resolved: SettlementParticipant[] = participants.map((p) => {
    const outcome = outcomeBySeat.get(p.seat) ?? 'VOID';
    const scores = p.kind === 'human' && !!p.userId;
    return { ...p, outcome, ratingDelta: scores ? ratingDeltaFor(outcome, isRanked) : 0 };
  });

  const winnerUserIds = resolved
    .filter((p) => p.kind === 'human' && !!p.userId && p.outcome === 'WIN')
    .map((p) => p.userId as string);
  const loserIds = resolved
    .filter((p) => p.kind === 'human' && !!p.userId && p.outcome === 'LOSS')
    .map((p) => p.userId as string);

  return {
    gameId,
    mode,
    boardSize,
    endReason,
    isRanked,
    scorePolicy: SCORE_POLICY_ID,
    winnerSeat,
    winnerUserIds,
    loserIds,
    participants: resolved,
  };
}

/** 对外广播用的状态串（保持与既有前端契约兼容）。 */
export function broadcastStatusFor(plan: SettlementPlan): 'won' | 'draw' | 'forfeit' | 'aborted' {
  if (plan.endReason === 'SYSTEM_ABORT') return 'aborted';
  if (plan.endReason === 'BOARD_DRAW') return 'draw';
  if (isForfeitReason(plan.endReason)) return 'forfeit';
  return 'won';
}

/** 稳定摘要：用于证据绑定与“同一局只结算一次”的比对。 */
export function settlementDigest(plan: SettlementPlan): string {
  const payload = JSON.stringify({
    gameId: plan.gameId,
    mode: plan.mode,
    boardSize: plan.boardSize,
    endReason: plan.endReason,
    isRanked: plan.isRanked,
    scorePolicy: plan.scorePolicy,
    winnerSeat: plan.winnerSeat,
    winnerUserIds: [...plan.winnerUserIds].sort(),
    loserIds: [...plan.loserIds].sort(),
    participants: [...plan.participants]
      .map((p) => [p.seat, p.kind, p.userId ?? null, p.outcome, p.ratingDelta])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (c + i), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 + (c ^ i), 0x27d4eb2f) >>> 0;
  }
  // 128 位十六进制摘要（32 字符）：用于把“这一份结算”绑定到证据上。
  return [h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}
