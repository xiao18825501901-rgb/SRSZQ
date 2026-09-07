/** SRSZQ 前端 WebSocket 客户端（后端 ws://127.0.0.1:8081/ws） */
import { WS_URL, getToken } from './api';
import type { GameState, Player } from '../../shared/src/game/types';
import type { QualificationView } from '../../shared/src/game/qualification';

export type WSHandler = (msg: Record<string, any>) => void;

class SrszqSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<WSHandler>();
  private closed = false;
  onOpen: (() => void) | null = null;

  connect(): void {
    if (this.ws) return;
    this.closed = false;
    this.ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(getToken() ?? '')}`);
    this.ws.onmessage = (ev) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      for (const h of [...this.handlers]) h(msg);
    };
    this.ws.onopen = () => this.onOpen?.();
    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
    this.ws.onerror = () => {
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
}

/** 终局详情（来自服务器 MATCH_ENDED / game.end —— 胜负由服务器权威裁决） */
export interface EndInfo {
  status: string; // 'won' | 'draw' | 'forfeit' | 'aborted'
  reason: string; // NORMAL_WIN | PLAYER_FORFEIT | PLAYER_DISCONNECT | TIMEOUT
  winnerSeats: Player[];
  loserSeats: Player[];
  winnerIds: string[];
  loserIds: string[];
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
  timeoutMs = 60_000;
  queueId = '';
  enqueuedAt = 0;
  deadlineAt = 0;
  private serverOffsetMs = 0;
  error = '';
  game: GameSnapshot | null = null;
  result = '';
  endInfo: EndInfo | null = null;
  seatStatus: SeatStatusEvent | null = null;
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
    this.emit();
  }

  private applyEnd(msg: Record<string, any>): void {
    this.phase = 'end';
    if (msg.status === 'aborted') {
      this.endInfo = {
        status: 'aborted',
        reason: msg.reason ?? 'ABORTED',
        winnerSeats: msg.winnerSeats ?? [],
        loserSeats: msg.loserSeats ?? [],
        winnerIds: msg.winnerIds ?? [],
        loserIds: msg.loserIds ?? [],
      };
      this.result = '对局已中止（玩家离开）';
      return;
    }
    const winnerSeats: Player[] = msg.winnerSeats ?? (msg.winner ? [msg.winner as Player] : []);
    const loserSeats: Player[] = msg.loserSeats ?? [];
    this.endInfo = {
      status: String(msg.status ?? 'won'),
      reason: String(msg.reason ?? 'NORMAL_WIN'),
      winnerSeats,
      loserSeats,
      winnerIds: Array.isArray(msg.winnerIds) ? (msg.winnerIds as string[]) : [],
      loserIds: Array.isArray(msg.loserIds) ? (msg.loserIds as string[]) : [],
    };
    // 兜底文案（具体结算文案由对局页按 reason/座位组合）
    const mySeat = this.game?.mySeat;
    const iLost = mySeat ? loserSeats.includes(mySeat) : false;
    const iWon = mySeat ? winnerSeats.includes(mySeat) : false;
    const isLeaveEnd = msg.reason === 'PLAYER_FORFEIT' || msg.reason === 'PLAYER_DISCONNECT';
    if (isLeaveEnd) {
      this.result = iLost ? 'You left the match. Result: Loss' : 'Opponent left. You win!';
    } else if (msg.status === 'draw') {
      this.result = '和棋';
    } else if (iWon) {
      this.result = '你赢了';
    } else if (iLost) {
      this.result = winnerSeats.length > 0 ? `玩家 ${winnerSeats[0]} 获胜` : 'AI 获胜';
    } else {
      this.result = msg.winner ? `玩家 ${msg.winner} 获胜` : '和棋';
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
      case 'error':
        this.error = String(msg.error ?? 'unknown');
        // Rolling-deploy compatibility: an older server does not know queue.sync.
        if (this.error === 'unknown message type' && this.wantsQueue) getSocket().send({ type: 'queue.join' });
        break;
      case 'game.start': {
        this.wantsQueue = false;
        this.phase = 'game';
        this.game = {
          gameId: String(msg.gameId),
          mode: String(msg.mode ?? ''),
          seats: msg.seats as Record<Player, SeatView>,
          mySeat: msg.yourSeat as Player,
          state: msg.state as GameState,
          qualification: msg.qualification as QualificationView | undefined,
        };
        this.result = '';
        this.error = '';
        this.endInfo = null;
        break;
      }
      case 'game.state':
        if (this.game)
          this.game = {
            ...this.game,
            state: msg.state as GameState,
            qualification: (msg.qualification as QualificationView | undefined) ?? this.game.qualification,
          };
        break;
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
    getSocket().send({ type: 'move', row, col });
  }

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
