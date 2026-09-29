/**
 * 有界 AI worker 池（P0C / S01–S03）。
 *
 * 设计约束（都来自实测与规格，不是拍脑袋）：
 *  - **有界并发**：池大小固定，绝不随房间数增长；主线程不再执行 AI 搜索。
 *  - **有界队列**：队列满了立刻拒绝，而不是无限堆积把内存吃光。
 *  - **硬超时**：单任务超过 hardTimeoutMs 就判超时，并**终止并重建**该 worker
 *    —— 因为同步 CPU 循环不会响应取消信号，只能杀掉线程。
 *  - **崩溃隔离**：worker 抛错/退出时，其上的在途任务全部失败，由调用方降级；
 *    池会自动补齐，不影响其它房间。
 *  - **过期任务丢弃**：cancelUpTo(gameId, revision) 会把仍在排队、revision 更旧的
 *    任务直接作废，避免为一局早已推进的棋盘浪费算力。
 *
 * 主线程只做「提交 / 等待 / 降级」，不做搜索。
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { GameState, Player } from '../../../shared/src/game/types.js';
import type { AiDifficulty, MatchPolicyContext } from '../../../shared/src/ai/types.js';
import type { AiWorkerRequest, AiWorkerResponse } from './aiWorker.js';
import { createInitialState } from '../../../shared/src/game/rules.js';

/** 预热用的一手空棋盘（不参与任何真实对局）。 */
function createInitialStateLite(): GameState {
  return createInitialState(13);
}

/** 模块级共享的预热棋盘：探针只读它，不参与任何真实对局。 */
const WARMUP_STATE: GameState = createInitialStateLite();

export interface AiTaskRequest {
  taskId: string;
  gameId: string;
  /** 提交时刻房间的 revision；结果回来时若房间已推进，调用方应丢弃。 */
  revision: number;
  state: GameState;
  seat: Player;
  level: AiDifficulty;
  seed: number;
  timeBudgetMs: number;
  policy?: MatchPolicyContext;
}

export type AiTaskOutcome =
  | { kind: 'decided'; taskId: string; gameId: string; revision: number; decision: AiWorkerResponse['decision']; workerMs: number; queuedMs: number }
  | { kind: 'timeout'; taskId: string; gameId: string; revision: number; afterMs: number }
  | { kind: 'failed'; taskId: string; gameId: string; revision: number; error: string }
  | { kind: 'rejected'; taskId: string; gameId: string; revision: number; reason: 'QUEUE_FULL' | 'CLOSED' }
  | { kind: 'cancelled'; taskId: string; gameId: string; revision: number; reason: 'STALE' };

export interface AiWorkerHostOptions {
  poolSize?: number;
  queueLimit?: number;
  hardTimeoutMs?: number;
  /**
   * 预热任务的超时（默认 15s）。必须远大于业务硬超时：
   * worker 冷启动要加载 tsx loader + 共享 AI 模块，实测 300-400ms。
   */
  warmupTimeoutMs?: number;
}

export interface AiWorkerStats {
  poolSize: number;
  /** 已预热（可以立刻接业务任务）的槽位数：就绪探针据此判断能否开始服务。 */
  warm: number;
  running: number;
  queued: number;
  submitted: number;
  decided: number;
  timedOut: number;
  failed: number;
  rejected: number;
  cancelled: number;
  respawns: number;
}

interface Slot {
  worker: Worker;
  busy: string | null;
  /**
   * 该 worker 是否已经完成一次预热。
   *
   * 冷启动要加载 tsx loader + 共享 AI 模块（实测 300-400ms）。如果**不区分冷热**，
   * 一个刚被硬超时杀掉的 worker 重建后立刻接业务任务，就会因为冷启动再次超时、
   * 再被杀、再重建 —— 在硬超时配置偏小时形成活锁（实测 G6 曾因此 0 次 AI 落子）。
   * 因此：冷槽位只跑预热探针，预热完成后才允许承接业务任务。
   */
  warm: boolean;
}

interface Queued {
  req: AiTaskRequest;
  resolve: (o: AiTaskOutcome) => void;
  /** 提交时刻（用于统计真实排队时长，而不是恒为 0）。 */
  enqueuedAt: number;
  /**
   * 本次派发使用的硬超时。预热必须用独立的宽松值：
   * 冷启动要加载 tsx + 共享模块（实测 300-400ms），
   * 若也套用业务硬超时，预热必然超时 —— 那就等于没有预热。
   */
  timeoutMs: number;
  /** 是否为预热探针（预热结果不参与业务统计）。 */
  warmup?: boolean;
}

interface InFlight {
  slot: Slot;
  req: AiTaskRequest;
  resolve: (o: AiTaskOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  queuedAt: number;
  /** 本任务的硬超时（业务与预热使用不同值）。 */
  timeoutMs: number;
  /** 是否为预热探针。 */
  warmup: boolean;
}

function defaultPoolSize(): number {
  let cpus = 2;
  try {
    cpus = typeof availableParallelism === 'function' ? availableParallelism() : 2;
  } catch {
    cpus = 2;
  }
  return Math.max(1, Math.min(4, cpus - 1));
}

export class AiWorkerHost {
  private readonly workerUrl: URL;
  private readonly execArgv: string[];
  private readonly poolSize: number;
  private readonly queueLimit: number;
  private readonly hardTimeoutMs: number;
  private readonly warmupTimeoutMs: number;
  private slots: Slot[] = [];
  private queue: Queued[] = [];
  private inFlight = new Map<string, InFlight>();
  private closed = false;
  private counters = { submitted: 0, decided: 0, timedOut: 0, failed: 0, rejected: 0, cancelled: 0, respawns: 0 };

  constructor(opts: AiWorkerHostOptions = {}) {
    this.workerUrl = new URL('./aiWorker.ts', import.meta.url);
    // 服务器由 tsx 启动（PM2: tsx backend/src/server.ts）。把父进程的 loader 参数
    // 原样交给 worker，worker 才能像主进程一样解析 TypeScript。
    this.execArgv = process.execArgv.length ? [...process.execArgv] : ['--import', 'tsx'];
    this.poolSize = Math.max(1, opts.poolSize ?? defaultPoolSize());
    this.queueLimit = Math.max(0, opts.queueLimit ?? 64);
    this.hardTimeoutMs = Math.max(50, opts.hardTimeoutMs ?? 1500);
    this.warmupTimeoutMs = Math.max(this.hardTimeoutMs, opts.warmupTimeoutMs ?? 15_000);
  }

  get stats(): AiWorkerStats {
    return {
      poolSize: this.poolSize,
      warm: this.slots.filter((s) => s.warm).length,
      running: this.inFlight.size,
      queued: this.queue.length,
      ...this.counters,
    };
  }

  private spawnSlot(): Slot {
    const worker = new Worker(fileURLToPath(this.workerUrl), { execArgv: this.execArgv });
    const slot: Slot = { worker, busy: null, warm: false };
    worker.on('message', (res: AiWorkerResponse & { error?: string }) => this.onWorkerMessage(slot, res));
    worker.on('error', (err) => this.onWorkerDown(slot, err instanceof Error ? err.message : String(err)));
    worker.on('exit', (code) => {
      if (code !== 0) this.onWorkerDown(slot, 'worker exited with code ' + code);
    });
    worker.unref?.();
    return slot;
  }

  private ensurePool(): void {
    if (this.closed) return;
    while (this.slots.length < this.poolSize) this.slots.push(this.spawnSlot());
  }

  private onWorkerMessage(slot: Slot, res: AiWorkerResponse & { error?: string }): void {
    const taskId = res.taskId;
    const flight = this.inFlight.get(taskId);
    if (!flight || flight.slot !== slot) return; // 迟到的结果（已超时/已作废）直接丢
    clearTimeout(flight.timer);
    this.inFlight.delete(taskId);
    slot.busy = null;
    // 只要这个 worker 回过一条消息，它就热了（模块已加载完）。
    // 少了这一行，ensureWarm() 会认为槽位永远是冷的，于是每一次 pump()
    // 都重新派发预热探针 —— 实测形成无限预热循环，真实任务永远排在队列里。
    if (!res.error) slot.warm = true;
    if (flight.warmup) {
      // 预热探针不参与业务统计，也不 resolve 业务 promise（它本来就是个 no-op）。
      if (res.error) this.counters.failed += 1;
      this.pump();
      return;
    }
    if (res.error) {
      this.counters.failed += 1;
      flight.resolve({ kind: 'failed', taskId, gameId: flight.req.gameId, revision: flight.req.revision, error: res.error });
    } else {
      this.counters.decided += 1;
      flight.resolve({
        kind: 'decided', taskId, gameId: flight.req.gameId, revision: flight.req.revision,
        decision: res.decision, workerMs: res.workerMs, queuedMs: Date.now() - flight.queuedAt,
      });
    }
    this.pump();
  }

  private onWorkerDown(slot: Slot, error: string): void {
    // 该 worker 上的在途任务全部失败（调用方降级），池稍后补齐。
    for (const [taskId, flight] of [...this.inFlight]) {
      if (flight.slot !== slot) continue;
      clearTimeout(flight.timer);
      this.inFlight.delete(taskId);
      this.counters.failed += 1;
      flight.resolve({ kind: 'failed', taskId, gameId: flight.req.gameId, revision: flight.req.revision, error: 'worker down: ' + error });
    }
    slot.busy = null;
    this.slots = this.slots.filter((s) => s !== slot);
    try {
      void slot.worker.terminate();
    } catch {
      /* worker 已经不在了 */
    }
    if (!this.closed) {
      this.counters.respawns += 1;
      this.ensurePool();
      this.pump();
    }
  }

  /**
   * 给每个空闲的冷槽位派一个预热探针（用宽松的 warmupTimeoutMs）。
   * 返回当前是否还有冷槽位 —— 有的话业务任务就多等一会儿，避免冷启动被误判为超时。
   */
  private ensureWarm(): boolean {
    let anyCold = false;
    for (const slot of this.slots) {
      if (slot.warm) continue;
      anyCold = true;
      if (slot.busy) continue;
      const probeId = 'warmup-' + slot.worker.threadId + '-' + Math.random().toString(36).slice(2, 8);
      slot.busy = probeId;
      this.dispatch(slot, {
        req: {
          taskId: probeId, gameId: '__warmup__', revision: 0,
          state: WARMUP_STATE, seat: 'A', level: 1, seed: 1, timeBudgetMs: 50,
        },
        resolve: () => { /* 预热结果本身不重要，超时/失败由 onWorkerDown 处理 */ },
        enqueuedAt: Date.now(),
        timeoutMs: this.warmupTimeoutMs,
        warmup: true,
      });
    }
    return anyCold;
  }

  private pump(): void {
    if (this.closed) return;
    this.ensurePool();
    const anyCold = this.ensureWarm();
    for (const slot of this.slots) {
      if (slot.busy || !slot.warm) continue;
      const next = this.queue.shift();
      if (!next) return;
      this.dispatch(slot, next);
    }
    // 队列里还有业务任务、但槽位都在冷启动：等预热完成回填（onWorkerMessage 会再 pump）。
    void anyCold;
  }

  private dispatch(slot: Slot, item: Queued): void {
    const { req, resolve } = item;
    slot.busy = req.taskId;
    const timer = setTimeout(() => this.onHardTimeout(req.taskId), item.timeoutMs);
    timer.unref?.();
    const flight: InFlight = { slot, req, resolve, timer, queuedAt: item.enqueuedAt, timeoutMs: item.timeoutMs, warmup: item.warmup === true };
    this.inFlight.set(req.taskId, flight);
    const payload: AiWorkerRequest = {
      taskId: req.taskId, state: req.state, seat: req.seat, level: req.level,
      seed: req.seed, timeBudgetMs: req.timeBudgetMs, policy: req.policy,
    };
    try {
      slot.worker.postMessage(payload);
    } catch (err) {
      clearTimeout(timer);
      this.inFlight.delete(req.taskId);
      slot.busy = null;
      this.counters.failed += 1;
      resolve({ kind: 'failed', taskId: req.taskId, gameId: req.gameId, revision: req.revision, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 硬超时：同步 CPU 循环不响应取消，只能杀掉线程并重建。 */
  private onHardTimeout(taskId: string): void {
    const flight = this.inFlight.get(taskId);
    if (!flight) return;
    this.inFlight.delete(taskId);
    const limit = flight.timeoutMs;
    this.counters.timedOut += 1;
    flight.resolve({ kind: 'timeout', taskId, gameId: flight.req.gameId, revision: flight.req.revision, afterMs: limit });
    this.onWorkerDown(flight.slot, 'hard timeout after ' + limit + 'ms');
  }

  /** 统一入队：业务任务用 hardTimeoutMs，预热用 warmupTimeoutMs。 */
  private enqueue(req: AiTaskRequest, timeoutMs: number, warmup = false): Promise<AiTaskOutcome> {
    this.counters.submitted += 1;
    if (this.closed) {
      return Promise.resolve({ kind: 'rejected', taskId: req.taskId, gameId: req.gameId, revision: req.revision, reason: 'CLOSED' });
    }
    if (this.queue.length >= this.queueLimit) {
      this.counters.rejected += 1;
      return Promise.resolve({ kind: 'rejected', taskId: req.taskId, gameId: req.gameId, revision: req.revision, reason: 'QUEUE_FULL' });
    }
    this.ensurePool();
    const enqueuedAt = Date.now();
    const free = this.slots.find((s) => !s.busy && (warmup || s.warm));
    if (free) {
      return new Promise<AiTaskOutcome>((resolve) => this.dispatch(free, { req, resolve, enqueuedAt, timeoutMs, warmup }));
    }
    const pending = new Promise<AiTaskOutcome>((resolve) => {
      this.queue.push({ req, resolve, enqueuedAt, timeoutMs, warmup });
    });
    // 必须主动踢一次：池里可能只有冷槽位，预热探针只能由 pump() 派发。
    // 少了这一行，任务会静默躺在队列里永远不执行（实测把整个套件挂死）。
    this.pump();
    return pending;
  }

  /** 提交一个 AI 任务。队列满时立刻拒绝，绝不无限排队。 */
  submit(req: AiTaskRequest): Promise<AiTaskOutcome> {
    return this.enqueue(req, this.hardTimeoutMs);
  }

  /** 丢弃某局中 revision 落后于 currentRevision 的**仍在排队**的任务。 */
  cancelUpTo(gameId: string, currentRevision: number): number {
    const keep: Queued[] = [];
    let cancelled = 0;
    for (const item of this.queue) {
      if (item.req.gameId === gameId && item.req.revision < currentRevision) {
        cancelled += 1;
        this.counters.cancelled += 1;
        item.resolve({ kind: 'cancelled', taskId: item.req.taskId, gameId, revision: item.req.revision, reason: 'STALE' });
      } else {
        keep.push(item);
      }
    }
    this.queue = keep;
    return cancelled;
  }

  /**
   * 预热：把池拉起来并让每个 worker 先完成一次极轻任务。
   *
   * 为什么必须有：worker 首次启动要加载 tsx loader + 整个共享 AI 模块图，实测约 300–400ms。
   * 如果不预热，**重启后的第一个 AI 任务会把这段加载时间算进自己的硬超时**，
   * 于是一次正常的开局就被误判为超时而降级。预热把这段成本移到启动阶段。
   */
  async warmup(): Promise<{ warmed: number }> {
    if (this.closed) return { warmed: 0 };
    this.ensurePool();
    const state = createInitialStateLite();
    const results = await Promise.all(this.slots.map((slot) => new Promise<boolean>((resolve) => {
      const taskId = 'warmup-' + slot.worker.threadId;
      const req: AiTaskRequest = {
        taskId, gameId: '__warmup__', revision: 0, state,
        // 空棋盘上任何合法座位都可；用 1★ 保证极快
        seat: 'A', level: 1, seed: 1, timeBudgetMs: 50,
      };
      const timer = setTimeout(() => resolve(false), this.warmupTimeoutMs + 1000);
      this.enqueue(req, this.warmupTimeoutMs).then(
        (o) => { clearTimeout(timer); resolve(o.kind === 'decided'); },
        () => { clearTimeout(timer); resolve(false); },
      );
    })));
    const warmed = results.filter(Boolean).length;
    console.info(JSON.stringify({ event: 'ai_pool_warmed', warmed, poolSize: this.poolSize, timestamp: Date.now() }));
    return { warmed };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.queue) {
      item.resolve({ kind: 'rejected', taskId: item.req.taskId, gameId: item.req.gameId, revision: item.req.revision, reason: 'CLOSED' });
    }
    this.queue = [];
    for (const flight of this.inFlight.values()) clearTimeout(flight.timer);
    this.inFlight.clear();
    const workers = this.slots.map((s) => s.worker);
    this.slots = [];
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }
}
