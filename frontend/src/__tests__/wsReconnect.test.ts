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

  it('连接未就绪与排队中重连后都会重新向服务器入队，避免 0 秒永久停留', () => {
    gameLink.attach();
    gameLink.joinQueue();

    const first = FakeWebSocket.instances[0];
    expect(first.sent).toEqual([]);
    first.open();
    expect(first.sent.map((message) => JSON.parse(message))).toContainEqual({ type: 'queue.join' });

    first.message({ type: 'queue.joined', waiting: 1, timeoutMs: 250, queueStartAt: Date.now() });
    expect(gameLink.phase).toBe('queue');
    first.close();

    vi.advanceTimersByTime(1000);
    const reconnected = FakeWebSocket.instances[1];
    expect(reconnected).toBeTruthy();
    reconnected.open();
    expect(reconnected.sent.map((message) => JSON.parse(message))).toContainEqual({ type: 'queue.join' });
  });
});
