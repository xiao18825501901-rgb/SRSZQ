/** SRSZQ backend — HTTP API 服务（用户/认证/排行），WebSocket 见 ws/ */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from './db.js';
import { avatarFor, createSessionToken, hashPassword, makeSalt, sessionExpiry, validateEmail, validatePassword, validateUsername, verifyPassword } from './auth.js';
import type { PublicUser, User } from './models.js';
import { randomUUID } from 'node:crypto';
import { SlidingWindowLimiter } from './ws/security.js';
import {
  featureFlagEvidence, parseFeatureFlags, PROTOCOL_INFO, SCORE_POLICY_ID,
  asBoardSize, moveListOf, replayGame, reviewKeyMoves, stateDigest, threatWindows,
  PLAYER_LABELS, RULESET_VERSION, RELEASE_ID,
  type PersistedEvent, type GameState, type Player, type ReplayOutcome, type ReviewMove, type ThreatWindow,
} from '../../shared/src/index.js';

export interface ApiContext {
  db: Db;
  /** 从 Authorization: Bearer <token> 解析并校验会话，返回用户或 null */
  authUser(req: IncomingMessage): User | null;
}

/** R06：分享链接 TTL —— 规格写死 7 天，不接受调用方覆盖。 */
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Phase A 复盘的分析口径标识：只做精确一步事实，绝不产生搜索估计。 */
const REVIEW_ANALYSIS_MODE = 'phase-a-exact-one-ply';

/**
 * 公开分享视图是**未认证**的，而每次请求都要真跑一遍重放（O(棋盘² × 手数)）。
 * 不加限制的话，它就是一个不用登录就能打满事件循环的入口，所以按来源限流。
 */
const PUBLIC_SHARE_RATE_LIMIT = 30;
const PUBLIC_SHARE_RATE_WINDOW_MS = 60_000;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://srszq.com',
  'https://www.srszq.com',
  'https://srszq.netlify.app',
];

function configuredAllowedOrigins(): Set<string> {
  const configured = process.env.SRSZQ_ALLOWED_ORIGINS;
  const origins = configured === undefined ? DEFAULT_ALLOWED_ORIGINS : configured.split(',');
  return new Set(origins.map((origin) => origin.trim()).filter(Boolean));
}

export function toPublic(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    onlineStatus: user.onlineStatus,
    rating: user.rating,
    tutorialCompleted: user.tutorialCompleted,
  };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  const payload = JSON.stringify({ ok: status < 400, ...data });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(payload);
}

/** 校验是否「已登录且完成教学」（在线对战门禁，本地/教学模式不受限） */
export function requireTutorialDone(res: ServerResponse, user: User | null): boolean {
  if (!user) {
    send(res, 401, { error: 'unauthorized' });
    return false;
  }
  if (!user.tutorialCompleted) {
    send(res, 403, { error: 'tutorial required' });
    return false;
  }
  return true;
}

/* ---- P2 复盘视图（R02/R03/R04）：单一实现，供本人重放与公开分享共用 ---- */

/**
 * 全谱重放视图。hashMatches 的期望值来自**服务器自己持久化的权威快照**，
 * 因此“重放到同一 hash”是对持久状态的一致性检查，而不是把客户端给的 hash 当真。
 */
function buildReplayView(db: Db, gameId: string, boardSizeRaw: unknown) {
  const boardSize = asBoardSize(Number(boardSizeRaw));
  if (boardSize === null) return null;
  const events = db.listGameEvents(gameId) as PersistedEvent[];
  const snap = db.latestSnapshot(gameId);
  let snapshotHash: string | null = null;
  if (snap) {
    try {
      const parsed = JSON.parse(snap.stateJson) as { state?: GameState } | null;
      if (parsed && parsed.state) snapshotHash = stateDigest(parsed.state);
    } catch {
      snapshotHash = null;
    }
  }
  const outcome: ReplayOutcome = replayGame(boardSize, events, { expectedHash: snapshotHash });
  const windows: ThreatWindow[] = threatWindows(outcome);
  const keyMoves = reviewKeyMovesFor(outcome, windows);
  return {
    rulesetVersion: RULESET_VERSION,
    protocolVersion: PROTOCOL_INFO.protocolVersion,
    releaseId: RELEASE_ID,
    boardSize,
    moveCount: outcome.steps.length,
    moves: moveListOf(outcome),
    status: outcome.state.status,
    winnerSeat: outcome.state.winner,
    winLine: outcome.state.winLine,
    finalHash: outcome.finalHash,
    snapshotHash,
    snapshotRevision: snap ? snap.revision : null,
    replayOk: outcome.ok,
    replayErrors: outcome.errors,
    hashMatches: outcome.hashMatches,
    analysisMode: REVIEW_ANALYSIS_MODE,
    // 5.2 的缓存键必须含 gameHash + engineVersion + budget + rulesetId；这里四项齐全。
    reviewCacheKey: [outcome.finalHash, RULESET_VERSION, REVIEW_ANALYSIS_MODE, RELEASE_ID].join(':'),
    keyMoves,
    defenseWindowCount: windows.length,
    seatLabels: PLAYER_LABELS,
  };
}

/** 关键片段 + 与之对应的跨轮防守窗口（只有真的发生了遮挡才附窗口）。 */
function reviewKeyMovesFor(outcome: ReplayOutcome, windows: ThreatWindow[]): Array<ReviewMove & { defenseWindow: ThreatWindow | null }> {
  return reviewKeyMoves(outcome).map((km) => {
    const w =
      km.type === 'PREEMPTIVE_BLOCK'
        ? windows.find(
            (x) => x.row === km.row && x.col === km.col && x.resolvedAtPly === km.ply && x.resolvedBySeat === km.actorSeat,
          ) ?? null
        : null;
    return { ...km, defenseWindow: w };
  });
}

/**
 * R06 公开视图：只出座位字母、棋色、名次、坐标与已证实的解释。
 * 明确**不含** gameId / userId / 用户名 / 邮箱 / IP / 会话信息。
 * demo=true 表示这局里有非 HUMAN 来源账号（合成/测试/演示），不允许冒充真人。
 */
function buildSharedView(db: Db, gameId: string) {
  const settled = db.findMatchResult(gameId);
  if (!settled) return null;
  const base = buildReplayView(db, gameId, settled.boardSize);
  if (!base) return null;
  const parts = db.matchParticipantViews(gameId);
  return {
    demo: parts.some((p) => p.source !== 'HUMAN'),
    rulesetVersion: base.rulesetVersion,
    protocolVersion: base.protocolVersion,
    mode: settled.mode,
    boardSize: base.boardSize,
    endReason: settled.endReason,
    isRanked: settled.isRanked,
    settledAt: settled.settledAt,
    status: base.status,
    winnerSeat: settled.winnerSeat,
    seatLabels: base.seatLabels,
    seats: parts.map((p) => ({
      seat: p.seat,
      label: PLAYER_LABELS[p.seat as Player] ?? p.seat,
      kind: p.kind,
      outcome: p.outcome,
      ratingDelta: p.ratingDelta,
    })),
    moveCount: base.moveCount,
    moves: base.moves,
    winLine: base.winLine,
    keyMoves: base.keyMoves,
    finalHash: base.finalHash,
    replayOk: base.replayOk,
    analysisMode: base.analysisMode,
  };
}

export interface ApiHooks {
  /** 邀请发出 → 服务端登记邀请会话（支持“多邀请聚合”状态机） */
  onInviteCreated?: (senderId: string, receiverId: string) => void;
  /** 邀请被接受 → 进入好友对局状态机（1 接受=2H+AI；2 接受=3H） */
  onInviteAccepted?: (senderId: string, receiverId: string) => void;
  /** 邀请被拒绝 */
  onInviteRejected?: (senderId: string, receiverId: string) => void;
  /**
   * S07：会话被撤销（登出）。服务端据此**立即切断**该用户的 WebSocket，
   * 否则登出后旧连接仍能继续下棋 —— 那等于登出没有生效。
   */
  onSessionRevoked?: (userId: string, reason: 'LOGOUT') => void;
}

export function createApi(db: Db, hooks: ApiHooks = {}): { server: Server; ctx: ApiContext } {
  const allowedOrigins = configuredAllowedOrigins();
  const ctx: ApiContext = {
    db,
    authUser(req) {
      const h = req.headers.authorization ?? '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!token) return null;
      const session = db.findSession(token);
      if (!session || session.expiresAt < Date.now()) return null;
      return db.findUserById(session.userId);
    },
  };

  const publicShareLimiter = new SlidingWindowLimiter(PUBLIC_SHARE_RATE_LIMIT, PUBLIC_SHARE_RATE_WINDOW_MS);
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const originAllowed = typeof origin === 'string' && allowedOrigins.has(origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (originAllowed) res.setHeader('Access-Control-Allow-Origin', origin);

    if (req.method === 'OPTIONS') {
      if (!originAllowed) return send(res, 403, { error: 'origin not allowed' });
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      /* ---- P2 动态路由（R01/R02/R06）：路径里带 gameId / token，常量 switch 匹配不到 ---- */
      const seg = url.pathname.split('/').filter(Boolean);
      const isApi = seg[0] === 'api';

      // R06：公开分享视图。**不带任何内部标识**：无 gameId、无 userId、无用户名、无邮箱、无 IP。
      if (isApi && seg[1] === 'shared' && seg.length === 3 && req.method === 'GET') {
        const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
        const source = forwarded || req.socket.remoteAddress || 'unknown';
        if (!publicShareLimiter.tryTake(source)) {
          return send(res, 429, { error: 'rate limited', code: 'RATE_LIMITED' });
        }
        const link = db.findShareLink(seg[2]);
        if (!link) return send(res, 404, { error: 'not found' });
        if (link.revokedAt !== null) return send(res, 410, { error: 'revoked' });
        if (link.expiresAt <= Date.now()) return send(res, 410, { error: 'expired' });
        const settled = db.findMatchResult(link.gameId);
        if (!settled) return send(res, 404, { error: 'not found' });
        const shared = buildSharedView(db, link.gameId);
        if (!shared) return send(res, 422, { error: 'UNSUPPORTED_BOARD_SIZE' });
        db.countShareView(link.token);
        return send(res, 200, {
          shared: {
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
            views: link.views,
            ...shared,
          },
        });
      }

      // R06：撤销（仅创建者本人；撤销后公开视图 410）。
      if (isApi && seg[1] === 'share' && seg.length === 3 && req.method === 'DELETE') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const revoked = db.revokeShareLink(seg[2], user.id);
        if (!revoked) return send(res, 404, { error: 'not found or already revoked' });
        return send(res, 200, { revoked: true, token: seg[2] });
      }

      // R02：本人全谱重放（含关键片段与跨轮防守窗口）。
      if (isApi && seg[1] === 'games' && seg.length === 4 && seg[3] === 'replay' && req.method === 'GET') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const gameId = seg[2];
        // 先判归属：不是本人参与的对局一律 404，避免用 403/404 差异枚举对局 ID。
        const part = db.participantOf(user.id, gameId);
        if (!part && !db.seatInLiveGame(user.id, gameId)) return send(res, 404, { error: 'not found' });
        const settled = db.findMatchResult(gameId);
        if (!settled) return send(res, 409, { error: 'ANALYSIS_REQUIRES_SETTLED' });
        if (!part) return send(res, 404, { error: 'not found' });
        const built = buildReplayView(db, gameId, settled.boardSize);
        if (!built) return send(res, 422, { error: 'UNSUPPORTED_BOARD_SIZE' });
        return send(res, 200, {
          replay: {
            gameId,
            mySeat: part.seat,
            myOutcome: part.outcome,
            myRatingDelta: part.ratingDelta,
            mode: settled.mode,
            scorePolicy: settled.scorePolicy,
            settledAt: settled.settledAt,
            ...built,
            shares: db.listShareLinks(gameId, user.id).map((s) => ({
              token: s.token,
              path: '/s/' + s.token,
              createdAt: s.createdAt,
              expiresAt: s.expiresAt,
              revokedAt: s.revokedAt,
              views: s.views,
            })),
          },
        });
      }

      // R06：终局后主动创建分享链接（进行中的对局不允许）。
      if (isApi && seg[1] === 'games' && seg.length === 4 && seg[3] === 'share' && req.method === 'POST') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const gameId = seg[2];
        if (!db.participantOf(user.id, gameId) && !db.seatInLiveGame(user.id, gameId)) return send(res, 404, { error: 'not found' });
        if (!db.findMatchResult(gameId)) return send(res, 409, { error: 'SHARE_REQUIRES_SETTLED' });
        const token = randomUUID().replace(/-/g, '');
        const link = db.createShareLink({ token, gameId, ownerId: user.id, ttlMs: SHARE_TTL_MS });
        return send(res, 201, {
          share: { token, path: '/s/' + token, createdAt: link.createdAt, expiresAt: link.expiresAt, ttlMs: SHARE_TTL_MS },
        });
      }

      // R06：本人某局的分享状态（前端显示“已分享 / 已撤销 / 已过期”）。
      if (isApi && seg[1] === 'games' && seg.length === 4 && seg[3] === 'share' && req.method === 'GET') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const gameId = seg[2];
        if (!db.participantOf(user.id, gameId) && !db.seatInLiveGame(user.id, gameId)) return send(res, 404, { error: 'not found' });
        return send(res, 200, {
          shares: db.listShareLinks(gameId, user.id).map((s) => ({
            token: s.token, path: '/s/' + s.token, createdAt: s.createdAt,
            expiresAt: s.expiresAt, revokedAt: s.revokedAt, views: s.views,
          })),
        });
      }

      switch (route) {
        case 'POST /api/register': {
          const body = await readJson(req);
          const email = String(body.email ?? '').trim().toLowerCase();
          const username = String(body.username ?? '').trim();
          const password = String(body.password ?? '');
          const err = validateEmail(email) ?? validateUsername(username) ?? validatePassword(password);
          if (err) return send(res, 400, { error: err });
          if (db.findUserByEmail(email)) return send(res, 409, { error: '邮箱已注册' });
          if (db.findUserByUsername(username)) return send(res, 409, { error: '用户名已被占用' });
          const salt = makeSalt();
          const user = db.createUser({ email, username, passwordHash: hashPassword(password, salt), salt });
          db.touchOnline(user.id, 'online');
          const token = createSessionToken();
          db.createSession(token, user.id, sessionExpiry());
          return send(res, 201, { user: { ...toPublic(user), email: user.email }, token });
        }
        case 'POST /api/login': {
          const body = await readJson(req);
          const account = String(body.account ?? '').trim().toLowerCase();
          const password = String(body.password ?? '');
          const user = db.findUserByEmail(account) ?? db.findUserByUsernameCI(account);
          if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
            return send(res, 401, { error: '账号或密码错误' });
          }
          db.touchOnline(user.id, 'online');
          const token = createSessionToken();
          db.createSession(token, user.id, sessionExpiry());
          return send(res, 200, { user: { ...toPublic(user), email: user.email }, token });
        }
        case 'POST /api/logout': {
          const h = req.headers.authorization ?? '';
          const token = h.startsWith('Bearer ') ? h.slice(7) : '';
          if (token) {
            const session = db.findSession(token);
            if (session) {
              db.deleteSession(token);
              db.touchOnline(session.userId, 'offline');
              // 会话没了，长连接也必须没了。
              hooks.onSessionRevoked?.(session.userId, 'LOGOUT');
            }
          }
          return send(res, 200, {});
        }
        case 'GET /api/version': {
          // O06：让第三方可以直接核查前后端规则/协议版本，而不是靠声明。
          return send(res, 200, { protocol: { ...PROTOCOL_INFO }, serverTime: Date.now() });
        }
        case 'GET /api/config/features': {
          // 只读、非机密：暴露开关的**实际解析值**与原始环境变量字符串，
          // 使“默认关闭”可以被第三方复核，而不是靠声明。
          return send(res, 200, {
            flags: parseFeatureFlags(process.env),
            evidence: featureFlagEvidence(process.env),
            scorePolicy: SCORE_POLICY_ID,
          });
        }
        case 'GET /api/me': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const full = db.findUserById(user.id)!;
          return send(res, 200, { user: { ...toPublic(full), email: full.email } });
        }
        case 'POST /api/tutorial/complete': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          db.setTutorialCompleted(user.id, true);
          const updated = db.findUserById(user.id)!;
          return send(res, 200, { user: { ...toPublic(updated), email: updated.email } });
        }
        case 'GET /api/ranking': {
          const l = Number(url.searchParams.get('limit') ?? 50);
          const o = Number(url.searchParams.get('offset') ?? 0);
          const limit = Number.isFinite(l) ? Math.min(100, Math.max(1, Math.floor(l))) : 50;
          const offset = Number.isFinite(o) ? Math.max(0, Math.floor(o)) : 0;
          const total = Number((db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
          return send(res, 200, { ranking: db.ranking(limit, offset), total, offset, limit });
        }
        case 'GET /api/history': {
          // R01：本人各模式终局的分页历史。分页参数与 /api/ranking 同口径（上限 50）。
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const l = Number(url.searchParams.get('limit') ?? 20);
          const o = Number(url.searchParams.get('offset') ?? 0);
          const limit = Number.isFinite(l) ? Math.min(50, Math.max(1, Math.floor(l))) : 20;
          const offset = Number.isFinite(o) ? Math.max(0, Math.floor(o)) : 0;
          return send(res, 200, {
            history: db.historyFor(user.id, limit, offset),
            total: db.historyCount(user.id),
            limit,
            offset,
          });
        }
        case 'GET /api/invitations': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          return send(res, 200, { invitations: db.listInvitationsFor(user.id) });
        }
        case 'POST /api/invite': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const body = await readJson(req);
          const toUsername = String(body.toUsername ?? '').trim();
          const target = db.findUserByUsernameCI(toUsername);
          if (!target) return send(res, 404, { error: '用户不存在' });
          if (target.id === user.id) return send(res, 400, { error: '不能邀请自己' });
          const inv = db.createInvitation(user.id, target.id);
          hooks.onInviteCreated?.(user.id, target.id);
          return send(res, 201, { invitation: { ...inv, senderName: user.username } });
        }
        case 'POST /api/invite/accept': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const body = await readJson(req);
          const inv = db.findInvitation(String(body.id ?? ''));
          if (!inv || inv.status !== 'pending') return send(res, 404, { error: '邀请不存在或已处理' });
          if (inv.receiver !== user.id) return send(res, 403, { error: '该邀请不是发给你的' });
          db.setInvitationStatus(inv.id, 'accepted');
          db.addFriends(inv.sender, inv.receiver);
          hooks.onInviteAccepted?.(inv.sender, inv.receiver);
          return send(res, 200, { ok: true });
        }
        case 'POST /api/invite/reject': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const body = await readJson(req);
          const inv = db.findInvitation(String(body.id ?? ''));
          if (!inv || inv.status !== 'pending') return send(res, 404, { error: '邀请不存在或已处理' });
          if (inv.receiver !== user.id) return send(res, 403, { error: '该邀请不是发给你的' });
          db.setInvitationStatus(inv.id, 'rejected');
          hooks.onInviteRejected?.(inv.sender, inv.receiver);
          return send(res, 200, { ok: true });
        }
        case 'GET /api/friends': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const ids = db.listFriends(user.id);
          const friends = ids
            .map((id) => db.findUserById(id))
            .filter((u): u is NonNullable<typeof u> => !!u)
            .map((u) => ({ id: u.id, username: u.username, avatar: u.avatar, onlineStatus: u.onlineStatus, rating: u.rating }));
          return send(res, 200, { friends });
        }
        default:
          return send(res, 404, { error: `not found: ${route}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return send(res, 400, { error: msg });
    }
  });
  return { server, ctx };
}

/** 生产入口：默认在 127.0.0.1:8080 提供 API */
export function bootApi(db: Db, port = Number(process.env.PORT ?? 8080)): Server {
  const { server } = createApi(db);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[srszq] API listening on http://127.0.0.1:${port}`);
  });
  return server;
}

export { avatarFor };
