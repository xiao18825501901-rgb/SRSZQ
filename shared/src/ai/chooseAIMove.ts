import type { GameState, Player } from '../game/types';
import { currentPlayerOf, getLegalMoves } from '../game/legalMoves';
import type { AIDecision, AILevel, AIOptions } from './types';
import { randomAgent } from './randomAgent';
import { tacticalAgent } from './tacticalAgent';
import { selfishAgent } from './selfishAgent';
import { threePlySearch, maxnSearch } from './searchAgents';
import { makeRng } from './rng';
import { applyDefensePolicy } from './defensePolicy';

/**
 * SRSZQ AI 统一决策入口。
 *
 * 规则来源：AI 与人类完全共享 src/game 引擎 —— 本函数只
 * 读取状态 / 在合法集内选择 / 由调用方经 applyMove 落子。
 * 返回前对所选动作做二次合法性校验（引擎 isLegalMove 语义）。
 *
 * 同步实现（供 Worker / 测试 / 离线脚本直接使用）。
 */
export function chooseAIMove(state: GameState, player: Player, level: AILevel, options: AIOptions = {}): AIDecision {
  const started = performance.now();
  const legal = getLegalMoves(state);
  if (state.status !== 'playing' || legal.length === 0) {
    return { row: -1, col: -1, pass: true, thinkTimeMs: performance.now() - started, reason: 'No legal move' };
  }
  if (currentPlayerOf(state) !== player) {
    throw new Error(`SRSZQ AI seat mismatch: expected ${currentPlayerOf(state)}, asked ${player}`);
  }
  const rng = makeRng(options.seed);

  let decision: AIDecision;
  switch (level) {
    case 'random':
      decision = randomAgent(state, player, rng);
      break;
    case 'tactical':
      decision = tacticalAgent(state, player, rng);
      break;
    case 'selfish':
      decision = selfishAgent(state, player, rng);
      break;
    case '3ply': {
      const r = threePlySearch(state, { seed: options.seed, timeBudgetMs: options.timeBudgetMs, candidateK: options.candidateK });
      decision = {
        row: r.row,
        col: r.col,
        pass: false,
        score: r.utility,
        depth: r.depth,
        nodes: r.nodes,
        ttHits: r.ttHits,
        candidates: r.candidates,
        reason: `3-Ply depth ${r.depth}`,
      };
      break;
    }
    case 'maxn': {
      const r = maxnSearch(state, {
        seed: options.seed,
        timeBudgetMs: options.timeBudgetMs,
        candidateK: options.candidateK,
        maxDepth: options.maxDepth,
      });
      decision = {
        row: r.row,
        col: r.col,
        pass: false,
        score: r.utility,
        depth: r.depth,
        nodes: r.nodes,
        ttHits: r.ttHits,
        candidates: r.candidates,
        reason: `MaxN depth ${r.depth} best utility`,
      };
      break;
    }
  }

  // 内部防守策略（NOT PLAYER-FACING）：
  //  - Online 1H+2AI 仅 3/4/5★ 启用 Human 保护偏好（2★ 无）；
  //  - HvAI 最快威胁策略对除 1★(random) 外的档位生效。
  if (options.policy) {
    const protectOk = options.policy.protectSingleHuman === true && (level === 'selfish' || level === '3ply' || level === 'maxn');
    const fastestOk = options.policy.defenseFastestThreat === true && level !== 'random';
    if (protectOk || fastestOk) {
      decision = applyDefensePolicy(state, player, decision, options.policy, rng);
      if (!decision.pass) {
        const ok = legal.some((m) => m.row === decision.row && m.col === decision.col);
        if (!ok) decision = { row: legal[0].row, col: legal[0].col, pass: false, reason: 'policy fallback' };
      }
    }
  }

  // 二次校验：AI 返回的动作必须属于引擎合法集（pass 分支除外）
  if (!decision.pass) {
    const ok = legal.some((m) => m.row === decision.row && m.col === decision.col);
    if (!ok) {
      const fallback = legal[0];
      console.error(`[SRSZQ] AI_INVALID_DECISION (${level}): (${decision.row},${decision.col}) -> fallback (${fallback.row},${fallback.col})`);
      decision = { ...decision, row: fallback.row, col: fallback.col, reason: 'AI_INVALID_DECISION fallback' };
    }
  }
  decision.thinkTimeMs = performance.now() - started;
  return decision;
}

/** 异步包装（与 Worker 客户端接口一致，便于测试与未来迁移） */
export async function chooseAIMoveAsync(
  state: GameState,
  player: Player,
  level: AILevel,
  options: AIOptions = {},
): Promise<AIDecision> {
  return chooseAIMove(state, player, level, options);
}
