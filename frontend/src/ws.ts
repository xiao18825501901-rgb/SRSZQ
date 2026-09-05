/** SRSZQ 前端 WebSocket 客户端（后端 ws://127.0.0.1:8081/ws） */
import { WS_URL, getToken } from './api';
import type { GameState, Player } from '../../shared/src/game/types';

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
}

class GameLink {
  phase: GamePhase = 'idle';
  waiting = 0;
  timeoutMs = 60_000;
  queueStartAt = 0;
  error = '';
  game: GameSnapshot | null = null;
  result = '';
  private listeners = new Set<() => void>();
  private off: (() => void) | null = null;

  attach(): void {
    const sock = getSocket();
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
  }

  reset(): void {
    this.phase = 'idle';
    this.waiting = 0;
    this.error = '';
    this.game = null;
    this.result = '';
    this.queueStartAt = 0;
    this.emit();
  }

  private handle(msg: Record<string, any>): void {
    switch (msg.type) {
      case 'queue.joined':
        this.phase = 'queue';
        this.waiting = msg.waiting ?? 0;
        this.timeoutMs = msg.timeoutMs ?? this.timeoutMs;
        this.queueStartAt = msg.queueStartAt ?? Date.now();
        this.error = '';
        break;
      case 'error':
        this.error = String(msg.error ?? 'unknown');
        break;
      case 'game.start': {
        this.phase = 'game';
        this.game = {
          gameId: String(msg.gameId),
          mode: String(msg.mode ?? ''),
          seats: msg.seats as Record<Player, SeatView>,
          mySeat: msg.yourSeat as Player,
          state: msg.state as GameState,
        };
        this.result = '';
        this.error = '';
        break;
      }
      case 'game.state':
        if (this.game) this.game = { ...this.game, state: msg.state as GameState };
        break;
      case 'game.end': {
        this.phase = 'end';
        this.result = msg.status === 'aborted' ? '对局已中止（玩家离开）' : msg.winner ? `玩家 ${msg.winner} 获胜` : '和棋';
        break;
      }
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
    getSocket().send({ type: 'queue.join' });
  }

  leaveQueue(): void {
    getSocket().send({ type: 'queue.leave' });
  }

  move(row: number, col: number): void {
    getSocket().send({ type: 'move', row, col });
  }

  remainingMs(): number {
    if (this.phase !== 'queue' || !this.queueStartAt) return this.timeoutMs;
    return Math.max(0, this.queueStartAt + this.timeoutMs - Date.now());
  }
}

export const gameLink = new GameLink();
