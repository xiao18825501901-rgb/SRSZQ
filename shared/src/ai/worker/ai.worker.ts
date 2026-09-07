import type { GameState, Player } from '../../game/types';
import type { AIDecision, AiDifficulty, AIOptions } from '../types';
import { chooseAIMove } from '../chooseAIMove';

/**
 * SRSZQ AI Web Worker。
 *
 * 每个请求一个独立 Worker（由客户端创建），单次 job 协议：
 *  - 入站：{ id, state, player, difficulty, options }
 *  - 出站：{ id, decision } 或 { id, decision: null, error }
 *
 * 所有决策逻辑与主线程完全共享 src/ai + src/game（引擎即规则来源）。
 * 刻意不引用 lib.webworker（与 DOM lib 冲突），用最小自描述类型。
 */

export interface AIWorkerRequest {
  id: number;
  state: GameState;
  player: Player;
  difficulty: AiDifficulty;
  options: AIOptions;
}

export interface AIWorkerResponse {
  id: number;
  decision: AIDecision | null;
  error?: string;
}

type WorkerLike = {
  onmessage: ((ev: MessageEvent<AIWorkerRequest>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage: (msg: unknown) => void;
};

const ctx = self as unknown as WorkerLike;

ctx.onmessage = (ev: MessageEvent<AIWorkerRequest>) => {
  const { id, state, player, difficulty, options } = ev.data;
  try {
    const decision = chooseAIMove(state, player, difficulty, options);
    const resp: AIWorkerResponse = { id, decision };
    ctx.postMessage(resp);
  } catch (e) {
    const resp: AIWorkerResponse = {
      id,
      decision: null,
      error: e instanceof Error ? e.message : String(e),
    };
    ctx.postMessage(resp);
  }
};
