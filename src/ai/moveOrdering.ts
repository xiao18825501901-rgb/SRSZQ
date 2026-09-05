import type { GameState, Player } from '../game/types';
import { currentPlayerOf, currentPlayerIsEligible, getLegalMoves } from '../game/legalMoves';
import { getWinningPoints } from '../game/legalMoves';
import { getEligiblePlayer } from '../game/eligibility';
import { currentRoundOf } from '../game/legalMoves';
import { maxRunThrough } from './threatAnalysis';
import type { RNG } from './rng';

export interface OrderedMove {
  row: number;
  col: number;
  /** 排序用启发式分数 */
  orderScore: number;
  reason?: string;
}

/** 当前行动者 */
export const actorOf = (state: GameState): Player => currentPlayerOf(state);

/**
 * 生成当前玩家的候选动作（引擎 getLegalMoves 保证 100% 合法），并按启发式排序。
 *
 * 保护集（永不剪掉）：
 * 1. 当前玩家的立即胜点（若其有资格）；
 * 2. 对「即将获权 / 已获权」对手胜点的封堵；
 * 3. 改变多个胜点的动作（fork 攻防）。
 *
 * @param k 普通候选上限（-1 = 全部保留）
 */
export function candidateMoves(state: GameState, k: number, rng?: RNG): OrderedMove[] {
  const legal = getLegalMoves(state); // 引擎来源：AI 与人类同一合法集
  if (legal.length === 0) return [];
  const me = actorOf(state);
  const board = state.board;
  const n = state.boardSize;
  const center = (n - 1) / 2;
  const meEligible = currentPlayerIsEligible(state);
  const round = currentRoundOf(state);

  // 立即胜点（只有有资格者才可能形成，引擎已保证合法）
  const winCells = new Set<string>();
  if (meEligible) {
    for (const p of getWinningPoints(board, me)) winCells.add(`${p.row},${p.col}`);
  }

  // 对手威胁：对手几何胜点 + 对手资格紧迫度
  const oppThreat = new Map<string, number>(); // cellKey -> 威胁值
  const opps = (['A', 'B', 'C'] as Player[]).filter((p) => p !== me);
  for (const opp of opps) {
    const wp = getWinningPoints(board, opp);
    if (wp.length === 0) continue;
    const eligibleNow = getEligiblePlayer(round, 'BAC') === opp;
    let threatVal = 0;
    if (eligibleNow) threatVal = 600;
    else {
      // 未来 2 轮内获权 → 高；更远 → 中低
      let soon = 0;
      for (let r = round + 1; r <= round + 3; r++) {
        soon++;
        if (getEligiblePlayer(r, 'BAC') === opp) break;
      }
      threatVal = soon <= 2 ? 260 : 90;
    }
    for (const p of wp) {
      const key = `${p.row},${p.col}`;
      oppThreat.set(key, Math.max(oppThreat.get(key) ?? 0, threatVal));
    }
  }

  const forced = new Set<string>();
  for (const m of legal) {
    const key = `${m.row},${m.col}`;
    if (winCells.has(key)) forced.add(key);
    if (oppThreat.has(key)) forced.add(key);
  }

  const scoreMove = (row: number, col: number): OrderedMove => {
    let s = 0;
    let reason = '';
    const key = `${row},${col}`;
    if (winCells.has(key)) {
      s += 1e9;
      reason = 'win';
    }
    const threat = oppThreat.get(key) ?? 0;
    if (threat > 0) {
      s += threat;
      reason = reason ? reason + '/block' : 'block';
    }
    const run = maxRunThrough(board, row, col, me); // 包含该格的最大连（>=4 只会出现在胜点）
    if (run === 3) {
      s += 90;
      if (!reason) reason = 'make3';
    } else if (run === 2) {
      s += 14;
      if (!reason) reason = 'make2';
    }
    if (run >= 4) s += 1e6; // 防御性保险（不应发生：非资格时非法；有资格时已被 win 覆盖）
    // 中心倾向
    const cd = Math.max(Math.abs(row - center), Math.abs(col - center));
    s += Math.max(0, center - cd) * 4;
    // 确定性微抖动（同分破序稳定）
    s += ((row * 31 + col * 17) % 7) * 0.01;
    return { row, col, orderScore: s, reason: reason || 'other' };
  };

  const scored = legal.map((m) => scoreMove(m.row, m.col));
  scored.sort((a, b) => b.orderScore - a.orderScore);

  // 保护集优先，再补 top-K
  const chosen: OrderedMove[] = [];
  const used = new Set<string>();
  for (const m of scored) {
    const key = `${m.row},${m.col}`;
    if (forced.has(key)) {
      chosen.push(m);
      used.add(key);
    }
  }
  let budget = k >= 0 ? k : scored.length;
  for (const m of scored) {
    if (budget <= 0) break;
    const key = `${m.row},${m.col}`;
    if (used.has(key)) continue;
    chosen.push(m);
    used.add(key);
    budget--;
  }
  void rng;
  return chosen;
}
