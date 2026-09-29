/**
 * AI 决策 worker 线程入口（P0C / S01）。
 *
 * 存在的唯一理由：AI 决策是**同步 CPU 密集**调用，实测单步会阻塞事件循环
 * 28–195ms（17×17 的 5★ MaxN 最坏）。放在主线程里意味着这段时间整个进程
 * 无法服务任何 HTTP 请求或 WebSocket 消息 —— 也就是所有房间一起卡。
 *
 * 本文件只做一件事：收任务 → 调共享 AI → 回结果。不含任何房间/网络逻辑，
 * 因此可以安全地被硬超时终止并重建。
 */
import { parentPort } from 'node:worker_threads';
import { chooseAIMove } from '../../../shared/src/ai/chooseAIMove.js';
import type { GameState, Player } from '../../../shared/src/game/types.js';
import type { AiDifficulty, MatchPolicyContext } from '../../../shared/src/ai/types.js';

export interface AiWorkerRequest {
  taskId: string;
  state: GameState;
  seat: Player;
  level: AiDifficulty;
  seed: number;
  timeBudgetMs: number;
  policy?: MatchPolicyContext;
}

export interface AiWorkerResponse {
  taskId: string;
  workerMs: number;
  decision: ReturnType<typeof chooseAIMove>;
}

if (!parentPort) {
  throw new Error('aiWorker.ts must be started as a worker thread');
}

parentPort.on('message', (req: AiWorkerRequest) => {
  const started = performance.now();
  try {
    const decision = chooseAIMove(req.state, req.seat, req.level, {
      seed: req.seed,
      timeBudgetMs: req.timeBudgetMs,
      policy: req.policy,
    });
    const res: AiWorkerResponse = { taskId: req.taskId, workerMs: performance.now() - started, decision };
    parentPort!.postMessage(res);
  } catch (err) {
    // 把失败原样回传，由主线程决定降级策略；worker 自身不改变任何棋局状态。
    parentPort!.postMessage({
      taskId: req.taskId,
      workerMs: performance.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
