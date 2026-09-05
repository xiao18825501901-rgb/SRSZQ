import type { GameState } from '../game/types';
import { currentPlayerIsEligible, currentPlayerOf } from '../game/legalMoves';
import { applyMove } from '../game/rules';
import { evaluateBAC } from './evaluation';
import { terminalUtility } from './evaluation';
import { candidateMoves } from './moveOrdering';
import { mulberry32, type RNG } from './rng';

const PLAYER_INDEX: Record<string, number> = { A: 0, B: 1, C: 2 };

export interface SearchBudget {
  timeBudgetMs: number;
  maxDepth: number;
  candidateK: number;
}

export interface SearchResult {
  row: number;
  col: number;
  utility: [number, number, number];
  depth: number;
  nodes: number;
  ttHits: number;
  completed: boolean;
  candidates: number;
}

class TimeoutSignal {
  deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }
  get expired(): boolean {
    return Date.now() > this.deadline;
  }
}

/** 搜索超时异常（内部使用） */
class SearchTimeout extends Error {
  constructor() {
    super('search time budget exceeded');
  }
}

interface TTEntry {
  depth: number;
  util: [number, number, number];
}

/** 稳定状态哈希：棋盘内容 + turnIndex（turnIndex 隐含 round/eligible —— 同盘不同轮=不同状态） */
function boardKey(state: GameState): string {
  const b = state.board;
  const n = state.boardSize;
  let s = '';
  for (let r = 0; r < n; r++) {
    const row = b[r];
    for (let c = 0; c < n; c++) {
      const v = row[c];
      s += v === null ? '.' : v;
    }
  }
  return s + '|' + state.turnIndex;
}

function winUtil(idx: number): [number, number, number] {
  const v: [number, number, number] = [0, 0, 0];
  v[idx] = 1;
  return v;
}

interface NodeStats {
  nodes: number;
  ttHits: number;
}

/**
 * 三人 MaxN 搜索（向量效用，当前行动者最大化自己的分量）。
 * 迭代加深 + 换位表 + 候选剪枝 + 时间预算；返回最后一个完整搜索深度。
 */
export function maxNSearch(state: GameState, budget: SearchBudget, seed?: number): SearchResult {
  const signal = new TimeoutSignal(budget.timeBudgetMs);
  const tt = new Map<string, TTEntry>();
  const actorIdx = PLAYER_INDEX[currentPlayerOf(state)];
  const rootCandidates = candidateMoves(state, budget.candidateK);
  const stats: NodeStats = { nodes: 0, ttHits: 0 };

  if (rootCandidates.length === 0) {
    return { row: -1, col: -1, utility: [0, 0, 0], depth: 0, nodes: 0, ttHits: 0, completed: true, candidates: 0 };
  }

  // 立即胜点：直接获胜（utility=1 已是最优）
  const winMoves = rootCandidates.filter((m) => m.orderScore >= 1e9);
  if (winMoves.length > 0) {
    const rng: RNG = mulberry32((seed ?? 7) * 2654435761);
    const pick = winMoves[Math.floor(rng.next() * winMoves.length)];
    return {
      row: pick.row,
      col: pick.col,
      utility: winUtil(actorIdx),
      depth: 1,
      nodes: 1,
      ttHits: 0,
      completed: true,
      candidates: rootCandidates.length,
    };
  }

  let lastCompleted: SearchResult | null = null;

  for (let depth = 1; depth <= budget.maxDepth; depth++) {
    const perDepth: NodeStats = { nodes: 0, ttHits: 0 };
    let bestUtil: [number, number, number] | null = null;
    const bestChildren: Array<{ row: number; col: number; util: [number, number, number] }> = [];
    let timedOut = false;

    try {
      for (const m of rootCandidates) {
        const res = applyMove(state, m.row, m.col);
        if (res.rejected) continue;
        const util = searchNode(res.state, depth - 1, signal, tt, perDepth, budget.candidateK);
        if (!bestUtil || util[actorIdx] > bestUtil[actorIdx] + 1e-9) {
          bestUtil = util;
          bestChildren.length = 0;
          bestChildren.push({ row: m.row, col: m.col, util });
        } else if (Math.abs(util[actorIdx] - bestUtil[actorIdx]) <= 1e-9) {
          bestChildren.push({ row: m.row, col: m.col, util });
        }
      }
    } catch (e) {
      if (e instanceof SearchTimeout) timedOut = true;
      else throw e;
    }
    stats.nodes += perDepth.nodes;
    stats.ttHits += perDepth.ttHits;

    if (!timedOut && bestUtil && bestChildren.length > 0) {
      // 严格同分才随机（保持 MaxN 稳定性）
      let pick = bestChildren[0];
      if (bestChildren.length > 1) {
        const rng: RNG = mulberry32((seed ?? 1) + depth * 7919);
        pick = bestChildren[Math.floor(rng.next() * bestChildren.length)];
      }
      lastCompleted = {
        row: pick.row,
        col: pick.col,
        utility: bestUtil,
        depth,
        nodes: stats.nodes,
        ttHits: stats.ttHits,
        completed: true,
        candidates: rootCandidates.length,
      };
    } else {
      break; // 超时：采用最后一个完整深度
    }
  }

  if (lastCompleted) return lastCompleted;
  // 兜底：第一个合法候选（极端情况下 d=1 也未完成）
  const fallback = rootCandidates[0];
  return {
    row: fallback.row,
    col: fallback.col,
    utility: [0, 0, 0],
    depth: 0,
    nodes: stats.nodes,
    ttHits: stats.ttHits,
    completed: false,
    candidates: rootCandidates.length,
  };
}

/** 递归节点：终局/叶评估/展开 */
function searchNode(
  state: GameState,
  depth: number,
  signal: TimeoutSignal,
  tt: Map<string, TTEntry>,
  stats: NodeStats,
  k: number,
): [number, number, number] {
  stats.nodes++;
  if ((stats.nodes & 127) === 0 && signal.expired) {
    throw new SearchTimeout();
  }
  const term = terminalUtility(state);
  if (term) return term;
  if (depth <= 0) {
    const evalRes = evaluateBAC(state);
    // 叶节点稳定化（quiescence-lite）：若「下一行动者」当前轮有资格且存在几何胜点，
    // 该玩家下一步必然直接获胜（禁手只约束无资格者）→ 叶值按终局锚定。
    // 否则浅/深搜索的叶子看到的局面不一致，深层搜索会被视界外的必胜步误导。
    if (currentPlayerIsEligible(state)) {
      const nxtIdx = PLAYER_INDEX[currentPlayerOf(state)];
      if (evalRes.features[currentPlayerOf(state)].winningPoints > 0) {
        return winUtil(nxtIdx);
      }
    }
    return evalRes.utility;
  }

  const me = currentPlayerOf(state);
  const meIdx = PLAYER_INDEX[me];
  const key = boardKey(state);
  const hit = tt.get(key);
  if (hit && hit.depth >= depth) {
    stats.ttHits++;
    return hit.util;
  }

  const cands = candidateMoves(state, k);
  if (cands.length === 0) {
    return evaluateBAC(state).utility;
  }

  let bestUtil: [number, number, number] | null = null;
  for (const m of cands) {
    const res = applyMove(state, m.row, m.col);
    if (res.rejected) continue;
    const util = searchNode(res.state, depth - 1, signal, tt, stats, k);
    if (!bestUtil || util[meIdx] > bestUtil[meIdx] + 1e-9) {
      bestUtil = util;
    }
  }
  const result = bestUtil ?? evaluateBAC(state).utility;
  if (tt.size < 200000) tt.set(key, { depth, util: result });
  return result;
}
