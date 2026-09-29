/**
 * SRSZQ WebSocket 游戏服务 —— 服务器为唯一权威状态源。
 *
 * 职责：认证连接 / 匹配队列（60s 超时 AI 补位，权重 100/200/300/400/500）/
 * 房间（共享引擎校验每步）/ 广播 / 终局落盘与排行 / 断线重连 / 邀请对局。
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Db, SettledMatch } from '../db.js';
import { createInitialState, applyMove, forcePass, skipCurrentPlayer } from '../../../shared/src/game/rules.js';
import type { GameState } from '../../../shared/src/game/types.js';
import { currentPlayerOf, getLegalMoves } from '../../../shared/src/game/legalMoves.js';
import { qualificationFromState } from '../../../shared/src/game/qualification.js';
import { pickOnlineSingleHumanAiDifficulty, pickOnlineTwoHumanAiDifficulty, shuffled } from '../../../shared/src/ai/assignment.js';
import type { AiDifficulty, MatchPolicyContext } from '../../../shared/src/ai/types.js';
import { MatchmakingQueue, type MatchmakingEntry } from './matchmaking.js';
import { AiWorkerHost } from '../ai/aiWorkerHost.js';
import { decideWebSocketOrigin, rejectFrame, SlidingWindowLimiter, WS_MAX_MESSAGE_BYTES, WS_COMMAND_RATE_LIMIT, WS_COMMAND_RATE_WINDOW_MS } from './security.js';
import {
  buildSettlement,
  broadcastStatusFor,
  parseFeatureFlags,
  PROTOCOL_INFO,
  PROTOCOL_VERSION,
  RULESET_VERSION,
  COMMAND_ERRORS,
  commandPayloadDigest,
  resolveRatingPolicy,
  deriveScoreTargets,
  computeRatingDeltas,
  LEGACY_POLICY_ID,
  BETA_V1_POLICY_ID,
  NO_RATING_POLICY_ID,
  RATING_INITIAL,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 见下方 O06 校验
  type FeatureFlags,
  type EndReason,
  type SettlementPlan,
  type SettlementParticipantInput,
} from '../../../shared/src/index.js';

export type Seat = 'A' | 'B' | 'C';
const SEATS: Seat[] = ['A', 'B', 'C'];

/**
 * 终局原因（matches.end_reason / match_results.end_reason / MATCH_ENDED.reason）：
 * - NORMAL_WIN        本手穿过新棋成 >=4 获胜
 * - BOARD_DRAW        棋盘下满且无人成四（真平局：任何人不记负）
 * - PLAYER_FORFEIT    玩家主动 Leave（PLAYER_RESIGN）→ 立即判负
 * - PLAYER_DISCONNECT 掉线超过**自身**宽限期
 * - TIMEOUT           Online 真人落子超过服务器 30 秒截止时间
 * - SYSTEM_ABORT      服务器/对局编排中止（全员离开等），零竞技变更
 *
 * 定义已迁至 shared/product/resultModel（唯一真源），此处仅转出以保持既有导入路径可用。
 */
export type { EndReason } from '../../../shared/src/product/resultModel.js';

/** 房间内真人座位的连接状态（Online 判负状态机用） */
type SeatConn = 'connected' | 'disconnected' | 'left';
/**
 * 房间阶段：
 *   PLAYING → PLAYER_LEFT(宽限) → FINISHED
 *   RECOVERY_PAUSED：进程重启后从快照恢复出来的对局，等待玩家在 60 秒窗口内回来。
 */
type RoomPhase = 'PLAYING' | 'PLAYER_LEFT' | 'FINISHED' | 'RECOVERY_PAUSED';

interface SeatInfo {
  kind: 'human' | 'ai';
  userId?: string;
  username?: string;
  /** 客户端只见星级，不见真实档位 */
  stars?: number;
  aiLevel?: AiDifficulty;
  /** 真人座位连接状态（AI 座位无此字段） */
  conn?: SeatConn;
}

export interface GameServerOptions {
  queueTimeoutMs?: number; // 默认 60_000；测试可缩短
  aiMoveDelayMs?: number; // AI 落子模拟思考延迟
  disconnectSkipMs?: number; // 好友局：轮到断线玩家时多久自动跳过
  aiTimeBudgetMs?: number;
  /** 好友邀请聚合等待：发起 2 个邀请时，等第二位接受或此窗口超时 */
  inviteGatherMs?: number;
  /** Online Match 掉线宽限期（默认 10s）：期内 resume 恢复，超时判负 */
  forfeitGraceMs?: number;
  /** Deadline sweep interval; the one-shot timer is only an optimization. */
  queueSweepMs?: number;
  /** Human placement deadline; Online only. */
  turnTimeoutMs?: number;
  /** Protocol-level heartbeat interval; keeps tunnels alive through idle-killing middleboxes. */
  heartbeatIntervalMs?: number;
  /** 真实功能开关（默认全关，见 shared/config/featureFlags）。 */
  featureFlags?: Partial<FeatureFlags>;
  /** 结算持久化最大尝试次数（默认 3）；失败时不广播成功，房间保留以便重试。 */
  settlementMaxAttempts?: number;
  /** 进程重启后，恢复出来的对局等待玩家回来的窗口（默认 60_000ms）。 */
  recoveryGraceMs?: number;
  /** P0C：AI worker 池大小（默认 min(4, CPU-1)，与房间数无关，保证有界）。 */
  aiPoolSize?: number;
  /** P0C：AI 任务队列上限（默认 64）；超出立即拒绝并降级，不无限堆积。 */
  aiQueueLimit?: number;
  /** P0C：单个 AI 任务的硬超时（默认 1500ms）；超时杀线程重建。 */
  aiHardTimeoutMs?: number;
  /** P0C：WS 单条消息字节上限（默认 64KB）。 */
  wsMaxMessageBytes?: number;
  /** P0C：WS 逐连接命令速率上限（默认 60 条 / 10 秒）。 */
  wsCommandRateLimit?: number;
  wsCommandRateWindowMs?: number;
  /** P0C：允许的 WS Origin 白名单；不传则用与 HTTP API 相同的默认集合。 */
  allowedOrigins?: string[];
}

interface Client {
  ws: WebSocket;
  connectionId: string;
  userId: string;
  username: string;
  gameId?: string;
  /** WebSocket heartbeat state: false after a ping until its pong arrives. */
  isAlive: boolean;
}

interface Room {
  id: string;
  mode: 'online' | 'invite';
  state: GameState;
  seats: Record<Seat, SeatInfo>;
  humanIds: Set<string>; // 当前连接中的真人
  members: Record<string, Seat>; // userId -> seat
  ended: boolean;
  running: boolean;
  phase: RoomPhase;
  turnTimer?: ReturnType<typeof setTimeout>;
  turnDeadlineAt?: number;
  timedTurnIndex?: number;
  endReason?: EndReason;
  disconnectTimers: Map<Seat, ReturnType<typeof setTimeout>>; // online=判负宽限；invite=自动跳过
  /** 内部 AI 策略上下文（NOT PLAYER-FACING）：online 1H+2AI 保护偏好 */
  policy: MatchPolicyContext | null;
  /** P0B：每次成功生效的命令 +1。客户端必须带着它认识的 revision 提交命令。 */
  revision: number;
  /** P0B：持久事件序号，与 game_events.seq 一一对应。 */
  seq: number;
  /** P0B：房间级串行队列 —— 同一房间的命令严格按到达顺序执行，不并发交叉。 */
  commandQueue: Promise<void>;
  /** P0B：恢复暂停窗口的截止时间（仅 RECOVERY_PAUSED 期间有意义）。 */
  recoveryDeadlineAt?: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
}

/** 可持久化的房间快照（P0B）。只含恢复必需的信息，不含任何连接对象。 */
export interface RoomSnapshot {
  state: GameState;
  mode: 'online' | 'invite';
  boardSize: number;
  seats: Record<Seat, { kind: 'human'; userId: string | null; username: string | null } | { kind: 'ai'; aiLevel: AiDifficulty | null; stars: number | null }>;
  members: Record<string, Seat>;
  policy: MatchPolicyContext | null;
  revision: number;
  seq: number;
}

/** WS Origin 白名单默认值与 HTTP API 保持一致（部署时可用 SRSZQ_ALLOWED_ORIGINS 覆盖）。 */
const DEFAULT_ALLOWED_ORIGINS = ['https://srszq.com', 'https://www.srszq.com', 'https://srszq.netlify.app'];

/** 结构化 AI 日志（与既有 logMatchmaking 一致的 JSON 行格式）。 */
const AI_WEIGHTS: Array<{ difficulty: AiDifficulty; w: number }> = [
  { difficulty: 1, w: 100 },
  { difficulty: 2, w: 200 },
  { difficulty: 3, w: 300 },
  { difficulty: 4, w: 400 },
  { difficulty: 5, w: 500 },
];

function pickAiDifficulty(): AiDifficulty {
  const total = AI_WEIGHTS.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const { difficulty, w } of AI_WEIGHTS) {
    r -= w;
    if (r <= 0) return difficulty;
  }
  return 5;
}

/**
 * 终局输入（P0A）：服务器从房间状态推导，不含客户端声明。
 *  - boardWinner：引擎给出的获胜棋色（可能是 AI 座位）；平局/中止为 null
 *  - forfeitedSeats：本次应记 LOSS 的座位（主动离场，或自身断线截止已到）
 *  - inGraceSeats：仍在自己宽限期内、**不得提前处罚**的座位（记 VOID）
 */
interface FinalizeInfo {
  endReason: EndReason;
  boardWinner: Seat | null;
  forfeitedSeats: Seat[];
  inGraceSeats: Seat[];
}

/** 邀请会话（好友开房状态机） */
interface InviteSession {
  sender: string;
  targets: Map<string, 'pending' | 'accepted' | 'rejected'>;
  timer?: ReturnType<typeof setTimeout>;
  started: boolean;
}

export class GameServer {
  private db: Db;
  /** 已填充默认值的时序/容量参数；开关与重试次数单独持有，不参与 Required 展开。 */
  private opts: Required<Omit<GameServerOptions, 'featureFlags' | 'settlementMaxAttempts' | 'aiPoolSize' | 'aiQueueLimit' | 'aiHardTimeoutMs' | 'allowedOrigins'>>;
  /** 进程重启后从快照恢复出来的对局（gameId），用于诊断与证据。 */
  readonly recoveredGameIds: string[] = [];
  /** P0C：有界 AI worker 池（所有 AI 搜索都在这里执行，不占主线程）。 */
  readonly aiHost: AiWorkerHost;

  /**
   * P4：管理端要的运行时快照。只读、无副作用，且**不含**任何用户身份信息 ——
   * 管理页面需要知道“现在有多少房、多少连接、AI 池状态”，不需要知道是谁。
   */
  opsSnapshot(): {
    rooms: number;
    roomsEnded: number;
    wsClients: number;
    queuedEntries: number;
    worker: AiWorkerHost['stats'];
  } {
    let roomsEnded = 0;
    for (const room of this.rooms.values()) if (room.ended) roomsEnded += 1;
    return {
      rooms: this.rooms.size,
      roomsEnded,
      wsClients: this.clients.size,
      queuedEntries: this.matchmaking.size,
      worker: this.aiHost.stats,
    };
  }
  private readonly aiPoolSize: number;
  private readonly aiQueueLimit: number;
  private readonly aiHardTimeoutMs: number;
  private readonly wsLimiter: SlidingWindowLimiter;
  private readonly allowedOrigins: Set<string>;
  private wss: WebSocketServer;
  private clients = new Map<string, Client>();
  private matchmaking: MatchmakingQueue;
  private queueWakeTimer: ReturnType<typeof setTimeout> | null = null;
  private queueSweepTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private rooms = new Map<string, Room>();
  private userGame = new Map<string, string>(); // userId -> gameId
  private inviteSessions = new Map<string, InviteSession>();
  /** 显式功能开关；未传时读环境变量，全部默认 false。 */
  readonly featureFlags: FeatureFlags;
  private settlementMaxAttempts: number;
  /** 结算失败计数（诊断用；不含成功次数）。 */
  private settlementFailures = 0;

  constructor(db: Db, opts: GameServerOptions = {}) {
    this.db = db;
    this.featureFlags = { ...parseFeatureFlags(process.env), ...(opts.featureFlags ?? {}) };
    this.settlementMaxAttempts = opts.settlementMaxAttempts ?? 3;
    this.opts = {
      queueTimeoutMs: opts.queueTimeoutMs ?? 60_000,
      aiMoveDelayMs: opts.aiMoveDelayMs ?? 350,
      disconnectSkipMs: opts.disconnectSkipMs ?? 30_000,
      aiTimeBudgetMs: opts.aiTimeBudgetMs ?? 250,
      inviteGatherMs: opts.inviteGatherMs ?? 30_000,
      forfeitGraceMs: opts.forfeitGraceMs ?? 10_000,
      queueSweepMs: opts.queueSweepMs ?? 500,
      turnTimeoutMs: opts.turnTimeoutMs ?? 30_000,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 25_000,
      recoveryGraceMs: opts.recoveryGraceMs ?? 60_000,
      wsMaxMessageBytes: opts.wsMaxMessageBytes ?? WS_MAX_MESSAGE_BYTES,
      wsCommandRateLimit: opts.wsCommandRateLimit ?? WS_COMMAND_RATE_LIMIT,
      wsCommandRateWindowMs: opts.wsCommandRateWindowMs ?? WS_COMMAND_RATE_WINDOW_MS,
    };
    this.aiPoolSize = opts.aiPoolSize ?? 0;
    this.aiQueueLimit = opts.aiQueueLimit ?? 64;
    this.aiHardTimeoutMs = opts.aiHardTimeoutMs ?? 1500;
    this.aiHost = new AiWorkerHost({
      ...(this.aiPoolSize > 0 ? { poolSize: this.aiPoolSize } : {}),
      queueLimit: this.aiQueueLimit,
      hardTimeoutMs: this.aiHardTimeoutMs,
    });
    this.wsLimiter = new SlidingWindowLimiter(this.opts.wsCommandRateLimit, this.opts.wsCommandRateWindowMs);
    this.allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
    this.matchmaking = new MatchmakingQueue(this.opts.queueTimeoutMs);
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** 挂到 HTTP server 的 upgrade 事件 */
  attach(httpServer: import('node:http').Server, path = '/'): void {
    if (!this.queueSweepTimer) {
      this.queueSweepTimer = setInterval(() => this.finalizeEligibleMatchmaking('sweeper'), this.opts.queueSweepMs);
      this.queueSweepTimer.unref?.();
      // 协议级心跳：每 25s ping 一次。浏览器/客户端自动回 pong，隧道保持活跃，
      // 避免中间盒/本地代理（如 127.0.0.1:7890）在 ~50s 空闲时切断 CONNECT 隧道
      // 导致排队中的对局被重置；不回 pong 的死连接在下一轮被终止。
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
      httpServer.once('close', () => {
        if (this.queueSweepTimer) clearInterval(this.queueSweepTimer);
        this.queueSweepTimer = null;
        if (this.queueWakeTimer) clearTimeout(this.queueWakeTimer);
        this.queueWakeTimer = null;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      });
    }
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      // S05：来源校验在**升级之前**完成。伪造成白名单之外的浏览器来源直接拒绝，
      // 连 WebSocket 都不建立，避免给未授权来源分配任何服务端资源。
      // S05：认证也在升级之前完成。未认证客户端连 WebSocket 都不建立，
      // 不再"先握手再关闭"——那会为一个未授权来源分配真实的连接资源。
      if (!this.resolveSessionUser(url.searchParams.get('token') ?? '')) {
        console.warn(JSON.stringify({ event: 'ws_unauthenticated_rejected', timestamp: Date.now() }));
        socket.write(['HTTP/1.1 401 Unauthorized', 'Connection: close', '', ''].join(String.fromCharCode(13, 10)));
        socket.destroy();
        return;
      }
      const decision = decideWebSocketOrigin(req.headers.origin, this.allowedOrigins);
      if (!decision.allowed) {
        console.warn(JSON.stringify({ event: 'ws_origin_rejected', origin: decision.origin, reason: decision.reason, timestamp: Date.now() }));
        // 用字符码拼 CRLF：字面量 \r\n 会被写进源码时展开成真实换行，把字符串截断。
        socket.write(['HTTP/1.1 403 Forbidden', 'Connection: close', '', ''].join(String.fromCharCode(13, 10)));
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
    });
  }

  /** 由 token 解析出有效用户；升级阶段与 onSocket 共用同一判定，避免两处逻辑漂移。 */
  private resolveSessionUser(token: string) {
    const session = token ? this.db.findSession(token) : null;
    return session && session.expiresAt >= Date.now() ? this.db.findUserById(session.userId) : null;
  }

  private async onSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const user = this.resolveSessionUser(token);
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
      ws.close(4001, 'unauthorized');
      return;
    }
    // O06：客户端若显式声明协议/规则版本，必须完全一致才允许继续；
    // 不做“静默降级”，否则旧客户端会用一个它不理解的 revision 语义去下棋。
    const declaredProtocol = url.searchParams.get('protocol');
    const declaredRuleset = url.searchParams.get('ruleset');
    if (declaredProtocol !== null && Number(declaredProtocol) !== PROTOCOL_VERSION) {
      ws.send(JSON.stringify({ type: 'error', error: COMMAND_ERRORS.PROTOCOL_MISMATCH, expected: { ...PROTOCOL_INFO } }));
      ws.close(4002, 'protocol mismatch');
      return;
    }
    if (declaredRuleset !== null && declaredRuleset !== RULESET_VERSION) {
      ws.send(JSON.stringify({ type: 'error', error: COMMAND_ERRORS.PROTOCOL_MISMATCH, expected: { ...PROTOCOL_INFO } }));
      ws.close(4002, 'ruleset mismatch');
      return;
    }
    const client: Client = { ws, connectionId: randomUUID(), userId: user.id, username: user.username, isAlive: true };
    this.clients.set(user.id, client);
    ws.on('pong', () => { client.isAlive = true; });
    this.db.touchOnline(user.id, 'online');
    ws.send(JSON.stringify({
      type: 'hello',
      user: { id: user.id, username: user.username, tutorialCompleted: user.tutorialCompleted },
      protocol: { ...PROTOCOL_INFO },
    }));

    ws.on('message', (raw, isBinary) => {
      // S06：先做帧级校验（体积/二进制），再解析 JSON。超限的帧不解析、不分配结构。
      const bad = rejectFrame(raw as Buffer, Boolean(isBinary), this.opts.wsMaxMessageBytes);
      if (bad) {
        if (bad === 'TOO_LARGE') {
          // 明确拒绝并断开：继续读一个大帧流只会拖垮进程。
          this.sendTo(ws, { type: 'error', error: 'message too large', code: bad, maxBytes: this.opts.wsMaxMessageBytes });
          ws.close(4009, 'message too large');
        } else {
          this.sendTo(ws, { type: 'error', error: 'binary frames are not supported', code: bad });
        }
        console.warn(JSON.stringify({ event: 'ws_frame_rejected', userId: client.userId, code: bad, timestamp: Date.now() }));
        return;
      }
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        this.sendTo(ws, { type: 'error', error: 'invalid json' });
        return;
      }
      // S06：逐连接速率上限。超限不执行该消息，但**不**重置任何对局时钟。
      if (!this.wsLimiter.tryTake(client.userId)) {
        this.sendTo(ws, { type: 'error', error: 'rate limited', code: 'RATE_LIMITED' });
        console.warn(JSON.stringify({ event: 'ws_rate_limited', userId: client.userId, timestamp: Date.now() }));
        return;
      }
      void this.handleMessage(client, msg);
    });
    ws.on('close', () => { this.wsLimiter.forget(client.userId); this.onClose(client); });
    ws.on('error', () => { this.wsLimiter.forget(client.userId); this.onClose(client); });
  }

  private async handleMessage(client: Client, msg: { type?: string; [k: string]: unknown }): Promise<void> {
    const sendErr = (error: string) => this.sendTo(client.ws, { type: 'error', error });
    switch (msg.type) {
      case 'queue.join': {
        const user = this.db.findUserById(client.userId);
        if (!user?.tutorialCompleted) return sendErr('tutorial required');
        const existing = this.userGame.get(client.userId);
        if (existing) {
          const room = this.rooms.get(existing);
          if (room && !room.ended && room.members[client.userId]) {
            // queue.join is also a recovery signal. Re-send the authoritative
            // room even when the server still considers this user connected.
            this.resumeIntoRoom(room, client);
            return;
          }
          // 残留绑定（房间已清理）→ 释放后可正常重新匹配
          this.userGame.delete(client.userId);
        }
        const now = Date.now();
        const entry = this.matchmaking.join(client.userId, client.connectionId, now);
        this.db.touchOnline(client.userId, 'matching');
        this.sendQueueJoined(client, entry);
        this.logMatchmaking('queue_join', {
          queueId: entry.queueId, userId: entry.userId, humanCount: this.matchmaking.size,
          aiCount: Math.max(0, 3 - this.matchmaking.size), deadline: entry.deadlineAt,
        });
        this.scheduleQueueWake();
        if (this.matchmaking.size >= 3) this.finalizeEligibleMatchmaking('three_humans');
        break;
      }
      case 'queue.sync': {
        this.syncQueueOrMatch(client);
        break;
      }
      case 'queue.leave': {
        this.leaveQueue(client);
        break;
      }
      case 'invite.leave': {
        const room = client.gameId ? this.rooms.get(client.gameId) : undefined;
        if (room?.mode === 'invite' && room.members[client.userId]) this.abortRoom(room);
        break;
      }
      case 'PLAYER_RESIGN': {
        // 主动 Leave：Online Match 中立即判负并终局（服务器权威决定胜负，客户端无法伪造）
        const room = client.gameId ? this.rooms.get(client.gameId) : undefined;
        if (!room || room.ended) return sendErr('no active game');
        const seat = room.members[client.userId];
        if (!seat) return sendErr('not in game');
        if (room.mode !== 'online') return sendErr('resign not allowed in this mode');
        this.forfeitSeat(room, seat, 'PLAYER_FORFEIT');
        break;
      }
      case 'move': {
        await this.handleMoveCommand(client, msg);
        break;
      }
      case 'resume': {
        const gameId = String(msg.gameId ?? '');
        const room = this.rooms.get(gameId);
        if (!room || !room.members[client.userId]) {
          // 原对局已结束（如判负清理）→ 释放残留绑定，客户端可重新匹配
          if (gameId && this.userGame.get(client.userId) === gameId) this.userGame.delete(client.userId);
          return sendErr('no such game');
        }
        this.resumeIntoRoom(room, client);
        break;
      }
      default:
        sendErr('unknown message type');
    }
  }

  private queuePayload(entry: MatchmakingEntry): Record<string, unknown> {
    return {
      queueId: entry.queueId,
      waiting: this.matchmaking.size,
      timeoutMs: this.opts.queueTimeoutMs,
      enqueuedAt: entry.enqueuedAt,
      deadlineAt: this.matchmaking.nextDeadlineAt ?? entry.deadlineAt,
      serverNow: Date.now(),
    };
  }

  private sendQueueJoined(client: Client, entry: MatchmakingEntry): void {
    this.sendTo(client.ws, { type: 'queue.joined', ...this.queuePayload(entry) });
  }

  private syncQueueOrMatch(client: Client): void {
    const gameId = this.userGame.get(client.userId);
    const room = gameId ? this.rooms.get(gameId) : undefined;
    if (room && !room.ended && room.members[client.userId]) {
      this.sendTo(client.ws, { type: 'queue.state', state: 'MATCHED', gameId: room.id, serverNow: Date.now() });
      this.logMatchmaking('client_resume', { roomId: room.id, userId: client.userId });
      this.resumeIntoRoom(room, client);
      return;
    }
    const queued = this.matchmaking.snapshotFor(client.userId);
    if (queued) {
      const entry = this.matchmaking.join(client.userId, client.connectionId, Date.now());
      this.sendTo(client.ws, { type: 'queue.state', state: 'QUEUED', ...this.queuePayload(entry) });
      return;
    }
    this.sendTo(client.ws, { type: 'queue.state', state: 'NOT_QUEUED', serverNow: Date.now() });
  }

  private scheduleQueueWake(): void {
    if (this.queueWakeTimer) clearTimeout(this.queueWakeTimer);
    this.queueWakeTimer = null;
    const deadline = this.matchmaking.nextDeadlineAt;
    if (deadline === null) return;
    this.queueWakeTimer = setTimeout(
      () => this.finalizeEligibleMatchmaking('timer'),
      Math.max(0, deadline - Date.now()),
    );
    this.queueWakeTimer.unref?.();
  }

  /** 心跳：ping 所有连接；上一轮未回 pong 的连接视为死连接并终止。 */
  private heartbeat(): void {
    for (const client of this.clients.values()) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      try { client.ws.ping(); } catch { /* socket is closing */ }
    }
  }

  /** Timer, sweeper and third-human paths share one idempotent atomic claim. */
  private finalizeEligibleMatchmaking(trigger: 'timer' | 'sweeper' | 'three_humans'): void {
    let claim = this.matchmaking.claimEligible(Date.now());
    while (claim) {
      if (trigger !== 'three_humans') {
        this.logMatchmaking('deadline_reached', {
          queueId: claim.queueId, humanCount: claim.entries.length, aiCount: claim.aiCount,
          deadline: Math.min(...claim.entries.map((entry) => entry.deadlineAt)), trigger,
        });
      }
      const liveIds = claim.entries
        .map((entry) => entry.userId)
        .filter((userId) => this.clients.get(userId)?.ws.readyState === WebSocket.OPEN);
      if (liveIds.length > 0) {
        this.logMatchmaking('ai_fill_begin', {
          queueId: claim.queueId, humanCount: liveIds.length, aiCount: 3 - liveIds.length,
        });
        this.startRoom(liveIds, 'online', claim.queueId);
      }
      claim = this.matchmaking.claimEligible(Date.now());
    }
    this.scheduleQueueWake();
  }

  /** 启动对局：
   *  - online（排位队列）：参与者座位由服务器随机分配（1H/2H/3H 统一）；
   *    AI 补位难度按真人数量分级：
   *      1H+2AI：每个 AI 独立 2★20% / 3★30% / 4★40% / 5★10%（3/4/5★ 启用内部 Human 保护偏好，2★ 不启用）；
   *      2H+1AI：4★60% / 5★40%（无保护）；
   *      3H：无 AI。
   *  - invite（好友邀请）：保持邀请顺序（发送者/接受者），AI 补位沿用原有 1–5★ 权重。 */
  private startRoom(humanIds: string[], mode: 'online' | 'invite' = 'online', queueId = `invite-${randomUUID()}`): void {
    const live = humanIds.filter((id) => this.clients.has(id));
    const humans: SeatInfo[] = live.map((id) => {
      const u = this.db.findUserById(id);
      return { kind: 'human', userId: id, username: u?.username ?? '?', conn: 'connected' };
    });
    if (humans.length === 0) return;
    const participants: SeatInfo[] = [...humans];
    while (participants.length < 3) {
      let lvl: AiDifficulty;
      if (mode === 'online') {
        lvl = humans.length === 1 ? pickOnlineSingleHumanAiDifficulty() : pickOnlineTwoHumanAiDifficulty();
      } else {
        lvl = pickAiDifficulty();
      }
      participants.push({ kind: 'ai', stars: lvl, aiLevel: lvl });
    }
    // 随机分配“参与者 → A/B/C 座位”；不改变 A→B→C 的行动顺序（只换谁坐在哪）
    const assigned = mode === 'online' ? shuffled(participants) : participants;
    const members: Record<string, Seat> = {};
    for (const s of SEATS) {
      const si = assigned[SEATS.indexOf(s)];
      if (si.kind === 'human' && si.userId) members[si.userId] = s;
    }
    // 内部策略上下文：online 1H+2AI → 保护唯一真人（3/4/5★ 生效，2★ 由 chooseAIMove 忽略）
    let policy: MatchPolicyContext | null = null;
    if (mode === 'online' && humans.length === 1 && humans[0].userId) {
      policy = { protectSingleHuman: true, humanSeat: members[humans[0].userId] ?? undefined };
    }
    const room: Room = {
      id: randomUUID(),
      mode,
      state: createInitialState(13),
      seats: { A: assigned[0], B: assigned[1], C: assigned[2] },
      humanIds: new Set(humans.map((h) => h.userId!)),
      members,
      ended: false,
      running: false,
      phase: 'PLAYING',
      disconnectTimers: new Map(),
      policy,
      revision: 0,
      seq: 0,
      commandQueue: Promise.resolve(),
    };
    this.rooms.set(room.id, room);
    this.db.openLiveGame(room.id, room.members);
    this.recordProductEvent('match_start', room, { humanCount: Object.keys(room.members).length });
    this.ensureTurnClock(room);
    this.logMatchmaking('ai_fill_complete', {
      queueId, roomId: room.id, humanCount: humans.length, aiCount: 3 - humans.length,
    });
    this.logMatchmaking('room_created', {
      queueId, roomId: room.id, humanCount: humans.length, aiCount: 3 - humans.length,
    });
    for (const h of humans) {
      this.userGame.set(h.userId!, room.id);
      this.db.touchOnline(h.userId!, 'playing');
      const client = this.clients.get(h.userId!);
      if (client) {
        client.gameId = room.id;
        this.sendTo(client.ws, {
          type: 'game.start',
          gameId: room.id,
          mode: room.mode,
          seats: this.publicSeats(room),
          yourSeat: members[h.userId!],
          state: room.state,
          qualification: qualificationFromState(room.state),
          turnDeadlineAt: room.turnDeadlineAt ?? null,
          serverNow: Date.now(),
          revision: room.revision,
          seq: room.seq,
          phase: room.phase,
          protocol: { ...PROTOCOL_INFO },
        });
        this.logMatchmaking('broadcast_start', {
          queueId, roomId: room.id, userId: h.userId, humanCount: humans.length, aiCount: 3 - humans.length,
        });
      }
    }
    this.logMatchmaking('match_started', {
      queueId, roomId: room.id, humanCount: humans.length, aiCount: 3 - humans.length,
    });
    void this.maybeRunAI(room);
  }

  /**
   * 好友邀请状态机（WAITING → INVITED → ACCEPTED → GATHER → ROOM_READY/AI_FILL → STARTED）
   * - 只邀请了 1 人：其接受后立即 2 真人 + 1 AI；
   * - 邀请了 2 人：第一位接受后进入 GATHER（等第二位）；
   *   第二位接受 → 3 真人（无 AI）；等待窗超时仍只有 1 人 → 2 真人 + 1 AI；全拒 → 清理。
   */
  registerInvitation(senderId: string, receiverId: string): void {
    let s = this.inviteSessions.get(senderId);
    if (!s) {
      s = { sender: senderId, targets: new Map(), started: false };
      this.inviteSessions.set(senderId, s);
    }
    if (!s.targets.has(receiverId)) s.targets.set(receiverId, 'pending');
  }

  onInviteRejected(senderId: string, receiverId: string): void {
    const s = this.inviteSessions.get(senderId);
    if (!s) return;
    s.targets.set(receiverId, 'rejected');
    this.decideInvite(s);
  }

  handleInviteAccept(senderId: string, receiverId: string): void {
    let s = this.inviteSessions.get(senderId);
    if (!s) {
      // 无会话（异常路径）：按单邀请处理
      s = { sender: senderId, targets: new Map([[receiverId, 'accepted']]), started: false };
      this.inviteSessions.set(senderId, s);
    }
    s.targets.set(receiverId, 'accepted');
    this.decideInvite(s);
  }

  private decideInvite(s: InviteSession): void {
    if (s.started) return;
    const accepted = [...s.targets.entries()].filter(([, st]) => st === 'accepted').map(([id]) => id);
    const pending = [...s.targets.values()].filter((st) => st === 'pending').length;
    const total = s.targets.size;

    if (total === 1) {
      if (accepted.length === 1) this.startInvite(s, [s.sender, accepted[0]]);
      return;
    }
    // 多邀请：全员接受 → 3 真人；有拒绝且只剩 1 接受 → 2H+AI；否则等待窗口
    if (accepted.length >= 2 && accepted.length === total) {
      this.startInvite(s, [s.sender, ...accepted]);
      return;
    }
    if (accepted.length === 1 && pending === 0) {
      this.startInvite(s, [s.sender, accepted[0]]);
      return;
    }
    if (accepted.length >= 1 && !s.timer) {
      s.timer = setTimeout(() => {
        s.timer = undefined;
        if (s.started) return;
        const acc = [...s.targets.entries()].filter(([, st]) => st === 'accepted').map(([id]) => id);
        if (acc.length >= 2) this.startInvite(s, [s.sender, ...acc]);
        else if (acc.length === 1) this.startInvite(s, [s.sender, acc[0]]);
      }, this.opts.inviteGatherMs);
    }
  }

  /** 开房：在线真人 ≥2 才启动（不足则跳过，前端会重试/离开邀请状态） */
  private startInvite(s: InviteSession, invitedIds: string[]): void {
    const online = invitedIds.filter((id) => this.clients.has(id));
    if (online.length < 2) return;
    s.started = true;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
    }
    this.inviteSessions.delete(s.sender);
    this.startRoom(online, 'invite');
  }

  /** 供邀请流程使用：两真人 + 1 AI 的非排位对局（旧接口保留，单邀请直开） */
  startInviteGame(userAId: string, userBId: string): void {
    this.handleInviteAccept(userAId, userBId);
  }

  private publicSeats(room: Room): Record<Seat, { kind: string; username?: string; stars?: number }> {
    const out = {} as Record<Seat, { kind: string; username?: string; stars?: number }>;
    for (const s of SEATS) {
      const si = room.seats[s];
      out[s] = si.kind === 'human' ? { kind: 'human', username: si.username } : { kind: 'ai', stars: si.stars ?? 1 };
    }
    return out;
  }

  /** 是否存在「判负宽限中」的真人座位（Online 掉线暂停推进用） */
  private anyHumanAway(room: Room): boolean {
    return SEATS.some((s) => room.seats[s].kind === 'human' && room.seats[s].conn === 'disconnected');
  }

  /** AI 座位链：轮到 AI 就（模拟思考后）用共享 AI 落子。
   *  Online 房间有真人处于掉线宽限期时暂停推进（等重连或判负）。 */
  private async maybeRunAI(room: Room): Promise<void> {
    if (room.running) return;
    room.running = true;
    try {
      while (!room.ended && room.state.status === 'playing') {
        if (room.mode === 'online' && this.anyHumanAway(room)) break;
        const cur = currentPlayerOf(room.state);
        const seat = room.seats[cur];
        if (seat.kind !== 'ai' || !seat.aiLevel) break;
        const legal = getLegalMoves(room.state);
        if (legal.length === 0) {
          room.state = skipCurrentPlayer(room.state);
          this.broadcastRoom(room);
          continue;
        }
        await new Promise((r) => setTimeout(r, this.opts.aiMoveDelayMs));
        if (room.ended) return;
        if (room.mode === 'online' && this.anyHumanAway(room)) return;

        // P0C/S01：搜索移出主线程。提交前记下 revision，结果回来时若房间已推进
        // 就丢弃该结果 —— 绝不用一个过期棋盘上的决策去改现在的棋局。
        const revisionAtRequest = room.revision;
        const taskId = randomUUID();
        const outcome = await this.aiHost.submit({
          taskId,
          gameId: room.id,
          revision: revisionAtRequest,
          state: room.state,
          seat: cur,
          level: seat.aiLevel,
          seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
          timeBudgetMs: this.opts.aiTimeBudgetMs,
          policy: room.policy ?? undefined,
        });
        if (room.ended) return;
        if (room.revision !== revisionAtRequest) {
          this.logAi({ event: 'ai_task_stale_discarded', roomId: room.id, taskId, requestedRevision: revisionAtRequest, currentRevision: room.revision, outcome: outcome.kind });
          return;
        }

        const decided = outcome.kind === 'decided' ? outcome.decision : null;
        let degraded: string | null = null;
        if (!decided) degraded = outcome.kind === 'timeout' ? 'TIMEOUT' : outcome.kind === 'rejected' ? outcome.reason : outcome.kind === 'cancelled' ? 'STALE' : 'WORKER_FAILED';
        // S03：AI 失败/超时必须仍走出**合法**一手（或按引擎规则 Pass），
        // 不篡改棋盘、不让对局卡死；降级原因写进事件与日志。
        const fallbackMove = decided ? null : legal[0];
        const row = decided ? decided.row : fallbackMove?.row;
        const col = decided ? decided.col : fallbackMove?.col;
        if (row === undefined || col === undefined) {
          this.logAi({ event: 'ai_no_legal_fallback', roomId: room.id, taskId, outcome: outcome.kind });
          break;
        }
        this.logAi({
          event: decided ? 'ai_tactic_selected' : 'ai_degraded_legal_fallback',
          difficulty: seat.aiLevel,
          selectedTactic: decided?.selectedTactic ?? 'legal-fallback',
          degraded,
          moveLatency: decided ? (outcome.kind === 'decided' ? outcome.workerMs + outcome.queuedMs : 0) : 0,
          legal: decided ? !decided.fallbackUsed : true,
          round: Math.floor(room.state.turnIndex / 3) + 1,
          seat: cur, roomId: room.id, taskId, timestamp: Date.now(),
        });
        const res = applyMove(room.state, row, col);
        if (res.rejected) break;
        // AI 落子与人类落子走同一条提交路径：先持久化，再改内存，最后广播。
        // commandId 由服务器生成 —— 服务器是权威，AI 没有客户端信封。
        this.commitAppliedMove(room, cur, 'ai-' + randomUUID(), { row, col }, res.state);
        if (room.ended || room.state.status !== 'playing') return;
      }
    } finally {
      room.running = false;
    }
  }

  /** 命令被拒绝时统一回执：带稳定错误码 + 当前 revision，客户端据此决定丢弃或重取状态。 */
  private sendCmdError(client: Client, room: Room | null, code: string, error: string, commandId?: string): void {
    this.sendTo(client.ws, {
      type: 'command.rejected',
      commandId: commandId ?? null,
      code,
      error,
      revision: room ? room.revision : null,
    });
  }

  /**
   * 落子命令入口（P0B）。
   *
   * 信封：{ type:'move', commandId, expectedRevision, row, col }
   *  - 房间级串行：同一房间的命令严格按到达顺序执行，人类与 AI 落子不交叉；
   *  - 幂等：同一 commandId 重发只回放既有 ACK，不二次落子、不重置落子时钟；
   *  - 冲突：同一 commandId 不同 payload 一律拒绝，绝不覆盖已生效命令；
   *  - revision：expectedRevision 必须等于房间当前 revision，否则按 STALE_REVISION 丢弃；
   *  - 顺序：先在一个事务里持久化（事件 + 快照 + 幂等行）→ 再改内存 → 最后广播。
   */
  private async handleMoveCommand(client: Client, msg: Record<string, unknown>): Promise<void> {
    const room = client.gameId ? this.rooms.get(client.gameId) : undefined;
    if (!room || room.ended) return this.sendCmdError(client, null, 'NO_ACTIVE_GAME', 'no active game');
    const seat = room.members[client.userId];
    if (!seat) return this.sendCmdError(client, room, 'NOT_IN_GAME', 'not in game');
    const commandId = typeof msg.commandId === 'string' ? msg.commandId.trim() : '';
    const expectedRevision = msg.expectedRevision === undefined ? null : Number(msg.expectedRevision);
    if (!commandId || commandId.length > 128 || (expectedRevision !== null && !Number.isInteger(expectedRevision))) {
      return this.sendCmdError(client, room, COMMAND_ERRORS.BAD_ENVELOPE,
        'move requires commandId (string <=128) and expectedRevision (integer)', commandId);
    }
    if (room.phase === 'RECOVERY_PAUSED') {
      return this.sendCmdError(client, room, COMMAND_ERRORS.RECOVERY_PAUSED, 'game is recovering; resume first', commandId);
    }
    const row = Number(msg.row);
    const col = Number(msg.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      return this.sendCmdError(client, room, 'INVALID_MOVE', 'invalid move', commandId);
    }
    // 串行化：命令排在本房间队列尾部；队列本身永不 reject（否则后续命令全部短路）。
    const run = room.commandQueue.then(() =>
      this.executeMoveCommand(room, client, seat, commandId, expectedRevision, row, col));
    room.commandQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  private executeMoveCommand(
    room: Room, client: Client, seat: Seat,
    commandId: string, expectedRevision: number | null, row: number, col: number,
  ): void {
    if (room.ended) {
      // 房间已终局：如果命令其实已经生效过，回放 ACK（幂等），否则明确拒绝。
      const prior = this.db.findGameCommand(room.id, commandId);
      if (prior) return this.sendTo(client.ws, JSON.parse(prior.ackJson) as object);
      return this.sendCmdError(client, room, 'GAME_ENDED', 'no active game', commandId);
    }
    // 幂等闸门：先查已生效命令，命中即回放，不再落子、不碰时钟。
    const prior = this.db.findGameCommand(room.id, commandId);
    if (prior) {
      const digest = commandPayloadDigest({ row, col });
      if (prior.payloadDigest !== digest) {
        return this.sendCmdError(client, room, COMMAND_ERRORS.IDEMPOTENCY_CONFLICT,
          'commandId reused with a different payload', commandId);
      }
      this.sendTo(client.ws, JSON.parse(prior.ackJson) as object);
      return;
    }
    if (expectedRevision !== null && expectedRevision !== room.revision) {
      return this.sendCmdError(client, room, COMMAND_ERRORS.STALE_REVISION,
        `expected revision ${expectedRevision} but room is at ${room.revision}`, commandId);
    }
    if (currentPlayerOf(room.state) !== seat) {
      return this.sendCmdError(client, room, 'NOT_YOUR_TURN', 'not your turn', commandId);
    }
    // 绝对截止时间在受理前校验：被 CPU 拖延的定时器回调不能让它失效。
    if (room.mode === 'online' && room.turnDeadlineAt && Date.now() >= room.turnDeadlineAt) {
      this.forfeitSeat(room, currentPlayerOf(room.state), 'TIMEOUT');
      return;
    }
    const res = applyMove(room.state, row, col);
    if (res.rejected) {
      // 非法落子不落库、不推进 revision、**不重置落子时钟**。
      this.sendTo(client.ws, { type: 'command.rejected', commandId, code: 'MOVE_REJECTED', error: `move rejected: ${res.rejected}`, revision: room.revision });
      return;
    }
    this.commitAppliedMove(room, seat, commandId, { row, col }, res.state);
  }

  /**
   * 已生效落子的唯一提交路径：**先持久化，再改内存，最后广播**。
   * AI 落子同样走这里（commandId 由服务器生成，服务器是权威）。
   */
  private commitAppliedMove(
    room: Room, seat: Seat, commandId: string,
    payload: Record<string, unknown>, nextState: GameState,
  ): void {
    const revisionBefore = room.revision;
    const revisionAfter = revisionBefore + 1;
    const seq = room.seq + 1;
    const ack = {
      type: 'ack',
      commandId,
      gameId: room.id,
      seat,
      revision: revisionAfter,
      seq,
      applied: { ...payload },
    };
    const record = this.db.appendGameCommand({
      gameId: room.id,
      commandId,
      seat,
      payload,
      revisionBefore,
      revisionAfter,
      seq,
      eventType: 'move.applied',
      eventPayload: { seat, ...payload, revision: revisionAfter },
      snapshot: this.buildRoomSnapshot(room, nextState, revisionAfter, seq),
      ack,
      createdAt: Date.now(),
    });
    if (!record.appended) {
      // 并发下别人先写入了同一 commandId：**不重复落子**。
      const owner = room.seats[seat].kind === 'human' && room.seats[seat].userId
        ? this.clients.get(room.seats[seat].userId!)
        : undefined;
      if (record.conflict) {
        if (owner && owner.gameId === room.id) {
          this.sendCmdError(owner, room, COMMAND_ERRORS.IDEMPOTENCY_CONFLICT, 'commandId reused with a different payload', commandId);
        }
        return;
      }
      // 同 payload 重放：ACK 已经写在库里，把它发回即可。
      if (owner && owner.gameId === room.id) this.sendTo(owner.ws, record.ack as object);
      return;
    }
    room.revision = revisionAfter;
    room.seq = seq;
    room.state = nextState;
    // S02：房间推进后，之前排队的旧 revision AI 任务立刻作废，不再浪费算力。
    const dropped = this.aiHost.cancelUpTo(room.id, room.revision);
    if (dropped > 0) this.logAi({ event: 'ai_queue_cancelled_stale', roomId: room.id, dropped, revision: room.revision });
    this.broadcastRoom(room);
    const c = room.seats[seat].kind === 'human' && room.seats[seat].userId ? this.clients.get(room.seats[seat].userId!) : undefined;
    if (c && c.gameId === room.id) this.sendTo(c.ws, ack);
    if (nextState.status !== 'playing') {
      this.finishNormal(room);
      return;
    }
    void this.maybeRunAI(room);
  }

  /**
   * 第一方产品事件（规格 7.1）。失败绝不影响对局：事件是观测，不是权威状态。
   * source 为 HUMAN 只在“全部座位都是真人且账号来源都是 HUMAN”时成立，
   * 于是 AI 补位局与测试账号局不会混进真人留存口径。
   */
  private recordProductEvent(name: string, room: Room, payload: Record<string, unknown>): void {
    try {
      const humanUserIds = SEATS
        .map((s) => room.seats[s])
        .filter((s) => s.kind === 'human' && !!s.userId)
        .map((s) => s.userId as string);
      const anyAI = SEATS.some((s) => room.seats[s].kind !== 'human');
      const anyNonHumanAccount = humanUserIds.some((uid) => this.db.getUserSource(uid) !== 'HUMAN');
      this.db.insertProductEvent({
        eventId: name + ':' + room.id,
        name,
        userId: humanUserIds[0] ?? null,
        gameId: room.id,
        source: anyAI || anyNonHumanAccount ? 'SYNTHETIC' : 'HUMAN',
        isBot: anyAI,
        isSample: false,
        payload,
      });
    } catch (err) {
      console.error(JSON.stringify({ event: 'product_event_failed', name, roomId: room.id, error: err instanceof Error ? err.message : String(err), timestamp: Date.now() }));
    }
  }

  /** 房间快照：进程被强杀后据此重建房间（含座位归属与 revision/seq）。 */
  private buildRoomSnapshot(room: Room, state: GameState, revision = room.revision, seq = room.seq): RoomSnapshot {
    const seats = {} as RoomSnapshot['seats'];
    for (const s of SEATS) {
      const si = room.seats[s];
      seats[s] = si.kind === 'human'
        ? { kind: 'human', userId: si.userId ?? null, username: si.username ?? null }
        : { kind: 'ai', aiLevel: si.aiLevel ?? null, stars: si.stars ?? null };
    }
    return {
      state,
      mode: room.mode,
      boardSize: state.boardSize,
      seats,
      members: { ...room.members },
      policy: room.policy,
      revision,
      seq,
    };
  }

  /**
   * 进程重启后的恢复（P0B / G12）。
   *
   * 从最新快照重建房间，进入 RECOVERY_PAUSED，并开启 60 秒窗口：
   *  - 窗口内玩家回来（resume / queue.join）→ 恢复原 revision 继续下棋；
   *  - 窗口到期仍无人回来 → 按 SYSTEM_ABORT 结算，**全员 VOID、零竞技变更**
   *    （复用 P0A 的结算语义，不会因为“服务器重启”而扣任何人的分）。
   *
   * 返回恢复出来的对局数；由 server.ts 在启动时调用。
   */
  recover(): { recovered: number; gameIds: string[] } {
    const games = this.db.loadRecoverableGames();
    const recovered: string[] = [];
    for (const g of games) {
      if (this.rooms.has(g.gameId)) continue;
      const snap = g.snapshot as RoomSnapshot | null;
      if (!snap || !snap.state) continue;
      // 已经结束的局不需要恢复（其结果早已落库）。
      if (snap.state.status !== 'playing') continue;
      const room = this.rehydrateRoom(g.gameId, snap, g.revision, g.seq);
      this.rooms.set(room.id, room);
      this.db.openLiveGame(room.id, room.members);
      for (const uid of Object.keys(room.members)) this.userGame.set(uid, room.id);
      room.recoveryDeadlineAt = Date.now() + this.opts.recoveryGraceMs;
      room.recoveryTimer = setTimeout(() => this.expireRecovery(room), this.opts.recoveryGraceMs);
      room.recoveryTimer.unref?.();
      recovered.push(room.id);
      this.logMatchmaking('recovery_paused', {
        roomId: room.id, mode: room.mode, revision: room.revision,
        deadlineAt: room.recoveryDeadlineAt, humans: Object.keys(room.members).length,
      });
    }
    this.recoveredGameIds.push(...recovered);
    return { recovered: recovered.length, gameIds: recovered };
  }

  /**
   * 优雅停止：清掉所有定时器与内存房间，但**不写任何结算**。
   * 用于进程退出与测试中模拟“服务器没了但快照还在”的重启场景。
   * 注意：真实崩溃（SIGKILL）不会走这里，恢复能力完全依赖已落库的快照。
   */
  shutdown(): void {
    if (this.queueSweepTimer) clearInterval(this.queueSweepTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.queueWakeTimer) clearTimeout(this.queueWakeTimer);
    this.queueSweepTimer = null;
    this.heartbeatTimer = null;
    this.queueWakeTimer = null;
    for (const room of this.rooms.values()) {
      this.clearTurnClock(room);
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      room.disconnectTimers.clear();
      if (room.recoveryTimer) clearTimeout(room.recoveryTimer);
      room.recoveryTimer = undefined;
    }
    this.rooms.clear();
    this.userGame.clear();
    void this.aiHost.close();
    for (const id of [...this.clients.keys()]) this.matchmaking.leave(id);
    for (const c of this.clients.values()) {
      try { c.ws.close(1001, 'server shutdown'); } catch { /* noop */ }
    }
    this.clients.clear();
  }

  private rehydrateRoom(gameId: string, snap: RoomSnapshot, revision: number, seq: number): Room {
    const seats = {} as Record<Seat, SeatInfo>;
    for (const s of SEATS) {
      const raw = snap.seats?.[s];
      if (raw?.kind === 'human') {
        seats[s] = { kind: 'human', userId: raw.userId ?? undefined, username: raw.username ?? '?', conn: 'disconnected' };
      } else {
        seats[s] = { kind: 'ai', stars: raw?.stars ?? 3, aiLevel: raw?.aiLevel ?? 3 };
      }
    }
    return {
      id: gameId,
      mode: snap.mode,
      state: snap.state,
      seats,
      humanIds: new Set(),
      members: { ...snap.members },
      ended: false,
      running: false,
      phase: 'RECOVERY_PAUSED',
      disconnectTimers: new Map(),
      policy: snap.policy ?? null,
      revision,
      seq,
      commandQueue: Promise.resolve(),
    };
  }

  /** 恢复窗口到期：按 SYSTEM_ABORT 结算（全员 VOID，零竞技变更）。 */
  private expireRecovery(room: Room): void {
    if (room.ended || room.phase !== 'RECOVERY_PAUSED') return;
    this.logMatchmaking('recovery_expired', { roomId: room.id, revision: room.revision });
    this.finalizeRoom(room, {
      endReason: 'SYSTEM_ABORT',
      boardWinner: null,
      forfeitedSeats: [],
      inGraceSeats: [],
    });
  }

  /** 玩家在恢复窗口内回来了：解除暂停并重启落子时钟。 */
  private resumeFromRecovery(room: Room): void {
    if (room.phase !== 'RECOVERY_PAUSED') return;
    if (room.recoveryTimer) clearTimeout(room.recoveryTimer);
    room.recoveryTimer = undefined;
    room.recoveryDeadlineAt = undefined;
    room.phase = 'PLAYING';
    this.logMatchmaking('recovery_resumed', { roomId: room.id, revision: room.revision });
    this.ensureTurnClock(room);
  }

  private clearTurnClock(room: Room): void {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = undefined;
    room.turnDeadlineAt = undefined;
    room.timedTurnIndex = undefined;
  }

  private ensureTurnClock(room: Room): void {
    if (room.mode !== 'online' || room.ended || room.state.status !== 'playing') {
      this.clearTurnClock(room); return;
    }
    const actor = currentPlayerOf(room.state);
    // AI uses its existing bounded server search. Only humans have a move clock.
    if (room.seats[actor].kind !== 'human' || getLegalMoves(room.state).length === 0) {
      this.clearTurnClock(room); return;
    }
    if (room.timedTurnIndex === room.state.turnIndex && room.turnDeadlineAt) return;
    this.clearTurnClock(room);
    const turn = room.state.turnIndex;
    room.timedTurnIndex = turn;
    room.turnDeadlineAt = Date.now() + this.opts.turnTimeoutMs;
    room.turnTimer = setTimeout(() => {
      if (room.ended || room.mode !== 'online' || room.state.turnIndex !== turn) return;
      this.forfeitSeat(room, actor, 'TIMEOUT');
    }, this.opts.turnTimeoutMs);
    room.turnTimer.unref?.();
  }

  private broadcastRoom(room: Room): void {
    this.ensureTurnClock(room);
    const payload = JSON.stringify({
      type: 'game.state',
      state: room.state,
      seats: this.publicSeats(room),
      qualification: qualificationFromState(room.state),
      turnDeadlineAt: room.turnDeadlineAt ?? null,
      serverNow: Date.now(),
      revision: room.revision,
      seq: room.seq,
      phase: room.phase,
      protocol: { ...PROTOCOL_INFO },
    });
    for (const id of room.humanIds) {
      const c = this.clients.get(id);
      if (c?.gameId === room.id && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }

  /** 终局输入（服务器权威推导；客户端消息不携带任何胜负声明）。 */
  private buildPlan(room: Room, info: FinalizeInfo): SettlementPlan {
    const participants: SettlementParticipantInput[] = SEATS.map((s) => {
      const si = room.seats[s];
      return {
        seat: s,
        kind: si.kind,
        userId: si.userId ?? null,
        forfeited: info.forfeitedSeats.includes(s),
        inGrace: info.inGraceSeats.includes(s),
      };
    });
    const base = buildSettlement({
      gameId: room.id,
      mode: room.mode,
      boardSize: room.state.boardSize,
      status: room.state.status,
      boardWinner: info.boardWinner,
      endReason: info.endReason,
      isRanked: room.mode === 'online',
      participants,
    });
    return this.applyRatingPolicy(room, base);
  }

  /**
   * 按规格第 4 节决定本局的评分策略并改写参与者分差。
   *
   * 修复的实际缺陷：此前只要 mode 是 online 就算排位，于是 **1H+2AI 的快速局
   * 会给真人加/减竞技分** —— 与规格 4.1（快速人机不改真人竞技分）和 55 行
   * （快速对局标「不计真人排位」）直接冲突，也允许对着 AI 刷分。
   *
   * 现在：
   *   - AI 补位 / 好友局 / 不够 3 真人 / 本机模式 -> 策略 none，分差全 0，isRanked=false；
   *   - 恰好 3 真人且 beta 关闭 -> 过渡期保留 legacy +30/-10；
   *   - 恰好 3 真人且 beta 开启 -> 规格 4.2 的 V1 算法（按当前分值算 p_i）。
   */
  private applyRatingPolicy(room: Room, plan: SettlementPlan): SettlementPlan {
    const seatIsHuman = {} as Record<Seat, boolean>;
    const seatGatePassed = {} as Record<Seat, boolean>;
    const humanIds: string[] = [];
    for (const s of SEATS) {
      const si = room.seats[s];
      const isHuman = si.kind === 'human' && !!si.userId;
      seatIsHuman[s] = isHuman;
      if (isHuman) {
        humanIds.push(si.userId!);
        // 门禁口径：三步教学完成（老用户兼容，不要求重做）。邮箱验证暂无 transport，未纳入。
        seatGatePassed[s] = this.db.findUserById(si.userId!)?.tutorialCompleted === true;
      } else {
        seatGatePassed[s] = false;
      }
    }
    const humanParticipants = plan.participants.filter((p) => p.kind === 'human');
    const humanLosses = humanParticipants.filter((p) => p.outcome === 'LOSS').length;
    const noContest = plan.endReason === 'SYSTEM_ABORT'
      || (humanParticipants.length > 0 && humanLosses === humanParticipants.length);
    const sameTrioMatchNumber = humanIds.length === 3
      ? this.db.countRecentMatchesForUsers(humanIds, Date.now() - 24 * 3600 * 1000) + 1
      : 1;

    const policy = resolveRatingPolicy({
      mode: room.mode, seatIsHuman, seatGatePassed,
      ratingBeta: this.featureFlags.ratingBeta,
      noContest, sameTrioMatchNumber,
    });

    if (policy === NO_RATING_POLICY_ID) {
      this.logAi({ event: 'rating_policy_applied', roomId: room.id, policy, sameTrioMatchNumber, noContest });
      return {
        ...plan, isRanked: false, scorePolicy: NO_RATING_POLICY_ID,
        participants: plan.participants.map((p) => ({ ...p, ratingDelta: 0 })),
      };
    }

    if (policy === LEGACY_POLICY_ID) {
      return { ...plan, isRanked: true, scorePolicy: LEGACY_POLICY_ID };
    }

    // V1：需要当前分值，所以要读库。参与者顺序与 plan 一致。
    const targets = deriveScoreTargets(plan);
    const rated = humanParticipants
      .filter((p) => !!p.userId)
      .map((p) => ({
        seat: p.seat,
        userId: p.userId as string,
        rating: this.db.findUserById(p.userId as string)?.rating ?? RATING_INITIAL,
      }));
    const deltas = targets.updatesRating ? computeRatingDeltas(rated, targets) : [];
    const bySeat = new Map(deltas.map((d) => [d.seat, d]));
    this.logAi({
      event: 'rating_policy_applied', roomId: room.id, policy,
      reason: targets.reason, updatesRating: targets.updatesRating,
      deltas: deltas.map((d) => ({ seat: d.seat, delta: d.delta })),
    });
    return {
      ...plan,
      isRanked: targets.updatesRating,
      scorePolicy: BETA_V1_POLICY_ID,
      participants: plan.participants.map((p) => {
        const d = bySeat.get(p.seat);
        return { ...p, ratingDelta: d ? d.delta : 0 };
      }),
    };
  }

  /**
   * 原子持久化 + 有限重试。
   * 事务由 db.settleMatch 负责（BEGIN IMMEDIATE / COMMIT / ROLLBACK）；
   * 本方法只负责“失败了再来一次”，绝不吞掉异常后假装成功。
   */
  private persistSettlement(plan: SettlementPlan, room: Room): SettledMatch {
    const players = SEATS.map((s) => {
      const si = room.seats[s];
      return si.kind === 'human' && si.userId ? si.userId : null;
    });
    const movesJson = JSON.stringify(room.state.moves);
    let lastError: unknown = new Error('settlement not attempted');
    for (let attempt = 1; attempt <= this.settlementMaxAttempts; attempt++) {
      try {
        return this.db.settleMatch({ ...plan, matchId: randomUUID(), movesJson, players });
      } catch (err) {
        lastError = err;
        console.warn(JSON.stringify({
          event: 'settlement_attempt_failed', gameId: room.id, attempt,
          maxAttempts: this.settlementMaxAttempts,
          error: err instanceof Error ? err.message : String(err), timestamp: Date.now(),
        }));
      }
    }
    throw lastError;
  }

  /**
   * 终局唯一出口（P0A 重写）。
   *
   * 顺序被刻意固定为：**先原子落库 → 再改内存 → 最后广播**。
   *  - 事务失败并回滚 → 房间不置 ended、不清理、**不广播任何“已结算”消息**，可重试；
   *  - 事务成功 → 广播体完全由**已提交的行**构造，客户端看到的胜负与库里逐字一致；
   *  - 同一 gameId 重复提交 → 数据库 PRIMARY KEY 命中既有行，返回 alreadySettled，
   *    不再写任何统计/账本，广播沿用既有结果（幂等）。
   */
  private finalizeRoom(room: Room, info: FinalizeInfo): void {
    if (room.ended) return;
    const plan = this.buildPlan(room, info);
    let settled: SettledMatch;
    try {
      settled = this.persistSettlement(plan, room);
    } catch (err) {
      this.settlementFailures++;
      console.error(JSON.stringify({
        event: 'settlement_failed', gameId: room.id, reason: plan.endReason,
        attempts: this.settlementMaxAttempts,
        error: err instanceof Error ? err.message : String(err), timestamp: Date.now(),
      }));
      // 明确不广播成功：只告知可重试的错误，房间保持存活以便下一次终局触发重试。
      for (const uid of Object.keys(room.members)) {
        const c = this.clients.get(uid);
        if (c && c.gameId === room.id) {
          this.sendTo(c.ws, {
            type: 'error', error: 'settlement_failed', retryable: true, gameId: room.id,
          });
        }
      }
      return;
    }

    room.ended = true;
    room.phase = 'FINISHED';
    // 终局已结算：进行中记录退场，分享/分析改走已结算归属判定。
    this.db.closeLiveGame(room.id);
    // 规格 7.1：对局事实只由服务器写事件，客户端 UI 事件不能冒充。
    this.recordProductEvent('match_finish', room, {
      endReason: plan.endReason,
      winnerSeat: settled.winnerSeat,
      isRanked: settled.isRanked,
      moveCount: room.state.moves.length,
      boardSize: room.state.boardSize,
    });
    this.clearTurnClock(room);
    room.endReason = plan.endReason;
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    room.disconnectTimers.clear();

    const winnerSeats = settled.participants
      .filter((p) => p.kind === 'human' && p.outcome === 'WIN')
      .map((p) => p.seat as Seat);
    const loserSeats = settled.participants
      .filter((p) => p.kind === 'human' && p.outcome === 'LOSS')
      .map((p) => p.seat as Seat);
    const status = broadcastStatusFor(plan);
    const endPayload = {
      matchId: room.id,
      mode: room.mode,
      reason: settled.endReason,
      timestamp: settled.settledAt,
      winnerIds: settled.winnerUserIds,
      loserIds: settled.loserIds,
      winnerSeats,
      loserSeats,
      winnerSeat: settled.winnerSeat,
      alreadySettled: settled.alreadySettled,
      settlementDigest: settled.digest,
      participants: settled.participants.map((p) => ({
        seat: p.seat, kind: p.kind, outcome: p.outcome, ratingDelta: p.ratingDelta,
      })),
    };
    // 释放全部人类成员（含离场者），使其可以立即重新匹配。
    for (const [uid, seat] of Object.entries(room.members) as Array<[string, Seat]>) {
      const si = room.seats[seat];
      if (si.kind !== 'human') continue;
      const c = this.clients.get(uid);
      if (c && c.gameId === room.id && c.ws.readyState === WebSocket.OPEN) {
        this.sendTo(c.ws, { type: 'game.end', winner: settled.winnerSeat, status, ...endPayload });
        this.sendTo(c.ws, { type: 'MATCH_ENDED', status, winner: settled.winnerSeat, ...endPayload });
        c.gameId = undefined;
      }
      this.userGame.delete(uid);
      this.db.touchOnline(uid, this.clients.has(uid) ? 'online' : 'offline');
    }
    this.rooms.delete(room.id);
  }

  /**
   * 棋盘决胜终局。
   * 与旧实现的区别：平局不再走“没有真人胜者 → 全员记负”的分支；
   * AI 成四时获胜棋色被完整保留（winnerSeat 非空，winnerUserIds 可为空）。
   */
  private finishNormal(room: Room): void {
    if (room.ended) return;
    const st = room.state;
    const boardWinner: Seat | null = st.status === 'won' && st.winner ? (st.winner as Seat) : null;
    this.finalizeRoom(room, {
      endReason: st.status === 'draw' ? 'BOARD_DRAW' : 'NORMAL_WIN',
      boardWinner,
      forfeitedSeats: [],
      inGraceSeats: [],
    });
  }

  /**
   * 离场判负：PLAYER_FORFEIT（主动） / TIMEOUT / PLAYER_DISCONNECT（自身宽限到期）。
   *
   * 只有**已经越过自己截止时间**的座位记 LOSS。
   * 其他仍处于自身宽限期内的断线座位记 VOID —— 不被别人的超时提前连坐。
   */
  private forfeitSeat(room: Room, seat: Seat, reason: EndReason): void {
    if (room.ended || room.mode !== 'online') return;
    const si = room.seats[seat];
    if (!si || si.kind !== 'human' || !si.userId) return;
    const inGraceSeats: Seat[] = [];
    for (const s of SEATS) {
      if (s === seat) continue;
      const other = room.seats[s];
      if (other.kind === 'human' && other.conn === 'disconnected') inGraceSeats.push(s);
    }
    this.finalizeRoom(room, {
      endReason: reason,
      boardWinner: null,
      forfeitedSeats: [seat],
      inGraceSeats,
    });
  }

  /**
   * 编排中止（好友局全员离开、房间被放弃）→ SYSTEM_ABORT。
   * 旧实现完全不落盘；P0A 起写一条 end_reason='SYSTEM_ABORT' 的结果，
   * 全员 VOID，零竞技变更（不扣分、不计名次）。
   */
  private abortRoom(room: Room): void {
    if (room.ended) return;
    this.finalizeRoom(room, {
      endReason: 'SYSTEM_ABORT',
      boardWinner: null,
      forfeitedSeats: [],
      inGraceSeats: [],
    });
  }

  /** 在线判负宽限（DISCONNECTED_TEMPORARY → 超时 FORFEIT）：
   *  PLAYING → PLAYER_LEFT；宽限内 resume/重入 → 恢复 PLAYING；超时 → 判负 FINISHED。 */
  private beginLeaveGrace(room: Room, seat: Seat, userId: string): void {
    if (room.ended) return;
    const si = room.seats[seat];
    if (!si || si.kind !== 'human') return;
    si.conn = 'disconnected';
    if (room.phase === 'PLAYING') room.phase = 'PLAYER_LEFT';
    this.sendRoomEvent(room, { type: 'player.status', seat, status: 'disconnected', graceMs: this.opts.forfeitGraceMs });
    const timer = setTimeout(() => {
      room.disconnectTimers.delete(seat);
      if (room.ended) return;
      // 宽限内已恢复（resume/queue.join 自动恢复会清定时器）→ 不判负
      const c = this.clients.get(userId);
      if (c && c.gameId === room.id && room.humanIds.has(userId)) return;
      if (!room.humanIds.has(userId)) this.forfeitSeat(room, seat, 'PLAYER_DISCONNECT');
    }, this.opts.forfeitGraceMs);
    room.disconnectTimers.set(seat, timer);
    // 当前若轮到 AI 则继续推进；轮到离场者时等待重连或判负（AI 不替走）
    void this.maybeRunAI(room);
  }

  /** 恢复已存在对局（resume 消息 / queue.join 自动续局）；同时清除判负宽限定时器 */
  private resumeIntoRoom(room: Room, client: Client): void {
    if (room.ended) return;
    const seat = room.members[client.userId];
    if (!seat) return;
    client.gameId = room.id;
    this.userGame.set(client.userId, room.id);
    room.humanIds.add(client.userId);
    const si = room.seats[seat];
    if (si.kind === 'human') si.conn = 'connected';
    if (room.phase === 'RECOVERY_PAUSED') {
      // 玩家在 60 秒窗口内回来了：解除暂停，用快照里的 revision 继续，不重开一局。
      this.resumeFromRecovery(room);
    } else if (room.phase === 'PLAYER_LEFT' && !this.anyHumanAway(room)) room.phase = 'PLAYING';
    this.db.touchOnline(client.userId, 'playing');
    this.clearDisconnectTimer(room, seat);
    this.sendTo(client.ws, {
      type: 'game.start',
      gameId: room.id,
      mode: room.mode,
      seats: this.publicSeats(room),
      yourSeat: seat,
      state: room.state,
      qualification: qualificationFromState(room.state),
      turnDeadlineAt: room.turnDeadlineAt ?? null,
      serverNow: Date.now(),
      revision: room.revision,
      seq: room.seq,
      phase: room.phase,
      protocol: { ...PROTOCOL_INFO },
    });
    this.sendRoomEvent(room, { type: 'player.status', seat, status: 'reconnected' });
    void this.maybeRunAI(room);
  }

  /** 只发给「仍在房间且连接中」的真人（room.humanIds ∩ clients） */
  private sendRoomEvent(room: Room, payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    for (const id of room.humanIds) {
      const c = this.clients.get(id);
      if (c?.gameId === room.id && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  private onClose(client: Client): void {
    // 陈旧 socket（同一用户已建立新连接，如刷新/多标签）→ 不视为离场
    if (this.clients.get(client.userId) !== client) return;
    this.clients.delete(client.userId);
    this.leaveQueue(client);
    const gameId = client.gameId ?? this.userGame.get(client.userId);
    if (!gameId) {
      this.db.touchOnline(client.userId, 'offline');
      return;
    }
    const room = this.rooms.get(gameId);
    if (!room) {
      this.userGame.delete(client.userId);
      this.db.touchOnline(client.userId, 'offline');
      return;
    }
    room.humanIds.delete(client.userId);
    const seat = room.members[client.userId];
    this.db.touchOnline(client.userId, 'offline');
    if (!seat) return;
    if (room.mode === 'invite') {
      // 好友局：全员离开 → 中止；否则若该断线玩家一直不归，轮到他时周期性地自动跳过
      if (room.humanIds.size === 0) {
        this.abortRoom(room);
        return;
      }
      const userId = client.userId;
      const tick = (): void => {
        if (room.ended) return;
        if (this.clients.has(userId)) return; // 已重连（resume 路径会清定时器）
        if (currentPlayerOf(room.state) === seat) {
          // 断线弃权：即使有合法步也强制 Pass（引擎 forcePass）
          room.state = forcePass(room.state);
          this.broadcastRoom(room);
          room.disconnectTimers.delete(seat);
          if (room.state.status !== 'playing') this.finishNormal(room);
          else void this.maybeRunAI(room);
          return;
        }
        const next = setTimeout(tick, this.opts.disconnectSkipMs);
        room.disconnectTimers.set(seat, next);
      };
      const timer = setTimeout(tick, this.opts.disconnectSkipMs);
      room.disconnectTimers.set(seat, timer);
      // 断线后若轮到 AI 或其他人，继续推进
      void this.maybeRunAI(room);
      return;
    }
    // Online Match：浏览器关闭/刷新/tab 关闭/网络中断 → DISCONNECTED_TEMPORARY 宽限 → 超时判负
    this.beginLeaveGrace(room, seat, client.userId);
  }

  private leaveQueue(client: Client): void {
    const removed = this.matchmaking.leave(client.userId);
    if (removed) {
      this.sendTo(client.ws, { type: 'queue.left' });
      this.scheduleQueueWake();
      this.logMatchmaking('queue_leave', {
        queueId: removed.queueId, userId: removed.userId, humanCount: this.matchmaking.size,
        aiCount: Math.max(0, 3 - this.matchmaking.size), deadline: removed.deadlineAt,
      });
      const user = this.db.findUserById(client.userId);
      if (user && !this.userGame.has(client.userId)) this.db.touchOnline(client.userId, 'online');
    }
  }

  private logMatchmaking(event: string, fields: Record<string, unknown>): void {
    console.info(JSON.stringify({ event, ...fields, timestamp: Date.now() }));
  }

  /**
   * S07：撤销某用户的会话 → 立刻切断其 WebSocket 并清理在线状态。
   * 登出/改密后旧连接必须失效；对手会收到正常的掉线宽限流程，不会卡死。
   */
  revokeUserSession(userId: string, reason: 'LOGOUT' | 'PASSWORD_RESET'): void {
    const c = this.clients.get(userId);
    if (!c) return;
    this.sendTo(c.ws, { type: 'error', error: 'session revoked', code: 'SESSION_REVOKED', reason });
    try {
      c.ws.close(4003, 'session revoked');
    } catch {
      /* 连接可能已在关闭中 */
    }
    console.info(JSON.stringify({ event: 'ws_session_revoked', userId, reason, timestamp: Date.now() }));
  }

  private logAi(fields: Record<string, unknown>): void {
    console.info(JSON.stringify({ ...fields, timestamp: fields.timestamp ?? Date.now() }));
  }

  private clearDisconnectTimer(room: Room, seat: Seat): void {
    const t = room.disconnectTimers.get(seat);
    if (t) {
      clearTimeout(t);
      room.disconnectTimers.delete(seat);
    }
  }

  private sendTo(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
}
