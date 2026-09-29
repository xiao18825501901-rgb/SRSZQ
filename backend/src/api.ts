/** SRSZQ backend — HTTP API 服务（用户/认证/排行），WebSocket 见 ws/ */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from './db.js';
import { avatarFor, createSessionToken, hashPassword, makeSalt, sessionExpiry, validateEmail, validatePassword, validateUsername, verifyPassword } from './auth.js';
import type { PublicUser, User } from './models.js';
import { randomUUID } from 'node:crypto';
import { SlidingWindowLimiter } from './ws/security.js';
import { buildReadyReport, detectBackendSourceSha, livenessPayload } from './readiness.js';
import {
  featureFlagEvidence, parseFeatureFlags, PROTOCOL_INFO, SCORE_POLICY_ID,
  asBoardSize, moveListOf, replayGame, reviewKeyMoves, stateDigest, threatWindows, classifyAccountSource,
  PLAYER_LABELS, RULESET_VERSION, RELEASE_ID,
  dailyPuzzleId, expandTrails, gradeAnswer,
  TRAINING_CONSENT_VERSION, TRAINING_CONSENT_NOTICE, decideTrainingConsent, buildDataset, DEFAULT_DATASET_POLICY,
  type PersistedEvent, type GameState, type Player, type Puzzle, type ReplayOutcome, type ReviewMove, type ThreatWindow,
} from '../../shared/src/index.js';
import { PUZZLE_BANK, PUZZLE_BANK_META, PUZZLE_TRAJECTORIES_PACKED } from '../../shared/src/product/puzzleBank.generated.js';

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
 * 客户端可以上报的 UI 事件白名单。对局事实（开局/终局/首次落子）只由服务器写入，
 * 客户端即使伪造这些名字也不会被接受 —— 规格 7.1：UI 事件不能冒充对局事实。
 */
const CLIENT_EVENT_ALLOWLIST = new Set([
  'guest_play_start', 'tutorial_step_complete', 'queue_cancel', 'review_open',
  'retry_move', 'invite_create', 'invite_join', 'puzzle_attempt', 'rematch_start',
]);

/**
 * 题库在进程启动时装载一次：题目是静态产物，不需要每次请求重新解析。
 * 只有 status=PUBLISHED 的题会进入索引 —— 未验证/未收录的题连查都查不到。
 */
const PUZZLE_TRAILS = expandTrails(PUZZLE_TRAJECTORIES_PACKED);
const PUZZLE_TRAIL_INDEX = new Map(PUZZLE_TRAILS.map((t) => [t.gameId, t]));
const PUZZLE_INDEX = new Map<string, Puzzle>(
  PUZZLE_BANK.filter((x) => x.status === 'PUBLISHED').map((x) => [x.puzzleId, x]),
);
/** 答错第几次之后直接给出完整答案与解析（规格只要求“可重试”，不给死循环）。 */
const PUZZLE_REVEAL_AFTER_ATTEMPTS = 3;

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

/* ---- P2 题库接口（R07/R08）：每日一题、作答幂等、进度与错题本 ---- */

/** 题面：只给起始局面与题类，**不给答案**、也不给威胁数量提示。 */
function puzzleView(puzzle: Puzzle, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const trail = PUZZLE_TRAIL_INDEX.get(puzzle.sourceGameId);
  const moves = trail ? trail.moves.slice(0, puzzle.startPly) : [];
  return {
    puzzleId: puzzle.puzzleId,
    schema: puzzle.schema,
    acceptanceType: puzzle.acceptanceType,
    boardSize: puzzle.boardSize,
    actorSeat: puzzle.actorSeat,
    round: puzzle.round,
    eligiblePlayer: puzzle.eligiblePlayer,
    startMoves: moves.length,
    moves,
    sourceKind: puzzle.sourceKind,
    split: puzzle.split,
    status: puzzle.status,
    ...extra,
  };
}

/** 解析：只在答对、或同一题答错达到阈值后下发（含完整答案集）。 */
function puzzleSolution(puzzle: Puzzle): Record<string, unknown> {
  return {
    answers: puzzle.answers,
    answerCount: puzzle.answers.length,
    answerSetComplete: puzzle.answerSetComplete,
    threatsBefore: puzzle.threatsBefore,
    threatsAfter: puzzle.threatsAfter,
    excludedByForbidden: puzzle.excludedByForbidden,
    threatenedSeat: puzzle.threatenedSeat,
    explanation: puzzle.explanation,
    solver: puzzle.solver,
  };
}

/** 今天的日期（按服务器时区，格式 YYYY-MM-DD）。 */
function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
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
   * P4：就绪探针的运行时信息（AI worker 池状态）。
   * 刻意做成注入而不是直接依赖 GameServer：/ready 需要的是**状态快照**，不是游戏逻辑。
   */
  readiness?: () => { worker?: { poolSize: number; warm: number } };
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
  const startedAt = Date.now();
  // 启动时探测一次：/version 与 /ready 报的是实际部署的提交。
  const backendSourceSha = detectBackendSourceSha();
  const frontendSourceSha = process.env.SRSZQ_FRONTEND_SOURCE_SHA?.trim() || null;
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

      /* ---- P3A：训练许可 / 数据导出删除 / 举报屏蔽 / 管理端 ---- */

      const adminUser = (): { ok: true; user: NonNullable<ReturnType<typeof ctx.authUser>> } | { ok: false } => {
        const user = ctx.authUser(req);
        if (!user) { send(res, 401, { error: 'unauthorized' }); return { ok: false }; }
        if (db.getUserRole(user.id) !== 'ADMIN') { send(res, 403, { error: 'admin only' }); return { ok: false }; }
        return { ok: true, user };
      };

      // 训练许可：默认不纳入；撤回只阻止新纳入，并保留原版本以便审计。
      if (isApi && seg[1] === 'consent' && seg[2] === 'training' && seg.length === 3) {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        if (req.method === 'GET') {
          const record = db.getConsent(user.id, 'TRAINING');
          return send(res, 200, {
            version: TRAINING_CONSENT_VERSION,
            consent: record,
            decision: decideTrainingConsent(record),
            notice: TRAINING_CONSENT_NOTICE,
          });
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (typeof body.grant !== 'boolean') return send(res, 400, { error: 'grant(boolean) 必填' });
          const record = body.grant
            ? db.grantConsent({ userId: user.id, kind: 'TRAINING', version: TRAINING_CONSENT_VERSION })
            : db.revokeConsent({ userId: user.id, kind: 'TRAINING', version: TRAINING_CONSENT_VERSION });
          db.appendAudit({
            actorId: user.id, actorRole: db.getUserRole(user.id),
            action: body.grant ? 'CONSENT_GRANT' : 'CONSENT_REVOKE',
            targetKind: 'CONSENT', targetId: 'TRAINING',
            detail: { version: TRAINING_CONSENT_VERSION },
          });
          return send(res, 200, { consent: record, decision: decideTrainingConsent(record) });
        }
        return send(res, 405, { error: 'method not allowed' });
      }

      // 客户端 UI 事件：只接受白名单名字，一律打 CLIENT_UI 标签。
      if (isApi && seg[1] === 'events' && seg.length === 2 && req.method === 'POST') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const body = await readJson(req);
        const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!eventId || eventId.length > 128 || !CLIENT_EVENT_ALLOWLIST.has(name)) {
          return send(res, 400, { error: 'eventId 必填且 name 必须在 UI 事件白名单内', allowed: [...CLIENT_EVENT_ALLOWLIST] });
        }
        const rec = db.insertProductEvent({
          eventId, name, userId: user.id,
          gameId: typeof body.gameId === 'string' ? body.gameId : null,
          source: 'CLIENT_UI', isBot: false, isSample: false,
          payload: { clientKind: 'ui' },
        });
        return send(res, 200, { recorded: rec.inserted, duplicate: rec.duplicate });
      }

      // 数据任务列表 / 导出 / 删除（规格 7.2：本人可导出自己的数据、删除账号、撤销分享）。
      if (isApi && seg[1] === 'me' && seg[2] === 'data-tasks' && seg.length === 3 && req.method === 'GET') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, { tasks: db.listDataTasks(user.id) });
      }
      if (isApi && seg[1] === 'me' && seg[2] === 'export' && req.method === 'POST' && seg.length === 3) {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const task = db.createDataTask({ userId: user.id, kind: 'EXPORT' });
        db.finishDataTask({ taskId: task.taskId, status: 'RUNNING' });
        try {
          const data = db.exportUserData(user.id);
          db.finishDataTask({ taskId: task.taskId, status: 'DONE', result: data });
          db.appendAudit({ actorId: user.id, actorRole: db.getUserRole(user.id), action: 'DATA_EXPORT', targetKind: 'USER', targetId: user.id, detail: { taskId: task.taskId } });
        } catch (e) {
          db.finishDataTask({ taskId: task.taskId, status: 'FAILED', error: e instanceof Error ? e.message : String(e) });
          return send(res, 500, { error: 'export failed', taskId: task.taskId });
        }
        return send(res, 201, { task: db.findDataTask(user.id, task.taskId) });
      }
      if (isApi && seg[1] === 'me' && seg[2] === 'export' && seg.length === 4 && req.method === 'GET') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const task = db.findDataTask(user.id, seg[3]);
        if (!task) return send(res, 404, { error: 'not found' });
        return send(res, 200, { task });
      }
      if (isApi && seg[1] === 'me' && seg[2] === 'data' && seg.length === 3 && req.method === 'DELETE') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const body = await readJson(req);
        if (body.confirm !== 'DELETE_MY_DATA') {
          return send(res, 400, { error: '需要 confirm="DELETE_MY_DATA" 才执行，避免误删' });
        }
        const task = db.createDataTask({ userId: user.id, kind: 'DELETE' });
        db.finishDataTask({ taskId: task.taskId, status: 'RUNNING' });
        try {
          const result = db.anonymizeUser(user.id);
          const payload = {
            ...result,
            policy: '多人记录去标识（不删除他人合法记录）；已撤销全部分享链接；账号本体改为已注销占位',
            taskId: task.taskId,
          };
          db.finishDataTask({ taskId: task.taskId, status: 'DONE', result: payload });
          db.appendAudit({ actorId: user.id, actorRole: 'USER', action: 'ACCOUNT_DELETE', targetKind: 'USER', targetId: user.id, detail: payload });
          hooks.onSessionRevoked?.(user.id, 'LOGOUT');
          return send(res, 200, { task: db.findDataTask(user.id, task.taskId) });
        } catch (e) {
          db.finishDataTask({ taskId: task.taskId, status: 'FAILED', error: e instanceof Error ? e.message : String(e) });
          return send(res, 500, { error: 'delete failed', taskId: task.taskId });
        }
      }

      // 举报与屏蔽：只登记，不自动处罚（规格 7.2）。
      if (isApi && seg[1] === 'report' && seg.length === 2 && req.method === 'POST') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const body = await readJson(req);
        const targetKind = String(body.targetKind ?? '').trim();
        const targetId = String(body.targetId ?? '').trim();
        const reason = String(body.reason ?? '').trim();
        if (!['USER', 'GAME', 'SHARE'].includes(targetKind) || !targetId || !reason) {
          return send(res, 400, { error: 'targetKind(USER|GAME|SHARE)/targetId/reason 必填' });
        }
        if (targetKind === 'USER' && targetId === user.id) return send(res, 400, { error: '不能举报自己' });
        const created = db.createReport({ reporterId: user.id, targetKind, targetId, reason, detail: String(body.detail ?? '').slice(0, 2000) });
        db.appendAudit({ actorId: user.id, actorRole: db.getUserRole(user.id), action: 'REPORT_CREATE', targetKind, targetId, detail: { reportId: created.reportId, reason } });
        return send(res, 201, {
          report: { reportId: created.reportId, status: 'PENDING', createdAt: created.createdAt },
          note: '举报进入人工复核队列；本产品不会依据举报自动封禁或改分。',
        });
      }
      if (isApi && seg[1] === 'blocks' && seg.length === 2 && req.method === 'GET') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, { blocks: db.listBlocks(user.id) });
      }
      if (isApi && seg[1] === 'block' && seg.length === 2 && req.method === 'POST') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const body = await readJson(req);
        const target = String(body.userId ?? '').trim();
        if (!target) return send(res, 400, { error: 'userId 必填' });
        if (target === user.id) return send(res, 400, { error: '不能屏蔽自己' });
        db.blockUser(user.id, target);
        db.appendAudit({ actorId: user.id, actorRole: db.getUserRole(user.id), action: 'BLOCK_ADD', targetKind: 'USER', targetId: target, detail: {} });
        return send(res, 200, { blocks: db.listBlocks(user.id) });
      }
      if (isApi && seg[1] === 'block' && seg.length === 3 && req.method === 'DELETE') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const removed = db.unblockUser(user.id, seg[2]);
        if (!removed) return send(res, 404, { error: 'not found' });
        db.appendAudit({ actorId: user.id, actorRole: db.getUserRole(user.id), action: 'BLOCK_REMOVE', targetKind: 'USER', targetId: seg[2], detail: {} });
        return send(res, 200, { blocks: db.listBlocks(user.id) });
      }

      // 管理端：事件聚合 / 数据集 / 举报队列 / 审计。全部要求 ADMIN 角色且写审计。
      if (isApi && seg[1] === 'admin' && seg[2] === 'metrics' && seg[3] === 'events' && req.method === 'GET') {
        const gate = adminUser();
        if (!gate.ok) return;
        const name = url.searchParams.get('name') ?? 'match_finish';
        const days = Number(url.searchParams.get('days') ?? 1);
        const sinceMs = Date.now() - (Number.isFinite(days) ? Math.max(1, days) : 1) * 24 * 3600 * 1000;
        return send(res, 200, {
          name, sinceMs,
          humanOnly: db.countProductEvents({ name, sinceMs }),
          includingBotsAndSynthetic: db.countProductEvents({ name, sinceMs, excludeBot: false, excludeSynthetic: false }),
          rule: '默认口径排除 bot 与合成/测试来源（规格 7.1）',
        });
      }
      if (isApi && seg[1] === 'admin' && seg[2] === 'dataset' && seg[3] === 'build' && req.method === 'POST') {
        const gate = adminUser();
        if (!gate.ok) return;
        const candidates = db.listDatasetCandidates();
        const consentOf = (userId: string) => decideTrainingConsent(db.getConsent(userId, 'TRAINING'));
        const manifest = buildDataset(candidates, consentOf, DEFAULT_DATASET_POLICY);
        db.appendAudit({
          actorId: gate.user.id, actorRole: 'ADMIN', action: 'DATASET_BUILD', targetKind: 'DATASET', targetId: manifest.datasetHash,
          detail: { entries: manifest.entries.length, excluded: manifest.excluded.length, bySplit: manifest.bySplit },
        });
        return send(res, 200, {
          manifest: {
            ...manifest,
            entries: manifest.entries.map((e) => ({ ...e })),
          },
          candidates: candidates.length,
          rule: '默认不纳入未授权的人类棋谱；test 分片不得用于选权重；空间 8 对称去重且不置换红绿白。',
        });
      }
      if (isApi && seg[1] === 'admin' && seg[2] === 'dataset' && seg[3] === 'runs' && req.method === 'POST') {
        const gate = adminUser();
        if (!gate.ok) return;
        const body = await readJson(req);
        const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
        const rec = db.registerDatasetRun({
          runId: String(body.runId ?? randomUUID()),
          seedFrom: num(body.seedFrom), seedTo: num(body.seedTo),
          sourceSha: String(body.sourceSha ?? ''), engineVersion: String(body.engineVersion ?? ''),
          budget: String(body.budget ?? ''), trajectoryHash: String(body.trajectoryHash ?? ''),
          configHash: String(body.configHash ?? ''), uniqueSampleCount: num(body.uniqueSampleCount),
        });
        db.appendAudit({ actorId: gate.user.id, actorRole: 'ADMIN', action: 'DATASET_RUN_REGISTER', targetKind: 'DATASET_RUN', targetId: rec.runId, detail: rec });
        return send(res, 201, rec);
      }
      if (isApi && seg[1] === 'admin' && seg[2] === 'dataset' && seg[3] === 'runs' && req.method === 'GET') {
        const gate = adminUser();
        if (!gate.ok) return;
        return send(res, 200, { runs: db.listDatasetRuns(100) });
      }
      if (isApi && seg[1] === 'admin' && seg[2] === 'reports' && seg.length === 4 && req.method === 'POST') {
        const gate = adminUser();
        if (!gate.ok) return;
        const body = await readJson(req);
        const status = String(body.status ?? '').trim();
        if (!['REVIEWED', 'DISMISSED', 'ACTIONED'].includes(status)) {
          return send(res, 400, { error: 'status 必须是 REVIEWED|DISMISSED|ACTIONED' });
        }
        const okReviewed = db.reviewReport({
          reportId: seg[3], reviewerId: gate.user.id,
          status: status as 'REVIEWED' | 'DISMISSED' | 'ACTIONED',
          note: String(body.note ?? '').slice(0, 1000),
        });
        if (!okReviewed) return send(res, 404, { error: 'not found' });
        db.appendAudit({ actorId: gate.user.id, actorRole: 'ADMIN', action: 'REPORT_REVIEW', targetKind: 'REPORT', targetId: seg[3], detail: { status } });
        return send(res, 200, { reviewed: true, status });
      }
      if (isApi && seg[1] === 'admin' && seg[2] === 'reports' && seg.length === 3 && req.method === 'GET') {
        const gate = adminUser();
        if (!gate.ok) return;
        const status = url.searchParams.get('status');
        return send(res, 200, { reports: db.listReports(status) });
      }
      if (isApi && seg[1] === 'admin' && seg[2] === 'audit' && seg.length === 3 && req.method === 'GET') {
        const gate = adminUser();
        if (!gate.ok) return;
        return send(res, 200, { audit: db.listAudit(100) });
      }

      // R08：单题视图（错题重练用）。只允许已发布的题，未发布/不存在一律 404。
      if (isApi && seg[1] === 'puzzles' && seg.length === 3 && req.method === 'GET' && seg[2] !== 'daily' && seg[2] !== 'progress') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const puzzle = PUZZLE_INDEX.get(seg[2]);
        if (!puzzle) return send(res, 404, { error: 'not found' });
        const prog = db.raw
          .prepare('SELECT status, attempts FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?')
          .get(user.id, puzzle.puzzleId) as { status?: string; attempts?: number } | undefined;
        return send(res, 200, {
          puzzle: puzzleView(puzzle, { myStatus: prog?.status ?? null, myAttempts: Number(prog?.attempts ?? 0) }),
        });
      }

      // R08：作答。attemptId 幂等；正式题用完整答案集判题；答对或达到阈值才下发解析。
      if (isApi && seg[1] === 'puzzles' && seg.length === 4 && seg[3] === 'attempt' && req.method === 'POST') {
        const user = ctx.authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized' });
        const puzzle = PUZZLE_INDEX.get(seg[2]);
        if (!puzzle) return send(res, 404, { error: 'not found' });
        const body = await readJson(req);
        const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : '';
        const row = Number(body.row);
        const col = Number(body.col);
        if (!attemptId || attemptId.length > 128 || !Number.isInteger(row) || !Number.isInteger(col)) {
          return send(res, 400, { error: 'attempt requires attemptId(string<=128), row(int), col(int)' });
        }
        const prior = db.findPuzzleAttempt(user.id, attemptId);
        if (prior) {
          // 同一 attemptId 换答案：明确拒绝，不覆盖历史（否则幂等就名存实亡）。
          if (prior.puzzleId !== puzzle.puzzleId || prior.row !== row || prior.col !== col) {
            return send(res, 409, { error: 'ATTEMPT_ID_CONFLICT', prior: { puzzleId: prior.puzzleId, row: prior.row, col: prior.col, verdict: prior.verdict } });
          }
          const rec = db.recordPuzzleAttempt({ userId: user.id, puzzleId: puzzle.puzzleId, attemptId, row, col, verdict: prior.verdict });
          return send(res, 200, {
            verdict: prior.verdict,
            duplicate: true,
            attempts: rec.attempts,
            solved: rec.solved,
            ...(prior.verdict === 'CORRECT' ? puzzleSolution(puzzle) : {}),
          });
        }
        const trail = PUZZLE_TRAIL_INDEX.get(puzzle.sourceGameId);
        if (!trail) return send(res, 500, { error: 'puzzle source trajectory missing' });
        const graded = gradeAnswer(puzzle, trail, row, col);
        const rec = db.recordPuzzleAttempt({ userId: user.id, puzzleId: puzzle.puzzleId, attemptId, row, col, verdict: graded.verdict });
        const reveal = graded.verdict === 'CORRECT' || rec.attempts >= PUZZLE_REVEAL_AFTER_ATTEMPTS;
        // 进度持久化后复核一次：客户端拿到的是落库之后的真实状态。
        const progRow = db.raw
          .prepare('SELECT status, attempts FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?')
          .get(user.id, puzzle.puzzleId) as { status?: string; attempts?: number } | undefined;
        return send(res, 200, {
          verdict: graded.verdict,
          duplicate: rec.duplicate,
          attempts: Number(progRow?.attempts ?? rec.attempts),
          solved: progRow?.status === 'SOLVED',
          reveal,
          ...(reveal ? puzzleSolution(puzzle) : {}),
        });
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
          // 规格 4.1：测试/合成账号必须可被识别，否则它们会像真人一样进排行榜与被分享。
          const source = classifyAccountSource(email, username, process.env);
          if (source !== 'HUMAN') db.setUserSource(user.id, source);
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
        case 'GET /health':
        case 'GET /api/health': {
          // 规格 7.3：/health 只表示存活 —— 这里刻意不检查任何依赖，
          // 否则依赖抖动会让编排系统杀掉一个其实还能服务的进程。
          return send(res, 200, livenessPayload());
        }
        case 'GET /ready':
        case 'GET /api/ready': {
          const report = buildReadyReport(db, {
            worker: hooks.readiness?.().worker,
            version: { ...PROTOCOL_INFO },
            source: { backendSourceSha, frontendSourceSha },
            startedAt,
          });
          return send(res, report.ready ? 200 : 503, { ...report });
        }
        case 'GET /api/version': {
          // O06：让第三方可以直接核查前后端规则/协议版本，而不是靠声明。
          return send(res, 200, {
            protocol: { ...PROTOCOL_INFO },
            // 规格 7.3 要求 /version 能给出前后端源码标识（不含任何密钥）。
            source: { backendSourceSha, frontendSourceSha },
            sourceMode: 'IMPLEMENTED_FROM_VERIFIED_BASELINE',
            serverTime: Date.now(),
          });
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
        case 'GET /api/puzzles/daily': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const day = url.searchParams.get('day') ?? dayKey();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(res, 400, { error: 'day 必须是 YYYY-MM-DD' });
          const published = PUZZLE_BANK.filter((x) => x.status === 'PUBLISHED');
          const id = dailyPuzzleId(published, day);
          const puzzle = id ? PUZZLE_INDEX.get(id) : undefined;
          if (!puzzle) return send(res, 503, { error: 'puzzle bank empty' });
          const prog = db.raw
            .prepare('SELECT status, attempts FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?')
            .get(user.id, puzzle.puzzleId) as { status?: string; attempts?: number } | undefined;
          return send(res, 200, {
            day,
            puzzle: puzzleView(puzzle, {
              myStatus: prog?.status ?? null,
              myAttempts: Number(prog?.attempts ?? 0),
            }),
            bank: { total: PUZZLE_BANK_META.total, byType: PUZZLE_BANK_META.byType, solverVersion: PUZZLE_BANK_META.solverVersion },
          });
        }
        case 'GET /api/puzzles/progress': {
          const user = ctx.authUser(req);
          if (!user) return send(res, 401, { error: 'unauthorized' });
          const progress = db.puzzleProgress(user.id);
          return send(res, 200, {
            progress: {
              ...progress,
              totalPublished: PUZZLE_BANK_META.total,
              wrong: progress.wrong.map((w) => {
                const pz = PUZZLE_INDEX.get(w.puzzleId);
                return { ...w, acceptanceType: pz?.acceptanceType ?? null, boardSize: pz?.boardSize ?? null, round: pz?.round ?? null };
              }),
            },
          });
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
