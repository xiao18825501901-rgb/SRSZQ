/** SRSZQ 前端 WebSocket 客户端（后端 ws://127.0.0.1:8081/ws） */
import { WS_URL, getToken } from './api';

export type WSHandler = (msg: Record<string, any>) => void;

export class SrszqSocket {
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
      if (!this.closed) setTimeout(() => this.connect(), 1000); // 自动重连
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

/** 单例连接（按需复用） */
let socket: SrszqSocket | null = null;
export function getSocket(): SrszqSocket {
  if (!socket) socket = new SrszqSocket();
  return socket;
}
