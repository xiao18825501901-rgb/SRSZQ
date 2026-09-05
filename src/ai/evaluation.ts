import type { GameState, Player } from '../game/types';
import { ELIGIBLE_START_ROUND } from '../game/types';
import { firstEligibleRound, getEligiblePlayer } from '../game/eligibility';
import { currentRoundOf } from '../game/legalMoves';
import { patternFeatures } from './threatAnalysis';
import { DEFAULT_WEIGHTS, type EvalWeights } from './config/defaultWeights';

const PLAYERS: readonly Player[] = ['A', 'B', 'C'];

/**
 * 距离玩家 p 下一次获得胜权还有几轮（0 = 当前轮即拥有资格；Round 1-5 无人有资格）。
 * 正式规则 v2：R6=C、R7=B、R8=A，C→B→A 循环。
 * 用于资格感知：越接近自己的资格轮，攻击棋型价值越高。
 */
export function roundsUntilEligible(state: GameState, player: Player): number {
  const round = currentRoundOf(state);
  if (round < ELIGIBLE_START_ROUND) {
    // 尚未进入资格期：看自己第一次获权轮
    const first = firstEligibleRound(player);
    return Math.max(0, first - round);
  }
  let r = round;
  for (let i = 0; i < 6; i++) {
    if (getEligiblePlayer(r) === player) return r - round;
    r++;
  }
  return 6;
}

/** 某玩家在正式规则下是否「当前轮拥有资格」（与 state 无关的纯资格查询） */
export function eligibleAtRound(round: number): Player | null {
  return getEligiblePlayer(round);
}

export interface EvalResult {
  utility: [number, number, number];
  perPlayer: Record<Player, number>;
  features: Record<Player, ReturnType<typeof patternFeatures>>;
}

/**
 * 向量效用评估 [uA, uB, uC]（BAC 专用）。
 *
 * 每个玩家的分量 = 自身棋型收益 - 对手威胁损失，并按 BAC 资格距离加权：
 * - 越接近自己的资格轮：自己的胜点/三连价值越高；
 * - 对手若即将（1-2 轮内）获权：其胜点/三连威胁越高；
 * - 当前轮对手获权且马上行动：其胜点视为紧急威胁。
 */
export function evaluateBAC(state: GameState, weights: EvalWeights = DEFAULT_WEIGHTS): EvalResult {
  const board = state.board;
  const features = {} as Record<Player, ReturnType<typeof patternFeatures>>;
  for (const p of PLAYERS) features[p] = patternFeatures(board, p);

  const perPlayer = {} as Record<Player, number>;
  const n = state.boardSize;

  // 中心距离预计算表
  const center = (n - 1) / 2;
  const centerBonus: number[][] = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => {
      const d = Math.max(Math.abs(r - center), Math.abs(c - center));
      return Math.max(0, center - d) / center;
    }),
  );

  for (const me of PLAYERS) {
    const f = features[me];
    const distMe = roundsUntilEligible(state, me);
    // 攻击折扣：资格越远，自己的进攻棋型越「以后再说」
    const attackFactor = distMe === 0 ? 1 : Math.max(0.25, 1 - distMe * weights.qualificationDistanceDiscount);
    const farFactor = distMe >= 4 ? weights.farAttackDiscount : 1;

    let score = 0;
    // 己方棋型（攻击性随资格接近而放大）
    const ownPatternValue =
      f.winningPoints * weights.ownWinningPoint +
      f.openThrees * weights.openThree +
      f.halfOpenThrees * weights.halfOpenThree +
      f.openTwos * weights.openTwo +
      f.forks * weights.fork;
    score += ownPatternValue * attackFactor * farFactor;

    // 中心 + 连通性（稳定小项）
    let centerSum = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (board[r][c] === me) centerSum += centerBonus[r][c];
      }
    }
    score += centerSum * weights.center + f.connectivity * weights.connectivity;
    score += f.stones * weights.stones;

    // 禁手自陷：无资格时己方胜点全部是禁手（不可用、也限制自己）
    if (distMe > 0 && f.winningPoints > 0) {
      score -= Math.min(f.winningPoints, 4) * weights.forbiddenTrapPenalty;
    }

    // 对手威胁
    for (const opp of PLAYERS) {
      if (opp === me) continue;
      const fo = features[opp];
      const distOpp = roundsUntilEligible(state, opp);
      if (fo.winningPoints === 0 && fo.openThrees === 0 && fo.halfOpenThrees === 0) continue;
      // 威胁权重：对手资格越近越高
      const threatFactor = distOpp === 0 ? 1.15 : Math.max(0.3, 1 - distOpp * weights.qualificationDistanceDiscount);
      const oppValue =
        fo.winningPoints * weights.oppWinningPoint +
        fo.openThrees * weights.openThree +
        fo.halfOpenThrees * weights.halfOpenThree;
      score -= oppValue * threatFactor;
      // 紧急威胁：对手当前轮有资格且其胜点可直接获胜（它下一次行动在 me 再次行动之前或就是现在）
      if (distOpp === 0 && fo.winningPoints > 0) {
        score -= fo.winningPoints * weights.immediateOppThreat * threatFactor;
      }
    }
    perPlayer[me] = score;
  }

  // 效用压缩：原始分数是无界特征和，必须映射到 (0,1) 区间，
  // 使搜索中的终局值（胜=1/负=0/和=1/3）能正确锚定 —— 否则会出现
  // 「继续下（评估 -27）不如立即输（0）」的错误偏好。
  const SIGMOID_K = 45;
  const sig = (x: number) => 1 / (1 + Math.exp(-x / SIGMOID_K));
  const utility: [number, number, number] = [sig(perPlayer.A), sig(perPlayer.B), sig(perPlayer.C)];
  return { utility, perPlayer, features };
}

/** 指定玩家视角的标量评估（供 1-ply 类 agent 使用） */
export function evaluateForPlayer(state: GameState, player: Player, weights: EvalWeights = DEFAULT_WEIGHTS): number {
  return evaluateBAC(state, weights).perPlayer[player];
}

/** 终局效用 */
export function terminalUtility(state: GameState): [number, number, number] | null {
  if (state.status === 'won' && state.winner) {
    const v: [number, number, number] = [0, 0, 0];
    v[PLAYERS.indexOf(state.winner)] = 1;
    return v;
  }
  if (state.status === 'draw') return [1 / 3, 1 / 3, 1 / 3];
  return null;
}
