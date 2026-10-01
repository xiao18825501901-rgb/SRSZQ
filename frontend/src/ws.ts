/** SRSZQ 前端 WebSocket 客户端（后端 ws://127.0.0.1:8081/ws） */
import { WS_URL, getToken, requestWsTicket } from './api';
import { colorName } from './playerPresentation';
import type { GameState, Player } from '../../shared/src/game/types';
import type { QualificationView } from '../../shared/src/game/qualification';
import { PROTOCOL_VERSION, RULESET_VERSION, WS_CLOSE_REPLACED, WS_TICKET_PROTOCOL_PREFIX } from '../../shared/src/product/protocol';
import { DEFAULT_QUEUE_TIMEOUT_MS } from '../../shared/src/product/queuePolicy';

export type WSHandler = (msg: Record<string, any>) => void;

/** 生成命令幂等键；环境没有 crypto.randomUUID 时退回时间戳+随机串。 */
function newCommandId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'cmd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

class SrszqSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<WSHandler>();
  private closed = false;
  /** 正在换票/建连：避免并发 connect() 建出两条连接。 */
  private connecting = false;
  onOpen: (() => void) | null = null;

  connect(): void {
    void this.connectAsync();
  }

  /**
   * S04：建立连接。
   *
   * 凭据来源按优先级：
   *   1) 老流程的 localStorage 令牌 -> 先用它换一张**一次性票据**，票据放在
   *      WebSocket 子协议头（`srszq.ticket.<hex>`）里 —— 会话密钥不再进 URL；
   *   2) 一键账号的 HttpOnly cookie -> 不需要任何 URL 凭据（服务端从 cookie 认会话）。
   * 两种情况下 URL 里都不含任何会话密钥。
   */
  private async connectAsync(): Promise<void> {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    this.closed = false;
    try {
      // O06：连接时显式声明协议/规则版本。服务端版本不一致会直接拒绝，而不是静默降级。
      const url = `${WS_URL}?protocol=${PROTOCOL_VERSION}&ruleset=${encodeURIComponent(RULESET_VERSION)}`;
      const token = getToken() ?? '';
      let protocols: string[] | undefined;
      if (token) {
        const ticket = await requestWsTicket();
        if (ticket) protocols = [WS_TICKET_PROTOCOL_PREFIX + ticket];
      }
      // 票据是异步换来的：期间可能已经有人调用 close()（例如登出/换号），此时不要再建连接。
      if (this.closed || this.ws) return;
      const ws = new WebSocket(url, protocols);
      this.ws = ws;
      this.attach(ws);
    } catch {
      // 换票失败（会话过期/网络问题）：不静默退回“把会话密钥写进 URL”的老做法，
      // 直接按连接失败处理，由上层决定重试或提示重新登录。
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    } finally {
      this.connecting = false;
    }
  }

  private attach(ws: WebSocket): void {
    ws.onmessage = (ev) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      for (const h of [...this.handlers]) h(msg);
    };
    ws.onopen = () => this.onOpen?.();
    ws.onclose = (ev) => {
      this.ws = null;
      // G16：被“同一账号的更新连接”替换时**不要重连**。
      // 否则两个标签页会互相顶号：A 重连 → 服务端关 B → B 重连 → 服务端关 A …… 无限抖动。
      if (ev && ev.code === WS_CLOSE_REPLACED) {
        this.closed = true;
        // 通知上层（GameLink）去改用户可见状态；socket 层不管 UI 状态。
        for (const h of [...this.handlers]) h({ type: 'connection.replaced' });
        return;
      }
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => {
      /* close 事件统一处理 */
    };
  }

  on(handler: WSHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}

let socket: SrszqSocket | null = null;
export function getSocket(): SrszqSocket {
  if (!socket) socket = new SrszqSocket();
  return socket;
}

/** 登出/换号：断开并重置全局游戏状态 */
export function resetSocket(): void {
  gameLink.detach();
  socket?.close();
  socket = null;
  gameLink.reset();
}

/* ------------------------------------------------------------------ */
/* GameLink —— 全局对局状态（登录后即连接；任意页面收到 game.start 都会
 * 进入游戏态，由 Platform 自动导航到 #/online 对局页）                */
/* ------------------------------------------------------------------ */
export interface SeatView {
  kind: 'human' | 'ai';
  username?: string;
  stars?: number;
}

export type GamePhase = 'idle' | 'queue' | 'game' | 'end';

export interface GameSnapshot {
  gameId: string;
  mode?: string;
  seats: Record<Player, SeatView>;
  mySeat: Player;
  state: GameState;
  /** BAC 资格时间线（服务器权威，随每次 game.state 广播更新） */
  qualification?: QualificationView | null;
  turnDeadlineAt?: number | null;
  serverNow?: number;
  /**
   * 开局前的计分预判（服务器在 game.start 里下发，规格 4.2「第 4 局起不计分且开局前提示」）。
   * 只用于显示；真正的结算结果以 MATCH_ENDED 的下发为准。
   */
  rating?: RatingPreviewWire | null;
}

/** 服务器 game.start 里的计分预判（与 shared 的 RatingPreview 同形，含 policy/reason）。 */
export interface RatingPreviewWire {
  ranked: boolean;
  policy: string;
  reason: string | null;
}

/** 本座位在服务器权威名次中的结果；VOID = 本局无竞技后果（不记胜负、不扣分）。 */
export type MyOutcome = 'WIN' | 'LOSS' | 'DRAW' | 'VOID';

/** 终局详情（来自服务器 MATCH_ENDED / game.end —— 胜负由服务器权威裁决） */
export interface EndInfo {
  status: string; // 'won' | 'draw' | 'forfeit' | 'aborted'
  /** NORMAL_WIN | BOARD_DRAW | PLAYER_FORFEIT | PLAYER_DISCONNECT | TIMEOUT | SYSTEM_ABORT */
  reason: string;
  winnerSeats: Player[];
  loserSeats: Player[];
  winnerIds: string[];
  loserIds: string[];
  /** 服务器写入数据库的获胜棋色（AI 获胜时非空，winnerIds 为空是正常情况） */
  winnerSeat: Player | null;
  /** 本座位的名次结果，直接取自服务器已提交的参与者行 */
  myOutcome: MyOutcome | null;
  /** 本次对本人的积分变化（VOID / 平局 / 非排位恒为 0） */
  myRatingDelta: number;
}

export interface SeatStatusEvent {
  seat: Player;
  status: 'disconnected' | 'reconnected';
  graceMs?: number;
  ts: number;
}

class GameLink {
  phase: GamePhase = 'idle';
  waiting = 0;
  // 服务器在 queue.joined / queue.state 里下发真实 timeoutMs 与 deadlineAt；这里只是收到消息前的兜底显示值。
  timeoutMs = DEFAULT_QUEUE_TIMEOUT_MS;
  queueId = '';
  enqueuedAt = 0;
  deadlineAt = 0;
  private serverOffsetMs = 0;
  error = '';
  game: GameSnapshot | null = null;
  result = '';
  endInfo: EndInfo | null = null;
  seatStatus: SeatStatusEvent | null = null;
  /**
   * P0B：服务器权威 revision。每次提交落子都必须带上“我看到的那个 revision”，
   * 服务器据此拒绝基于旧状态的命令；ACK / game.state 都会把它推进。
   */
  revision = 0;
  /** 已发出但还没被 ACK 的命令：用于幂等重发与状态核对。 */
  private pendingCommands = new Map<string, { row: number; col: number }>();
  /** 最近一次被服务器拒绝的命令码（供 UI 提示与诊断）。 */
  lastCommandError = '';
  private listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private wantsQueue = false;

  attach(): void {
    const sock = getSocket();
    sock.onOpen = () => {
      if (this.phase === 'game' && this.game?.gameId) {
        sock.send({ type: 'resume', gameId: this.game.gameId });
      } else if (this.phase === 'queue') {
        sock.send({ type: 'queue.sync' });
      } else if (this.wantsQueue) {
        sock.send({ type: 'queue.join' });
      }
    };
    if (!this.off) {
      this.off = sock.on((msg) => this.handle(msg));
    }
    sock.connect();
  }

  detach(): void {
    if (this.off) {
      this.off();
      this.off = null;
    }
    if (socket) socket.onOpen = null;
  }

  reset(): void {
    this.phase = 'idle';
    this.waiting = 0;
    this.error = '';
    this.game = null;
    this.result = '';
    this.endInfo = null;
    this.seatStatus = null;
    this.queueId = '';
    this.enqueuedAt = 0;
    this.deadlineAt = 0;
    this.serverOffsetMs = 0;
    this.wantsQueue = false;
    this.revision = 0;
    this.pendingCommands.clear();
    this.lastCommandError = '';
    this.emit();
  }

  private applyEnd(msg: Record<string, any>): void {
    this.phase = 'end';
    const mySeat = this.game?.mySeat;
    const rawParts = Array.isArray(msg.participants) ? (msg.participants as any[]) : [];
    const parts = rawParts as Array<{ seat: Player; outcome: MyOutcome; ratingDelta: number }>;
    const mine = mySeat ? parts.find((x) => x.seat === mySeat) : undefined;
    const myOutcome: MyOutcome | null = mine?.outcome ?? null;
    const myRatingDelta = mine?.ratingDelta ?? 0;
    const winnerSeats: Player[] = msg.winnerSeats ?? (msg.winner ? [msg.winner as Player] : []);
    const loserSeats: Player[] = msg.loserSeats ?? [];
    const reason = String(msg.reason ?? 'NORMAL_WIN');
    const winnerSeat = (msg.winnerSeat ?? msg.winner ?? null) as Player | null;
    const winnerLabel = winnerSeat ? colorName(winnerSeat) + '棋获胜' : 'AI 获胜';

    if (msg.status === 'aborted' || reason === 'SYSTEM_ABORT') {
      this.endInfo = {
        status: 'aborted',
        reason,
        winnerSeats: [],
        loserSeats: [],
        winnerIds: [],
        loserIds: [],
        winnerSeat: null,
        myOutcome: myOutcome ?? 'VOID',
        myRatingDelta,
      };
      this.result = '对局已中止（不计胜负）';
      return;
    }
    this.endInfo = {
      status: String(msg.status ?? 'won'),
      reason,
      winnerSeats,
      loserSeats,
      winnerIds: Array.isArray(msg.winnerIds) ? (msg.winnerIds as string[]) : [],
      loserIds: Array.isArray(msg.loserIds) ? (msg.loserIds as string[]) : [],
      winnerSeat,
      myOutcome,
      myRatingDelta,
    };
    // 文案一律以服务器**已提交**的名次为准；VOID 与 DRAW 都不得显示成失败。
    const iLost = myOutcome === 'LOSS' || (myOutcome === null && !!mySeat && loserSeats.includes(mySeat));
    const iWon = myOutcome === 'WIN' || (myOutcome === null && !!mySeat && winnerSeats.includes(mySeat));
    if (myOutcome === 'VOID') {
      this.result = '本局对你不计胜负';
    } else if (reason === 'BOARD_DRAW' || msg.status === 'draw' || myOutcome === 'DRAW') {
      this.result = '和棋（双方均不计负）';
    } else if (reason === 'TIMEOUT') {
      this.result = iLost ? '落子超时，本局判负' : '对手落子超时，你获胜';
    } else if (reason === 'PLAYER_DISCONNECT') {
      this.result = iLost ? '连接中断，本局判负' : '对手离线，你获胜';
    } else if (reason === 'PLAYER_FORFEIT') {
      this.result = iLost ? '你退出了对局，本局判负' : '对手退出，你获胜';
    } else if (iWon) {
      this.result = '你赢了';
    } else if (iLost) {
      this.result = winnerLabel;
    } else {
      this.result = winnerSeat ? winnerLabel : '对局结束';
    }
  }

  private handle(msg: Record<string, any>): void {
    switch (msg.type) {
      case 'queue.joined':
        this.wantsQueue = true;
        this.phase = 'queue';
        this.waiting = msg.waiting ?? 0;
        this.timeoutMs = msg.timeoutMs ?? this.timeoutMs;
        this.queueId = String(msg.queueId ?? '');
        this.enqueuedAt = Number(msg.enqueuedAt ?? msg.queueStartAt ?? Date.now());
        this.deadlineAt = Number(msg.deadlineAt ?? this.enqueuedAt + this.timeoutMs);
        this.serverOffsetMs = Number(msg.serverNow ?? Date.now()) - Date.now();
        this.error = '';
        break;
      case 'queue.state':
        if (msg.state === 'QUEUED') {
          this.phase = 'queue';
          this.waiting = msg.waiting ?? this.waiting;
          this.timeoutMs = msg.timeoutMs ?? this.timeoutMs;
          this.queueId = String(msg.queueId ?? this.queueId);
          this.enqueuedAt = Number(msg.enqueuedAt ?? this.enqueuedAt);
          this.deadlineAt = Number(msg.deadlineAt ?? this.deadlineAt);
          this.serverOffsetMs = Number(msg.serverNow ?? Date.now()) - Date.now();
          this.error = '';
        } else if (msg.state === 'NOT_QUEUED' && this.wantsQueue) {
          getSocket().send({ type: 'queue.join' });
        }
        break;
      // G16：本页连接被“同一账号的另一个标签页”替换掉了。
      // 明确告诉用户发生了什么，并且**不**自动重连（重连只会把对方顶掉，来回抖动）。
      case 'connection.replaced':
        this.phase = 'idle';
        this.wantsQueue = false;
        this.error = '这个账号已在另一个标签页打开，本页连接已断开。';
        break;
      case 'error':
        this.error = String(msg.error ?? 'unknown');
        // Rolling-deploy compatibility: an older server does not know queue.sync.
        if (this.error === 'unknown message type' && this.wantsQueue) getSocket().send({ type: 'queue.join' });
        break;
      case 'game.start': {
        this.wantsQueue = false;
        this.phase = 'game';
        this.revision = Number(msg.revision ?? 0);
        this.pendingCommands.clear();
        this.lastCommandError = '';
        this.game = {
          gameId: String(msg.gameId),
          mode: String(msg.mode ?? ''),
          seats: msg.seats as Record<Player, SeatView>,
          mySeat: msg.yourSeat as Player,
          state: msg.state as GameState,
          qualification: msg.qualification as QualificationView | undefined,
          turnDeadlineAt: msg.turnDeadlineAt ?? null,
          serverNow: msg.serverNow ?? Date.now(),
          rating: (msg.rating as RatingPreviewWire | undefined) ?? null,
        };
        this.serverOffsetMs = Number(msg.serverNow ?? Date.now()) - Date.now();
        this.result = '';
        this.error = '';
        this.endInfo = null;
        break;
      }
      case 'game.state':
        this.serverOffsetMs = Number(msg.serverNow ?? Date.now()) - Date.now();
        if (typeof msg.revision === 'number' && msg.revision > this.revision) this.revision = msg.revision;
        if (this.game)
          this.game = {
            ...this.game,
            state: msg.state as GameState,
            qualification: (msg.qualification as QualificationView | undefined) ?? this.game.qualification,
            turnDeadlineAt: msg.turnDeadlineAt ?? null,
            serverNow: msg.serverNow ?? Date.now(),
          };
        break;
      case 'ack': {
        // 服务器确认这条命令已生效（并且已经落库）。清掉待确认记录。
        this.pendingCommands.delete(String(msg.commandId ?? ''));
        if (typeof msg.revision === 'number' && msg.revision > this.revision) this.revision = msg.revision;
        this.lastCommandError = '';
        break;
      }
      case 'command.rejected': {
        const code = String(msg.code ?? '');
        this.pendingCommands.delete(String(msg.commandId ?? ''));
        this.lastCommandError = code;
        if (typeof msg.revision === 'number' && msg.revision > this.revision) this.revision = msg.revision;
        if (code === 'STALE_REVISION') {
          // 我们基于旧状态提交：不重试，直接拉回服务器权威状态。
          this.error = '棋局已推进，正在同步最新状态…';
          if (this.game?.gameId) getSocket().send({ type: 'resume', gameId: this.game.gameId });
        } else if (code === 'IDEMPOTENCY_CONFLICT') {
          this.error = '检测到重复的命令编号，本次操作已被忽略';
          if (this.game?.gameId) getSocket().send({ type: 'resume', gameId: this.game.gameId });
        } else if (code === 'RECOVERY_PAUSED') {
          this.error = '对局正在恢复中，请稍候…';
        } else {
          this.error = String(msg.error ?? code);
        }
        this.emit();
        break;
      }
      case 'game.end':
      case 'MATCH_ENDED':
        this.applyEnd(msg);
        break;
      case 'player.status':
        this.seatStatus = { seat: msg.seat as Player, status: msg.status as 'disconnected' | 'reconnected', graceMs: msg.graceMs, ts: Date.now() };
        break;
      default:
        return;
    }
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  joinQueue(): void {
    this.wantsQueue = true;
    getSocket().send({ type: 'queue.join' });
  }

  leaveQueue(): void {
    this.wantsQueue = false;
    getSocket().send({ type: 'queue.leave' });
  }

  syncQueue(): void {
    if (!this.wantsQueue && this.phase !== 'queue') return;
    getSocket().send({ type: 'queue.sync' });
  }

  /** 主动离开 Online Match：服务器立即判负并终局（PLAYER_RESIGN） */
  resign(): void {
    getSocket().send({ type: 'PLAYER_RESIGN' });
  }

  move(row: number, col: number): void {
    // P0B 命令信封：commandId 是幂等键，expectedRevision 是乐观并发控制。
    // 断线重连/ACK 丢失后重发同一个 commandId，服务器只会回放既有结果，
    // 不会二次落子，也不会重置 30 秒落子时钟。
    const commandId = newCommandId();
    this.pendingCommands.set(commandId, { row, col });
    getSocket().send({
      type: 'move',
      commandId,
      expectedRevision: this.revision,
      row,
      col,
    });
  }

  turnRemainingMs(): number | null {
    const deadline = this.game?.turnDeadlineAt;
    return deadline ? Math.max(0, deadline - (Date.now() + this.serverOffsetMs)) : null;
  }

  leaveInvite(): void { getSocket().send({ type: 'invite.leave' }); }

  remainingMs(): number {
    if (this.phase !== 'queue' || !this.deadlineAt) return this.timeoutMs;
    return Math.max(0, this.deadlineAt - (Date.now() + this.serverOffsetMs));
  }

  pastDeadlineMs(): number {
    if (this.phase !== 'queue' || !this.deadlineAt) return 0;
    return Math.max(0, Date.now() + this.serverOffsetMs - this.deadlineAt);
  }
}

export const gameLink = new GameLink();
