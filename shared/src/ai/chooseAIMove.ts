import type { GameState, Player } from '../game/types';
import { currentPlayerOf, getLegalMoves } from '../game/legalMoves';
import type { AIDecision, AiDifficulty, AIOptions, TacticId, TacticRunOptions, TacticRunner } from './types';
import { randomAgent } from './randomAgent';
import { tacticalAgent } from './tacticalAgent';
import { selfishAgent } from './selfishAgent';
import { threePlySearch, maxnSearch } from './searchAgents';
import { makeRng, type RNG } from './rng';
import { applyDefensePolicy } from './defensePolicy';
import { selectTactic } from './tacticMixer';

const defaultTacticRunner: TacticRunner = (
  tactic: TacticId,
  state: GameState,
  player: Player,
  rng: RNG,
  options: TacticRunOptions,
): AIDecision => {
  let decision: AIDecision;
  switch (tactic) {
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
      const result = threePlySearch(state, options);
      decision = {
        row: result.row, col: result.col, pass: false, score: result.utility,
        depth: result.depth, nodes: result.nodes, ttHits: result.ttHits,
        candidates: result.candidates, reason: `3-Ply depth ${result.depth}`,
      };
      break;
    }
    case 'maxn': {
      const result = maxnSearch(state, options);
      decision = {
        row: result.row, col: result.col, pass: false, score: result.utility,
        depth: result.depth, nodes: result.nodes, ttHits: result.ttHits,
        candidates: result.candidates, reason: `MaxN depth ${result.depth} best utility`,
      };
      break;
    }
  }

  // This runs after selection and never changes the tactic probability.
  if (options.policy) {
    const protectOk = options.policy.protectSingleHuman === true && ['selfish', '3ply', 'maxn'].includes(tactic);
    const fastestOk = options.policy.defenseFastestThreat === true && tactic !== 'random';
    if (protectOk || fastestOk) decision = applyDefensePolicy(state, player, decision, options.policy, rng);
  }
  return decision;
};

function safeFallback(
  legal: ReturnType<typeof getLegalMoves>,
  selectedTactic: TacticId,
  reason: string,
  started: number,
): AIDecision {
  const move = legal[0];
  return {
    row: move.row, col: move.col, pass: false, selectedTactic,
    fallbackUsed: true, reason, thinkTimeMs: performance.now() - started,
  };
}

/** Execute one explicitly selected tactic; used by the mixer and pure-tactic benchmarks. */
export function chooseTacticMove(
  state: GameState,
  player: Player,
  tactic: TacticId,
  options: AIOptions = {},
): AIDecision {
  const started = performance.now();
  const legal = getLegalMoves(state);
  if (state.status !== 'playing' || legal.length === 0) {
    return { row: -1, col: -1, pass: true, selectedTactic: tactic, thinkTimeMs: performance.now() - started, reason: 'No legal move' };
  }
  if (currentPlayerOf(state) !== player) {
    throw new Error(`SRSZQ AI seat mismatch: expected ${currentPlayerOf(state)}, asked ${player}`);
  }
  const rng = options.rng ?? makeRng(options.seed);
  const runner = options.tacticRunner ?? defaultTacticRunner;
  let decision: AIDecision;
  try {
    decision = runner(tactic, state, player, rng, options);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'ai_tactic_failure', tactic,
      error: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
    }));
    return safeFallback(legal, tactic, 'AI_TACTIC_ERROR fallback', started);
  }

  if (!decision || decision.pass || !Number.isInteger(decision.row) || !Number.isInteger(decision.col)
    || !legal.some((move) => move.row === decision.row && move.col === decision.col)) {
    console.error(JSON.stringify({
      event: 'ai_invalid_decision', tactic, row: decision?.row, col: decision?.col, timestamp: Date.now(),
    }));
    return safeFallback(legal, tactic, 'AI_INVALID_DECISION fallback', started);
  }
  return { ...decision, selectedTactic: tactic, thinkTimeMs: performance.now() - started };
}

/** Every call represents one AI turn and performs one fresh tactic draw. */
export function chooseAIMove(
  state: GameState,
  player: Player,
  difficulty: AiDifficulty,
  options: AIOptions = {},
): AIDecision {
  const rng = options.rng ?? makeRng(options.seed);
  const tactic = selectTactic(difficulty, rng);
  return chooseTacticMove(state, player, tactic, { ...options, rng });
}

export async function chooseAIMoveAsync(
  state: GameState,
  player: Player,
  difficulty: AiDifficulty,
  options: AIOptions = {},
): Promise<AIDecision> {
  return chooseAIMove(state, player, difficulty, options);
}
