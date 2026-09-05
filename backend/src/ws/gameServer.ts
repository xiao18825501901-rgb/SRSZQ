/**
 * SRSZQ WebSocket 游戏服务 —— 服务器为唯一权威状态源。
 *
 * 职责：认证连接 / 匹配队列（60s 超时 AI 补位，权重 100/200/300/400/500）/
 * 房间（共享引擎校验每步）/ 广播 / 终局落盘与排行 / 断线重连 / 邀请对局。
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Db } from '../db.js';
import { createInitialState, applyMove, forcePass, skipCurrentPlayer } from '../../../shared/src/game/rules.js';
import type { GameState } from '../../../shared/src/game/types.js';
import { currentPlayerOf, getLegalMoves } from '../../../shared/src/game/legalMoves.js';
import { chooseAIMove } from '../../../shared/src/ai/chooseAIMove.js';
import type { AILevel } from '../../../shared/src/ai/types.js';
import { OFFLINE_LEVEL_CONFIG } from '../../../shared/src/ai/config/defaultWeights.js';

export type Seat = 'A' | 'B' | 'C';
const SEATS: Seat[] = ['A', 'B', 'C'];

interface SeatInfo {
  kind: 'human' | 'ai';
  userId?: string;
  username?: string;
  /** 客户端只见星级，不见真实档位 */
  stars?: number;
  aiLevel?: AILevel;
}

export interface GameServerOptions {
  queueTimeoutMs?: number; // 默认 60_000；测试可缩短
  aiMoveDelayMs?: number; // AI 落子模拟思考延迟
  disconnectSkipMs?: number; // 轮到断线玩家时多久自动跳过
  aiTimeBudgetMs?: number;
}

interface Client {
  ws: WebSocket;
  userId: string;
  username: string;
  gameId?: string;
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
  disconnectTimers: Map<Seat, ReturnType<typeof setTimeout>>;
}

const AI_WEIGHTS: Array<{ level: AILevel; w: number }> = [
  { level: 'random', w: 100 },
  { level: 'tactical', w: 200 },
  { level: 'selfish', w: 300 },
  { level: '3ply', w: 400 },
  { level: 'maxn', w: 500 },
];
const AI_STARS: Record<AILevel, number> = { random: 1, tactical: 2, selfish: 3, '3ply': 4, maxn: 5 };

function pickAiLevel(): AILevel {
  const total = AI_WEIGHTS.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const { level, w } of AI_WEIGHTS) {
    r -= w;
    if (r <= 0) return level;
  }
  return 'maxn';
}

export class GameServer {
  private db: Db;
  private opts: Required<GameServerOptions>;
  private wss: WebSocketServer;
  private clients = new Map<string, Client>();
  private queue: Client[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private rooms = new Map<string, Room>();
  private userGame = new Map<string, string>(); // userId -> gameId

  constructor(db: Db, opts: GameServerOptions = {}) {
    this.db = db;
    this.opts = {
      queueTimeoutMs: opts.queueTimeoutMs ?? 60_000,
      aiMoveDelayMs: opts.aiMoveDelayMs ?? 350,
      disconnectSkipMs: opts.disconnectSkipMs ?? 30_000,
      aiTimeBudgetMs: opts.aiTimeBudgetMs ?? 250,
    };
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** 挂到 HTTP server 的 upgrade 事件 */
  attach(httpServer: import('node:http').Server, path = '/'): void {
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
    });
  }

  private async onSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const session = token ? this.db.findSession(token) : null;
    const user = session && session.expiresAt >= Date.now() ? this.db.findUserById(session.userId) : null;
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
      ws.close(4001, 'unauthorized');
      return;
    }
    const client: Client = { ws, userId: user.id, username: user.username };
    this.clients.set(user.id, client);
    this.db.touchOnline(user.id, 'online');
    ws.send(JSON.stringify({ type: 'hello', user: { id: user.id, username: user.username, tutorialCompleted: user.tutorialCompleted } }));

    ws.on('message', (raw) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        this.sendTo(ws, { type: 'error', error: 'invalid json' });
        return;
      }
      void this.handleMessage(client, msg);
    });
    ws.on('close', () => this.onClose(client));
    ws.on('error', () => this.onClose(client));
  }

  private async handleMessage(client: Client, msg: { type?: string; [k: string]: unknown }): Promise<void> {
    const sendErr = (error: string) => this.sendTo(client.ws, { type: 'error', error });
    switch (msg.type) {
      case 'queue.join': {
        const user = this.db.findUserById(client.userId);
        if (!user?.tutorialCompleted) return sendErr('tutorial required');
        if (this.userGame.has(client.userId)) return sendErr('already in game');
        if (this.queue.some((c) => c.userId === client.userId)) return;
        this.db.touchOnline(client.userId, 'matching');
        this.queue.push(client);
        this.sendTo(client.ws, { type: 'queue.joined', waiting: this.queue.length });
        if (this.queueTimer === null) {
          this.queueTimer = setTimeout(() => this.flushQueue(true), this.opts.queueTimeoutMs);
        }
        if (this.queue.length >= 3) this.flushQueue(false);
        break;
      }
      case 'queue.leave': {
        this.leaveQueue(client);
        break;
      }
      case 'move': {
        const room = client.gameId ? this.rooms.get(client.gameId) : undefined;
        if (!room || room.ended) return sendErr('no active game');
        const seat = room.members[client.userId];
        if (!seat) return sendErr('not in game');
        if (currentPlayerOf(room.state) !== seat) return sendErr('not your turn');
        const row = Number(msg.row);
        const col = Number(msg.col);
        if (!Number.isInteger(row) || !Number.isInteger(col)) return sendErr('invalid move');
        await this.applyAndBroadcast(room, row, col);
        break;
      }
      case 'resume': {
        const gameId = String(msg.gameId ?? '');
        const room = this.rooms.get(gameId);
        if (!room || !room.members[client.userId]) return sendErr('no such game');
        client.gameId = gameId;
        this.userGame.set(client.userId, gameId);
        room.humanIds.add(client.userId);
        const seat = room.members[client.userId];
        this.db.touchOnline(client.userId, 'playing');
        this.sendTo(client.ws, { type: 'game.start', gameId, seats: this.publicSeats(room), yourSeat: seat, state: room.state });
        this.clearDisconnectTimer(room, seat);
        break;
      }
      default:
        sendErr('unknown message type');
    }
  }

  /** 匹配出队：满 3 立即开局；超时后 1-2 人由 AI 补位 */
  private flushQueue(timedOut: boolean): void {
    if (this.queueTimer !== null) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    const humans = this.queue.splice(0, this.queue.length);
    if (humans.length === 0) return;
    if (humans.length >= 3 || timedOut) {
      this.startRoom(humans.map((c) => c.userId));
    } else {
      // 理论不达：不足 3 人且未超时 → 放回队列等下一人
      this.queue.unshift(...humans);
      this.queueTimer = setTimeout(() => this.flushQueue(true), this.opts.queueTimeoutMs);
    }
  }

  /** 启动对局：真人按入队顺序占座，其余座位由 AI 补齐（权重 100..500） */
  private startRoom(humanIds: string[], mode: 'online' | 'invite' = 'online'): void {
    const live = humanIds.filter((id) => this.clients.has(id));
    const humans: SeatInfo[] = live.map((id) => {
      const u = this.db.findUserById(id);
      return { kind: 'human', userId: id, username: u?.username ?? '?' };
    });
    if (humans.length === 0) return;
    const seatInfos: SeatInfo[] = [...humans];
    while (seatInfos.length < 3) {
      const lvl = pickAiLevel();
      seatInfos.push({ kind: 'ai', stars: AI_STARS[lvl], aiLevel: lvl });
    }
    const room: Room = {
      id: randomUUID(),
      mode,
      state: createInitialState(13),
      seats: { A: seatInfos[0], B: seatInfos[1], C: seatInfos[2] },
      humanIds: new Set(humans.map((h) => h.userId!)),
      members: {},
      ended: false,
      running: false,
      disconnectTimers: new Map(),
    };
    for (let i = 0; i < humans.length; i++) {
      room.members[humans[i].userId!] = SEATS[i];
    }
    this.rooms.set(room.id, room);
    for (let i = 0; i < humans.length; i++) {
      const h = humans[i];
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
          yourSeat: SEATS[i],
          state: room.state,
        });
      }
    }
    void this.maybeRunAI(room);
  }

  /** 供邀请流程使用：两真人 + 1 AI 的非排位对局 */
  startInviteGame(userAId: string, userBId: string): void {
    const a = this.db.findUserById(userAId);
    const b = this.db.findUserById(userBId);
    if (!a || !b) return;
    this.startRoom([a.id, b.id], 'invite');
  }

  private publicSeats(room: Room): Record<Seat, { kind: string; username?: string; stars?: number }> {
    const out = {} as Record<Seat, { kind: string; username?: string; stars?: number }>;
    for (const s of SEATS) {
      const si = room.seats[s];
      out[s] = si.kind === 'human' ? { kind: 'human', username: si.username } : { kind: 'ai', stars: si.stars ?? 1 };
    }
    return out;
  }

  /** AI 座位链：轮到 AI 就（模拟思考后）用共享 AI 落子 */
  private async maybeRunAI(room: Room): Promise<void> {
    if (room.running) return;
    room.running = true;
    try {
      while (!room.ended && room.state.status === 'playing') {
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
        const decision = chooseAIMove(room.state, cur, seat.aiLevel, {
          seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
          timeBudgetMs: this.opts.aiTimeBudgetMs,
          maxDepth: OFFLINE_LEVEL_CONFIG[seat.aiLevel].maxDepth,
          candidateK: OFFLINE_LEVEL_CONFIG[seat.aiLevel].candidateK,
        });
        const res = applyMove(room.state, decision.row, decision.col);
        if (res.rejected) break;
        room.state = res.state;
        this.broadcastRoom(room);
        if (res.state.status !== 'playing') {
          this.finishRoom(room);
          return;
        }
      }
    } finally {
      room.running = false;
    }
  }

  private async applyAndBroadcast(room: Room, row: number, col: number): Promise<void> {
    if (room.ended) return;
    const res = applyMove(room.state, row, col);
    if (res.rejected) {
      for (const id of room.humanIds) {
        const c = this.clients.get(id);
        if (c) this.sendTo(c.ws, { type: 'error', error: `move rejected: ${res.rejected}` });
      }
      return;
    }
    room.state = res.state;
    this.broadcastRoom(room);
    if (res.state.status !== 'playing') {
      this.finishRoom(room);
      return;
    }
    void this.maybeRunAI(room);
  }

  private broadcastRoom(room: Room): void {
    const payload = JSON.stringify({ type: 'game.state', state: room.state, seats: this.publicSeats(room) });
    for (const id of room.humanIds) {
      const c = this.clients.get(id);
      if (c?.gameId === room.id && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }

  /** 终局：落盘 + 排行（仅 online 排位） + 通知 + 清理 */
  private finishRoom(room: Room): void {
    if (room.ended) return;
    room.ended = true;
    const st = room.state;
    const winner = st.status === 'won' ? st.winner : null;
    const createdAt = Date.now();
    this.db.saveGame({
      id: room.id,
      boardSize: st.boardSize,
      mode: room.mode,
      winner,
      movesJson: JSON.stringify(st.moves),
      createdAt,
    });
    const humanPlayers = SEATS.map((s) => {
      const si = room.seats[s];
      return si.kind === 'human' && si.userId ? si.userId : null;
    });
    this.db.saveMatch({ id: randomUUID(), gameId: room.id, players: humanPlayers, result: winner, isRanked: room.mode === 'online', createdAt });
    if (room.mode === 'online') {
      for (const uid of humanPlayers.filter((x): x is string => !!x)) {
        const delta = uid === winner ? 30 : -10;
        this.db.recordMatchResult(uid, delta);
      }
    }
    for (const id of [...room.humanIds]) {
      const c = this.clients.get(id);
      if (c) {
        this.sendTo(c.ws, { type: 'game.end', winner, status: st.status });
        c.gameId = undefined;
      }
      this.userGame.delete(id);
      this.db.touchOnline(id, 'online');
    }
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    room.disconnectTimers.clear();
    this.rooms.delete(room.id);
  }

  /** 全员离开：中止房间（不落盘、不计排行），释放用户 */
  private abortRoom(room: Room): void {
    if (room.ended) return;
    room.ended = true;
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    room.disconnectTimers.clear();
    for (const [uid] of Object.entries(room.members)) {
      this.userGame.delete(uid);
      const c = this.clients.get(uid);
      if (c) c.gameId = undefined;
      this.db.touchOnline(uid, 'online');
    }
    for (const id of [...room.humanIds]) {
      const c = this.clients.get(id);
      if (c) this.sendTo(c.ws, { type: 'game.end', status: 'aborted', winner: null });
    }
    this.rooms.delete(room.id);
  }

  private onClose(client: Client): void {
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
    // 全员离开 → 中止；否则若该断线玩家一直不归，轮到他时周期性地自动跳过
    if (room.humanIds.size === 0) {
      this.abortRoom(room);
      return;
    }
    if (seat) {
      const userId = client.userId;
      const tick = (): void => {
        if (room.ended) return;
        if (this.clients.has(userId)) return; // 已重连（resume 路径会清定时器）
        if (currentPlayerOf(room.state) === seat) {
          // 断线弃权：即使有合法步也强制 Pass（引擎 forcePass）
          room.state = forcePass(room.state);
          this.broadcastRoom(room);
          room.disconnectTimers.delete(seat);
          if (room.state.status !== 'playing') this.finishRoom(room);
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
    }
  }

  private leaveQueue(client: Client): void {
    const idx = this.queue.findIndex((c) => c.userId === client.userId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.sendTo(client.ws, { type: 'queue.left' });
      if (this.queue.length === 0 && this.queueTimer) {
        clearTimeout(this.queueTimer);
        this.queueTimer = null;
      } else if (this.queue.length > 0 && this.queueTimer === null) {
        this.queueTimer = setTimeout(() => this.flushQueue(true), this.opts.queueTimeoutMs);
      }
      const user = this.db.findUserById(client.userId);
      if (user && !this.userGame.has(client.userId)) this.db.touchOnline(client.userId, 'online');
    }
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
