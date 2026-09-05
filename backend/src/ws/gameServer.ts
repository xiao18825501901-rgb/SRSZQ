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
import { qualificationFromState } from '../../../shared/src/game/qualification.js';
import { chooseAIMove } from '../../../shared/src/ai/chooseAIMove.js';
import type { AILevel } from '../../../shared/src/ai/types.js';
import { OFFLINE_LEVEL_CONFIG } from '../../../shared/src/ai/config/defaultWeights.js';

export type Seat = 'A' | 'B' | 'C';
const SEATS: Seat[] = ['A', 'B', 'C'];

/**
 * 终局原因（matches.end_reason / MATCH_ENDED.reason）：
 * - NORMAL_WIN        正常终局：有人连成四（或满盘平局）
 * - PLAYER_FORFEIT    玩家主动 Leave（PLAYER_RESIGN）→ 立即判负
 * - PLAYER_DISCONNECT 掉线超过宽限期（DISCONNECTED_TEMPORARY → FORFEIT）
 * - TIMEOUT           保留：未来回合时钟超时
 */
export type EndReason = 'NORMAL_WIN' | 'PLAYER_FORFEIT' | 'PLAYER_DISCONNECT' | 'TIMEOUT';

/** 房间内真人座位的连接状态（Online 判负状态机用） */
type SeatConn = 'connected' | 'disconnected' | 'left';
/** 房间阶段：PLAYING → PLAYER_LEFT(宽限) → FINISHED */
type RoomPhase = 'PLAYING' | 'PLAYER_LEFT' | 'FINISHED';

interface SeatInfo {
  kind: 'human' | 'ai';
  userId?: string;
  username?: string;
  /** 客户端只见星级，不见真实档位 */
  stars?: number;
  aiLevel?: AILevel;
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
  phase: RoomPhase;
  endReason?: EndReason;
  disconnectTimers: Map<Seat, ReturnType<typeof setTimeout>>; // online=判负宽限；invite=自动跳过
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

/** 邀请会话（好友开房状态机） */
interface InviteSession {
  sender: string;
  targets: Map<string, 'pending' | 'accepted' | 'rejected'>;
  timer?: ReturnType<typeof setTimeout>;
  started: boolean;
}

export class GameServer {
  private db: Db;
  private opts: Required<GameServerOptions>;
  private wss: WebSocketServer;
  private clients = new Map<string, Client>();
  private queue: Client[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private queueStartAt = 0;
  private rooms = new Map<string, Room>();
  private userGame = new Map<string, string>(); // userId -> gameId
  private inviteSessions = new Map<string, InviteSession>();

  constructor(db: Db, opts: GameServerOptions = {}) {
    this.db = db;
    this.opts = {
      queueTimeoutMs: opts.queueTimeoutMs ?? 60_000,
      aiMoveDelayMs: opts.aiMoveDelayMs ?? 350,
      disconnectSkipMs: opts.disconnectSkipMs ?? 30_000,
      aiTimeBudgetMs: opts.aiTimeBudgetMs ?? 250,
      inviteGatherMs: opts.inviteGatherMs ?? 30_000,
      forfeitGraceMs: opts.forfeitGraceMs ?? 10_000,
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
        const existing = this.userGame.get(client.userId);
        if (existing) {
          const room = this.rooms.get(existing);
          if (room && !room.ended && room.members[client.userId]) {
            if (room.humanIds.has(client.userId)) {
              // 连接仍在房间（如好友局离开页面后再进匹配页）→ 与旧版一致：禁止重复匹配
              return sendErr('already in game');
            }
            // 掉线/刷新后回到匹配页：原对局仍在宽限期 → 自动恢复，不判负
            this.resumeIntoRoom(room, client);
            return;
          }
          // 残留绑定（房间已清理）→ 释放后可正常重新匹配
          this.userGame.delete(client.userId);
        }
        if (this.queue.some((c) => c.userId === client.userId)) return;
        this.db.touchOnline(client.userId, 'matching');
        this.queue.push(client);
        const first = this.queueTimer === null;
        if (first) {
          this.queueStartAt = Date.now();
          this.queueTimer = setTimeout(() => this.flushQueue(true), this.opts.queueTimeoutMs);
        }
        this.sendTo(client.ws, {
          type: 'queue.joined',
          waiting: this.queue.length,
          timeoutMs: this.opts.queueTimeoutMs,
          queueStartAt: this.queueStartAt,
        });
        if (this.queue.length >= 3) this.flushQueue(false);
        break;
      }
      case 'queue.leave': {
        this.leaveQueue(client);
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

  /** 匹配出队：满 3 立即开局；超时后 1-2 人由 AI 补位 */
  private flushQueue(timedOut: boolean): void {
    if (this.queueTimer !== null) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    const humans = this.queue.splice(0, this.queue.length);
    this.queueStartAt = 0;
    if (humans.length === 0) return;
    if (humans.length >= 3 || timedOut) {
      // 1 人 → H+AI+AI；2 人 → H+H+AI（startRoom 内补齐）；0 人不会到这里
      this.startRoom(humans.map((c) => c.userId));
    } else {
      // 理论不达：不足 3 人且未超时 → 放回队列等下一人
      this.queue.unshift(...humans);
      this.queueStartAt = Date.now();
      this.queueTimer = setTimeout(() => this.flushQueue(true), this.opts.queueTimeoutMs);
    }
  }

  /** 启动对局：真人按入队顺序占座，其余座位由 AI 补齐（权重 100..500） */
  private startRoom(humanIds: string[], mode: 'online' | 'invite' = 'online'): void {
    const live = humanIds.filter((id) => this.clients.has(id));
    const humans: SeatInfo[] = live.map((id) => {
      const u = this.db.findUserById(id);
      return { kind: 'human', userId: id, username: u?.username ?? '?', conn: 'connected' };
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
      phase: 'PLAYING',
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
          qualification: qualificationFromState(room.state),
        });
      }
    }
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
          this.finishNormal(room);
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
      this.finishNormal(room);
      return;
    }
    void this.maybeRunAI(room);
  }

  private broadcastRoom(room: Room): void {
    const payload = JSON.stringify({
      type: 'game.state',
      state: room.state,
      seats: this.publicSeats(room),
      qualification: qualificationFromState(room.state),
    });
    for (const id of room.humanIds) {
      const c = this.clients.get(id);
      if (c?.gameId === room.id && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }

  /**
   * 终局唯一出口：落盘（games/matches 含 endReason/winnerIds/loserIds）+ 排行
   * （仅 online 排位：败者 -10、胜者 +30）+ MATCH_ENDED/game.end 广播 + 房间清理。
   * 胜/败集合全部由服务器按 seats/members 推导，客户端消息不携带任何胜负声明。
   */
  private finalizeRoom(
    room: Room,
    info: {
      winnerSeat: Seat | null; // games.winner / matches.result（座位，单胜者时）
      winnerIds: string[]; // 人类胜者 userId
      loserIds: string[]; // 人类败者 userId
      reason: EndReason;
      status: 'won' | 'draw' | 'forfeit';
    },
  ): void {
    if (room.ended) return;
    room.ended = true;
    room.phase = 'FINISHED';
    room.endReason = info.reason;
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    room.disconnectTimers.clear();
    const st = room.state;
    const createdAt = Date.now();
    this.db.saveGame({
      id: room.id,
      boardSize: st.boardSize,
      mode: room.mode,
      winner: info.winnerSeat,
      movesJson: JSON.stringify(st.moves),
      createdAt,
    });
    const humanPlayers = SEATS.map((s) => {
      const si = room.seats[s];
      return si.kind === 'human' && si.userId ? si.userId : null;
    });
    this.db.saveMatch({
      id: randomUUID(),
      gameId: room.id,
      players: humanPlayers,
      result: info.winnerSeat,
      isRanked: room.mode === 'online',
      createdAt,
      endReason: info.reason,
      winnerIds: info.winnerIds,
      loserIds: info.loserIds,
    });
    if (room.mode === 'online') {
      for (const uid of info.loserIds) this.db.recordMatchResult(uid, -10);
      for (const uid of info.winnerIds) this.db.recordMatchResult(uid, 30);
    }
    const winnerSeats = info.winnerIds.map((uid) => room.members[uid]).filter((s): s is Seat => !!s);
    const loserSeats = info.loserIds.map((uid) => room.members[uid]).filter((s): s is Seat => !!s);
    const endPayload = {
      matchId: room.id,
      mode: room.mode,
      reason: info.reason,
      timestamp: createdAt,
      winnerIds: info.winnerIds,
      loserIds: info.loserIds,
      winnerSeats,
      loserSeats,
    };
    // 释放全部人类成员（含离场/宽限期者）→ 可立即重新匹配
    for (const [uid, seat] of Object.entries(room.members) as Array<[string, Seat]>) {
      const si = room.seats[seat];
      if (si.kind !== 'human') continue;
      const c = this.clients.get(uid);
      if (c && c.gameId === room.id && c.ws.readyState === WebSocket.OPEN) {
        this.sendTo(c.ws, { type: 'game.end', winner: info.winnerSeat, status: info.status, ...endPayload });
        this.sendTo(c.ws, { type: 'MATCH_ENDED', ...endPayload });
        c.gameId = undefined;
      }
      this.userGame.delete(uid);
      this.db.touchOnline(uid, this.clients.has(uid) ? 'online' : 'offline');
    }
    this.rooms.delete(room.id);
  }

  /** 正常终局：连成四 / 满盘平局（NORMAL_WIN）。AI 座位获胜时无人类胜者。 */
  private finishNormal(room: Room): void {
    if (room.ended) return;
    const st = room.state;
    const wSeat: Seat | null = st.status === 'won' && st.winner ? (st.winner as Seat) : null;
    const winnerIsHuman = !!wSeat && room.seats[wSeat].kind === 'human';
    const humanSeats = SEATS.filter((s) => room.seats[s].kind === 'human');
    const loserSeats = humanSeats.filter((s) => !winnerIsHuman || s !== wSeat);
    const winnerSeat = winnerIsHuman ? wSeat : null;
    this.finalizeRoom(room, {
      winnerSeat,
      winnerIds: winnerSeat && room.seats[winnerSeat].userId ? [room.seats[winnerSeat].userId!] : [],
      loserIds: loserSeats.map((s) => room.seats[s].userId!).filter((x): x is string => !!x),
      reason: 'NORMAL_WIN',
      status: st.status === 'won' ? 'won' : 'draw',
    });
  }

  /** 离场判负：PLAYER_RESIGN（主动离开）或掉线宽限到期 → 立即结算，AI 不继续。
   *  败者 = 离开者 + 仍在宽限期内的其他离场人类；胜者 = 其余（在场）人类座位。
   *  （1H+2AI 人类离场时无人获胜，仅记离场者败。） */
  private forfeitSeat(room: Room, seat: Seat, reason: EndReason): void {
    if (room.ended || room.mode !== 'online') return;
    const si = room.seats[seat];
    if (!si || si.kind !== 'human' || !si.userId) return;
    si.conn = 'left';
    if (room.phase !== 'FINISHED') room.phase = 'PLAYER_LEFT';
    const loserSeats = SEATS.filter(
      (s) => room.seats[s].kind === 'human' && (s === seat || room.seats[s].conn === 'disconnected'),
    );
    for (const s of loserSeats) if (room.seats[s].conn === 'disconnected') room.seats[s].conn = 'left';
    const winnerIds = SEATS.filter((s) => room.seats[s].kind === 'human' && !loserSeats.includes(s))
      .map((s) => room.seats[s].userId!)
      .filter(Boolean);
    const loserIds = loserSeats.map((s) => room.seats[s].userId!).filter((x): x is string => !!x);
    this.finalizeRoom(room, {
      winnerSeat: winnerIds.length === 1 ? room.members[winnerIds[0]] ?? null : null,
      winnerIds,
      loserIds,
      reason,
      status: 'forfeit',
    });
  }

  /** 全员离开（好友局）：中止房间（不落盘、不计排行），释放用户 */
  private abortRoom(room: Room): void {
    if (room.ended) return;
    room.ended = true;
    room.phase = 'FINISHED';
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    room.disconnectTimers.clear();
    for (const [uid] of Object.entries(room.members) as Array<[string, Seat]>) {
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
    if (room.phase === 'PLAYER_LEFT' && !this.anyHumanAway(room)) room.phase = 'PLAYING';
    this.db.touchOnline(client.userId, 'playing');
    this.clearDisconnectTimer(room, seat);
    this.sendTo(client.ws, {
      type: 'game.start',
      gameId: room.id,
      seats: this.publicSeats(room),
      yourSeat: seat,
      state: room.state,
      qualification: qualificationFromState(room.state),
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
    const idx = this.queue.findIndex((c) => c.userId === client.userId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.sendTo(client.ws, { type: 'queue.left' });
      if (this.queue.length === 0 && this.queueTimer) {
        clearTimeout(this.queueTimer);
        this.queueTimer = null;
        this.queueStartAt = 0;
      } else if (this.queue.length > 0 && this.queueTimer === null) {
        this.queueStartAt = Date.now();
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
