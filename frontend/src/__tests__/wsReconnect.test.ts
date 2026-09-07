import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameLink, resetSocket } from '../ws';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('Online Match WebSocket 恢复', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'srszq_token' ? 'test-token' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  afterEach(() => {
    resetSocket();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('初次连接入队，排队重连后查询权威状态', () => {
    gameLink.attach();
    gameLink.joinQueue();

    const first = FakeWebSocket.instances[0];
    expect(first.sent).toEqual([]);
    first.open();
    expect(first.sent.map((message) => JSON.parse(message))).toContainEqual({ type: 'queue.join' });

    first.message({ type: 'queue.joined', queueId: 'q1', waiting: 1, timeoutMs: 250, enqueuedAt: Date.now(), deadlineAt: Date.now() + 250, serverNow: Date.now() });
    expect(gameLink.phase).toBe('queue');
    first.close();

    vi.advanceTimersByTime(1000);
    const reconnected = FakeWebSocket.instances[1];
    expect(reconnected).toBeTruthy();
    reconnected.open();
    expect(reconnected.sent.map((message) => JSON.parse(message))).toContainEqual({ type: 'queue.sync' });
  });

  it('丢失首次 game.start 后，queue.state MATCHED + 重发快照仍进入棋局', () => {
    gameLink.attach();
    gameLink.joinQueue();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ type: 'queue.joined', queueId: 'q2', waiting: 1, timeoutMs: 50, enqueuedAt: 0, deadlineAt: 50, serverNow: 0 });

    gameLink.syncQueue();
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({ type: 'queue.sync' });
    socket.message({ type: 'queue.state', state: 'MATCHED', gameId: 'room-1', serverNow: 100 });
    socket.message({
      type: 'game.start', gameId: 'room-1', mode: 'online', yourSeat: 'A',
      seats: { A: { kind: 'human', username: 'QA' }, B: { kind: 'ai', stars: 3 }, C: { kind: 'ai', stars: 4 } },
      state: { boardSize: 13, board: Array.from({ length: 13 }, () => Array(13).fill(null)), turnIndex: 0, moves: [], status: 'playing', winner: null, winLine: null },
    });
    expect(gameLink.phase).toBe('game');
    expect(gameLink.game?.gameId).toBe('room-1');
  });
});
