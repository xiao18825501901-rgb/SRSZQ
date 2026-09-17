import type { GameState, Player } from '../../game/types';
import type { AIDecision, AiDifficulty, AIOptions } from '../types';
import type { AIWorkerResponse } from './ai.worker';

/**
 * AI Worker 客户端：每个 job 一个一次性 Worker ——
 * 取消即 terminate()（搜索线程立刻停止，杜绝陈旧结果回写），
 * 天然规避了「复用 Worker 排队 + 过期 jobId」的竞态。
 */

export interface AIJobHandle {
  /** 终止搜索（结果不会再回调） */
  cancel: () => void;
}

let jobSeq = 1;

export function requestAIMove(
  state: GameState,
  player: Player,
  difficulty: AiDifficulty,
  options: AIOptions,
  onResult: (r: { decision: AIDecision | null; error?: string }) => void,
): AIJobHandle {
  const id = jobSeq++;
  let settled = false;
  const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), {
    type: 'module',
    name: `srszq-ai-${id}`,
  });

  const finish = () => {
    if (!settled) {
      settled = true;
      worker.terminate();
    }
  };

  worker.onmessage = (ev: MessageEvent<AIWorkerResponse>) => {
    const data = ev.data;
    if (!data || data.id !== id) return;
    finish();
    onResult({ decision: data.decision, error: data.error });
  };

  worker.onerror = (ev: ErrorEvent) => {
    finish();
    onResult({ decision: null, error: ev.message || 'AI worker error' });
  };

  worker.postMessage({ id, state, player, difficulty, options });

  return {
    cancel: () => {
      if (!settled) {
        settled = true;
        worker.terminate();
      }
    },
  };
}
