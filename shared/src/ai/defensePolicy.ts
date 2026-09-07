import type { Board, GameState, Player } from '../game/types';
import { PLAYERS } from '../game/types';
import { currentPlayerIsEligible, getLegalMoves, getWinningPoints } from '../game/legalMoves';
import { getEligiblePlayer } from '../game/eligibility';
import { currentRoundOf } from '../game/legalMoves';
import { cellLineInfo, maxRunThrough, patternFeatures } from './threatAnalysis';
import type { AIDecision, MatchPolicyContext } from './types';
import type { RNG } from './rng';

/**
 * 内部防守策略（NOT PLAYER-FACING）：
 *  - 绝不覆盖 acting AI 的立即获胜；
 *  - Online 1H+2AI（3/4/5★）：两个对手都有 meaningful 防守候选时，
 *    防守目标偏好 = 另一个 AI（减少唯一真人被集火）；Human 是唯一真实威胁时照常堵 Human；
 *  - HvAI 1H+2AI：无自胜时优先封堵“预计轮数上最快能赢”的对手（不区分真人/AI）。
 *  仅为目标偏好 / tie-break bias，位于 legal → self-win → strategic → defensive 之后。
 */

export function opponentsOf(player: Player): [Player, Player] {
  return PLAYERS.filter((p) => p !== player) as [Player, Player];
}

const cellKey = (r: number, c: number) => `${r},${c}`;

/** 对手 p 的“有意义防守候选格”：其几何胜点（落此即 ≥4）+ 其活三/半活三的开放端 */
export function threatCellsFor(board: Board, p: Player): Array<{ row: number; col: number }> {
  const n = board.length;
  const out = new Map<string, { row: number; col: number }>();
  for (const w of getWinningPoints(board, p)) {
    if (board[w.row][w.col] === null) out.set(cellKey(w.row, w.col), w);
  }
  // 活三 / 半活三开放端（只取 run 两端紧邻的空位；中间棋子不产生伪端）
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (board[r][c] !== p) continue;
      for (const info of cellLineInfo(board, r, c, p)) {
        if (info.run !== 3) continue;
        if (!info.openBoth && !info.openOne) continue;
        const dirs: Record<string, [number, number]> = { h: [0, 1], v: [1, 0], d: [1, 1], a: [1, -1] };
        const [dr, dc] = dirs[info.dir];
        const candidates = [
          { row: r + dr * 3, col: c + dc * 3, mid1: { row: r + dr * 2, col: c + dc * 2 }, mid2: { row: r + dr, col: c + dc } },
          { row: r - dr * 3, col: c - dc * 3, mid1: { row: r - dr * 2, col: c - dc * 2 }, mid2: { row: r - dr, col: c - dc } },
        ];
        for (const cand of candidates) {
          const inB = (p2: { row: number; col: number }) => p2.row >= 0 && p2.row < n && p2.col >= 0 && p2.col < n;
          // 端格必须为空，且中间两格是本方棋子（即该端紧邻此 run）
          if (!inB(cand) || board[cand.row][cand.col] !== null) continue;
          if (!inB(cand.mid1) || !inB(cand.mid2)) continue;
          if (board[cand.mid1.row][cand.mid1.col] !== p || board[cand.mid2.row][cand.mid2.col] !== p) continue;
          out.set(cellKey(cand.row, cand.col), cand);
        }
      }
    }
  }
  return [...out.values()];
}

/**
 * 对手预计还要多少“全局手数”才能形成获胜（近似，deterministic）：
 *  几何需要（已有胜点=1 / 活三=2 / 活二=3 / 无=∞）与“轮到它获得胜权并行动”所需手数取较大者。
 */
export function projectedTurnsToWin(state: GameState, p: Player): number {
  const f = patternFeatures(state.board, p);
  let geometric: number;
  if (f.winningPoints > 0) geometric = 1;
  else if (f.openThrees > 0 || f.halfOpenThrees > 0) geometric = 2;
  else if (f.openTwos > 0) geometric = 3;
  else return Infinity;
  const idx = PLAYERS.indexOf(p);
  const round = currentRoundOf(state);
  let r = round;
  for (let i = 0; i < 6; i++) {
    if (getEligiblePlayer(r) === p) break;
    r++;
  }
  const actionTurn = 3 * (r - 1) + idx; // 该轮 p 行动的手数（0-based）
  const turnsToEligibleAction = Math.max(0, actionTurn - state.turnIndex);
  return Math.max(geometric, turnsToEligibleAction);
}

export function applyDefensePolicy(
  state: GameState,
  player: Player,
  decision: AIDecision,
  policy: MatchPolicyContext | undefined,
  rng: RNG,
): AIDecision {
  if (!policy || decision.pass) return decision;
  const legal = getLegalMoves(state);
  const legalSet = new Set(legal.map((m) => cellKey(m.row, m.col)));

  // 绝对优先级：自己可立即获胜 → 直接赢（不保护 Human / 不堵别人）
  if (currentPlayerIsEligible(state)) {
    const myWins = getWinningPoints(state.board, player).filter((c) => legalSet.has(cellKey(c.row, c.col)));
    if (myWins.length > 0) {
      const w = myWins[Math.floor(rng.next() * myWins.length)];
      return { row: w.row, col: w.col, pass: false, reason: 'Immediate win (policy override)' };
    }
  }

  if (policy.protectSingleHuman && policy.humanSeat) {
    const decided = applyProtectionPreference(state, player, decision, policy.humanSeat, legalSet, rng);
    if (decided) return decided;
  }

  if (policy.defenseFastestThreat) {
    const decided = applyFastestThreat(state, player, decision, legalSet);
    if (decided) return decided;
  }

  return decision;
}

/** Online 1H+2AI 3/4/5★：封堵目标偏好 = 另一个 AI（在两者都有 meaningful 候选且当前决策在堵 Human 时替换） */
function applyProtectionPreference(
  state: GameState,
  player: Player,
  decision: AIDecision,
  humanSeat: Player,
  legalSet: Set<string>,
  rng: RNG,
): AIDecision | null {
  const [o1, o2] = opponentsOf(player);
  const otherAi = o1 === humanSeat ? o2 : o1;
  const humanCells = threatCellsFor(state.board, humanSeat).filter((c) => legalSet.has(cellKey(c.row, c.col)));
  const aiCells = threatCellsFor(state.board, otherAi).filter((c) => legalSet.has(cellKey(c.row, c.col)));
  if (aiCells.length === 0) return null; // 另一个 AI 没有 meaningful 威胁：照常（可堵 Human）
  if (humanCells.length === 0) return null; // Human 无威胁候选：无需偏好
  const targetsHuman = humanCells.some((c) => cellKey(c.row, c.col) === cellKey(decision.row, decision.col));
  if (!targetsHuman) return null; // 当前决策不是堵 Human → 保持
  const w = aiCells[Math.floor(rng.next() * aiCells.length)];
  return { row: w.row, col: w.col, pass: false, reason: 'Defensive preference: blocks other AI (internal)' };
}

/** HvAI 1H+2AI：无自胜时优先封堵预计最快获胜的对手（身份无关） */
function applyFastestThreat(state: GameState, player: Player, decision: AIDecision, legalSet: Set<string>): AIDecision | null {
  const [o1, o2] = opponentsOf(player);
  const t1 = projectedTurnsToWin(state, o1);
  const t2 = projectedTurnsToWin(state, o2);
  if (t1 === t2 || (!Number.isFinite(t1) && !Number.isFinite(t2))) return null; // tie → 交给原评估器
  const target = t1 < t2 ? o1 : o2;
  const cells = threatCellsFor(state.board, target).filter((c) => legalSet.has(cellKey(c.row, c.col)));
  if (cells.length === 0) return null;
  if (cells.some((c) => cellKey(c.row, c.col) === cellKey(decision.row, decision.col))) return null; // 已在堵最快者
  // 在目标候选里选对己方棋型最好的（deterministic：maxRunThrough 最大，平局取先者）
  let best = cells[0];
  let bestRun = -1;
  for (const c of cells) {
    const run = maxRunThrough(state.board, c.row, c.col, player);
    if (run > bestRun) {
      bestRun = run;
      best = c;
    }
  }
  return { row: best.row, col: best.col, pass: false, reason: 'Blocks fastest projected winner (internal)' };
}
