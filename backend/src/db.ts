/**
 * SRSZQ backend — SQLite 存储层（node:sqlite，零外部依赖）。
 * 通过仓储接口组织，未来可平滑替换为 PostgreSQL（见 docs/DATABASE_SCHEMA.md）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { User } from './models.js';
import { settlementDigest, type SettlementPlan, type ParticipantOutcome } from '../../shared/src/product/resultModel.js';
import { type ConsentKind, type ConsentRecord } from '../../shared/src/product/consent.js';
import { type DatasetCandidate } from '../../shared/src/product/dataset.js';
import { RULESET_VERSION } from '../../shared/src/product/protocol.js';
import { commandPayloadDigest } from '../../shared/src/product/protocol.js';

/** 每日训练 Session 的一行（题目顺序当天固定）。 */
export interface DailySessionRow {
  userId: string;
  dailyKey: string;
  puzzleIds: string[];
  currentIndex: number;
  solvedCount: number;
  total: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RankingRow {
  id: string;
  username: string;
  avatar: string;
  onlineStatus: User['onlineStatus'];
  rating: number;
  wins: number;
  games: number;
  winRate: number;
}

/** 账号来源：类型与判定规则都收敛在 shared 一处，这里再导出以兼容既有引用。 */
import type { AccountSource } from '../../shared/src/product/accountSource.js';
export { ACCOUNT_SOURCES } from '../../shared/src/product/accountSource.js';
export type { AccountSource };

/** 结算输入：由 shared/product/resultModel.buildSettlement 产出的纯计划 + 落盘所需的棋谱。 */
export interface SettleMatchInput extends SettlementPlan {
  /** matches 表主键（历史表，保持兼容） */
  matchId: string;
  /** games.moves_json */
  movesJson: string;
  /** 传给历史 matches.player_a/b/c 的三座位真人 ID */
  players: Array<string | null>;
}

export interface SettledParticipant {
  seat: string;
  kind: 'human' | 'ai';
  userId: string | null;
  outcome: ParticipantOutcome;
  ratingDelta: number;
}

export interface RatingLedgerRow {
  id: string;
  gameId: string;
  userId: string;
  seat: string;
  delta: number;
  ratingBefore: number;
  ratingAfter: number;
  policy: string;
  createdAt: number;
}

export interface SettledMatch {
  gameId: string;
  alreadySettled: boolean;
  settledAt: number;
  digest: string;
  mode: string;
  boardSize: number;
  endReason: string;
  winnerSeat: string | null;
  winnerUserIds: string[];
  loserIds: string[];
  isRanked: boolean;
  scorePolicy: string;
  participants: SettledParticipant[];
}

/** 一条已生效的命令（幂等表）。同一 (gameId, commandId) 只允许一行。 */
export interface GameCommandRow {
  gameId: string;
  commandId: string;
  seat: string;
  payloadDigest: string;
  revisionBefore: number;
  revisionAfter: number;
  seq: number;
  ackJson: string;
  createdAt: number;
}

/** 追加一条已生效命令的结果。持久化与事件/快照在同一事务内完成。 */
export interface AppendCommandInput {
  gameId: string;
  commandId: string;
  seat: string;
  /** 用于幂等冲突判定的应用层 payload（不含 commandId/expectedRevision 本身） */
  payload: unknown;
  revisionBefore: number;
  revisionAfter: number;
  seq: number;
  /** 写入 game_events 的事件类型，例如 'move.applied' */
  eventType: string;
  /** 写入 game_events 的事件体 */
  eventPayload: unknown;
  /** 写入 game_snapshots 的权威状态快照 */
  snapshot: unknown;
  /** 回给客户端的 ACK 体 */
  ack: unknown;
  createdAt: number;
}

export interface AppendCommandResult {
  /** true = 本次真正写入；false = 命中已有命令 */
  appended: boolean;
  /** 命中已有命令且 payload 相同 → 幂等重放 */
  duplicate: boolean;
  /** 命中已有命令但 payload 不同 → 必须拒绝 */
  conflict: boolean;
  revision: number;
  seq: number;
  ack: unknown;
  row: GameCommandRow | null;
}

/** 一局恢复所需的快照 + 元数据。 */
export interface RecoverableGame {
  gameId: string;
  revision: number;
  seq: number;
  mode: string;
  boardSize: number;
  /** appendGameCommand 写入的原始快照（含 state + 座位归属 + revision/seq）。 */
  snapshot: unknown;
}

/** R01：本人历史列表的一行（只含本人座位视角，不泄露对手内部 ID）。 */
export interface HistoryEntry {
  gameId: string;
  seat: string;
  outcome: ParticipantOutcome;
  ratingDelta: number;
  mode: string;
  boardSize: number;
  endReason: string;
  winnerSeat: string | null;
  isRanked: boolean;
  scorePolicy: string;
  settledAt: number;
  moveCount: number;
  hasShare: boolean;
}

/** R06：去标识分享链接。token 是唯一对外标识，gameId 绝不出现在公开响应里。 */
export interface ShareLink {
  token: string;
  gameId: string;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  views: number;
}

export interface Db {
  raw: DatabaseSync;
  createUser(input: { email: string; username: string; passwordHash: string; salt: string; accountType?: 'PROVISIONAL' | 'CLAIMED' }): User;
  /** 增量 C：原地领取临时账号（同一个 userId，不新建账号）。 */
  claimAccount(userId: string, patch: { username: string; passwordHash: string; salt: string; email: string; avatar: string }): User | null;
  /** 增量 C：刷新最近活动时间（会话校验/登入时调用）。 */
  touchLastSeen(userId: string): void;
  /** 增量 C：闲置且无资产的临时账号（只进清理队列，本批次不做任何删除）。 */
  listProvisionalCleanupCandidates(idleBefore: number, limit?: number): Array<{ id: string; username: string; createdAt: number; lastSeenAt: number }>;
  /** 增量 C：临时/已领取/存量账号计数（analytics 用，三者分开）。 */
  accountTypeSummary(): { provisional: number; claimed: number; idleProvisional: number };
  findUserByEmail(email: string): User | null;
  findUserByUsername(username: string): User | null;
  findUserByUsernameCI(username: string): User | null;
  findUserById(id: string): User | null;
  touchOnline(id: string, status: User['onlineStatus']): void;
  createSession(token: string, userId: string, expiresAt: number): void;
  findSession(token: string): { token: string; userId: string; expiresAt: number } | null;
  /** S04：签发一张一次性 WS 票据（只存哈希）。 */
  createWsTicket(ticketHash: string, userId: string, expiresAt: number): void;
  /** S04：只查不消费（升级前校验用，避免“看一眼”就把票据用掉）。 */
  peekWsTicket(ticketHash: string, now: number): { userId: string } | null;
  /** S04：单次消费。已经用过或已过期一律返回 null。 */
  consumeWsTicket(ticketHash: string, now: number): { userId: string } | null;
  deleteSession(token: string): void;
  setTutorialCompleted(userId: string, done: boolean): void;
  ranking(limit: number, offset?: number): RankingRow[];
  /**
   * @deprecated 历史直写路径（无事务、无幂等）。新代码一律使用 settleMatch()。
   * 保留仅为兼容既有调用方与历史测试。
   */
  recordMatchResult(userId: string, delta: number): void;
  /** 原子 + 幂等终局结算（P0A）。见 settleMatch 实现注释。 */
  settleMatch(input: SettleMatchInput): SettledMatch;
  /** 读取已结算的终局（不存在返回 null）；用于幂等与证据核对。 */
  findMatchResult(gameId: string): SettledMatch | null;
  /** 某局全部参与者名次行（按座位排序）。 */
  listMatchParticipants(gameId: string): SettledParticipant[];
  /** 某局积分账本行。 */
  listRatingLedger(gameId: string): RatingLedgerRow[];
  /**
   * 追加一条已生效命令：事件 + 快照 + 幂等记录在同一事务内写入（P0B）。
   * 命中已有 (gameId, commandId) 时不写任何东西，直接返回既有结果。
   */
  appendGameCommand(input: AppendCommandInput): AppendCommandResult;
  /** 按 commandId 查已生效命令（幂等查询）。 */
  findGameCommand(gameId: string, commandId: string): GameCommandRow | null;
  /** 某局事件流（按 seq 升序），用于审计与重放。 */
  listGameEvents(gameId: string): Array<{ seq: number; revision: number; type: string; payload: unknown; createdAt: number }>;
  /** 有快照、但尚无终局结果的未完成对局 —— 进程重启后的恢复候选。 */
  loadRecoverableGames(): RecoverableGame[];
  /** 账号来源标记（规格 4.1：合成/测试/演示账号不进公开排行榜）。 */
  setUserSource(userId: string, source: AccountSource): void;
  getUserSource(userId: string): AccountSource;
  /**
   * 统计「同一组真人」在 sinceMs 之后已经结算过的局数。
   * 用于规格 4.2 的重复对手保护：同一三人组合 24 小时内第 4 局起竞技分变动为 0。
   */
  countRecentMatchesForUsers(userIds: string[], sinceMs: number): number;
  /** R01：本人各模式终局的分页历史（按结算时间倒序）。 */
  historyFor(userId: string, limit: number, offset: number): HistoryEntry[];
  /** R01：与 historyFor 同一过滤条件下的总条数，供分页使用。 */
  historyCount(userId: string): number;
  /** R01/R02：本人是否参与该局（本人座位视角）。不存在返回 null。 */
  participantOf(userId: string, gameId: string): { seat: string; outcome: ParticipantOutcome; ratingDelta: number } | null;
  /** 房间创建时登记“谁在这局里”（座位归属），终局结算后关闭。 */
  openLiveGame(gameId: string, members: Record<string, string>): void;
  /** 终局结算后关闭进行中记录（分享/分析随之切换到已结算判定）。 */
  closeLiveGame(gameId: string): void;
  /**
   * R02/R06：进行中（尚未结算）对局的座位归属。
   * match_participants 只在终局结算时写入，所以未结算局必须从快照的 members 判定 ——
   * 否则“进行中的对局不能分享/不能分析”会退化成 404，把“不是你的”和“还没结束”混为一谈。
   */
  seatInLiveGame(userId: string, gameId: string): string | null;
  /* ---- P3A：许可 / 事件 / 数据集运行 / 数据任务 / 举报屏蔽审计 ---- */
  getUserRole(userId: string): 'USER' | 'ADMIN';
  setUserRole(userId: string, role: 'USER' | 'ADMIN'): void;
  /** 许可记录（不存在返回 null —— 调用方必须把“没有记录”当作不允许）。 */
  getConsent(userId: string, kind: ConsentKind): ConsentRecord | null;
  grantConsent(input: { userId: string; kind: ConsentKind; version: string }): ConsentRecord;
  revokeConsent(input: { userId: string; kind: ConsentKind; version: string }): ConsentRecord;
  /** 事件写入：eventId 主键天然去重；返回是否真的新写入。 */
  insertProductEvent(input: {
    eventId: string; name: string; userId?: string | null; gameId?: string | null;
    source: string; isBot?: boolean; isSample?: boolean; payload?: unknown;
  }): { inserted: boolean; duplicate: boolean };
  /** 事件聚合：默认排除 bot 与合成/测试来源（规格 7.1）。 */
  countProductEvents(input: {
    name: string; sinceMs?: number; excludeBot?: boolean; excludeSynthetic?: boolean;
  }): { total: number; distinctUsers: number; samples: number };
  /** D04：相同 seed 区间 + 配置 + 轨迹哈希的阶段重跑不算新增独立样本。 */
  registerDatasetRun(input: {
    runId: string; seedFrom: number; seedTo: number; sourceSha: string; engineVersion: string;
    budget: string; trajectoryHash: string; configHash: string; uniqueSampleCount: number;
  }): { runId: string; isNewIndependentSample: boolean; duplicateOf: string | null };
  listDatasetRuns(limit?: number): Array<{ runId: string; seedFrom: number; seedTo: number; sourceSha: string; engineVersion: string; budget: string; trajectoryHash: string; configHash: string; uniqueSampleCount: number; createdAt: number }>;
  createDataTask(input: { userId: string; kind: 'EXPORT' | 'DELETE' }): { taskId: string; status: string; requestedAt: number };
  finishDataTask(input: { taskId: string; status: 'RUNNING' | 'DONE' | 'FAILED'; result?: unknown; error?: string }): void;
  findDataTask(userId: string, taskId: string): { taskId: string; kind: string; status: string; requestedAt: number; finishedAt: number | null; result: unknown; error: string | null } | null;
  listDataTasks(userId: string): Array<{ taskId: string; kind: string; status: string; requestedAt: number; finishedAt: number | null }>;
  createReport(input: { reporterId: string; targetKind: string; targetId: string; reason: string; detail: string }): { reportId: string; createdAt: number };
  listReports(status: string | null, limit?: number): Array<{ reportId: string; reporterId: string; targetKind: string; targetId: string; reason: string; detail: string; status: string; createdAt: number; reviewedAt: number | null; reviewNote: string | null }>;
  reviewReport(input: { reportId: string; reviewerId: string; status: 'REVIEWED' | 'DISMISSED' | 'ACTIONED'; note: string }): boolean;
  blockUser(userId: string, blockedId: string): void;
  unblockUser(userId: string, blockedId: string): boolean;
  listBlocks(userId: string): string[];
  appendAudit(input: { actorId: string; actorRole: string; action: string; targetKind?: string | null; targetId?: string | null; detail?: unknown }): void;
  listAudit(limit?: number): Array<{ id: string; actorId: string; actorRole: string; action: string; targetKind: string | null; targetId: string | null; detail: unknown; createdAt: number }>;
  /** 数据集候选：真实已结算对局的完整轨迹 + 参与者身份（仅供许可判定，不导出）。 */
  listDatasetCandidates(): DatasetCandidate[];
  /** 导出本人数据（不含其它用户的身份信息）。 */
  exportUserData(userId: string): Record<string, unknown>;
  /** 删除账号：去标识本人记录，**不**物理删除他人合法记录。 */
  anonymizeUser(userId: string): { deidentifiedParticipants: number; revokedShares: number; deletedSessions: number };
  /** R08：按 attemptId 查一次尝试（幂等重发时回放既有结论）。 */
  findPuzzleAttempt(userId: string, attemptId: string): { puzzleId: string; row: number; col: number; verdict: string; createdAt: number } | null;
  /* ---- 每日训练 Session ---- */
  getDailySession(userId: string, dailyKey: string): DailySessionRow | null;
  createDailySession(input: { userId: string; dailyKey: string; puzzleIds: string[] }): DailySessionRow;
  /** CAS 前进一格：只有 expectedIndex 仍然是当前值才会成功（防双击跳两题）。 */
  advanceDailySession(userId: string, dailyKey: string, expectedIndex: number): { advanced: boolean; session: DailySessionRow | null };
  markDailySessionCompleted(userId: string, dailyKey: string): void;
  /** 记录玩家选择的正确落子；已存在则不变（幂等），返回是否本次新写入。 */
  recordDailySolved(input: { userId: string; dailyKey: string; puzzleId: string; row: number; col: number; seat: string; attemptId: string | null }): { inserted: boolean; solvedCount: number };
  getDailySolution(userId: string, dailyKey: string, puzzleId: string): { row: number; col: number; seat: string; solvedAt: number } | null;
  listDailySolutions(userId: string, dailyKey: string): Array<{ puzzleId: string; row: number; col: number; seat: string; solvedAt: number }>;
  /** R08：记录一次尝试并更新进度（同一事务；(user_id, attempt_id) 唯一，重发不重复计数）。 */
  recordPuzzleAttempt(input: { userId: string; puzzleId: string; attemptId: string; row: number; col: number; verdict: string }): { duplicate: boolean; attempts: number; solved: boolean; firstSolvedAt: number | null };
  /** R08：本人题目进度（含错题本）。 */
  puzzleProgress(userId: string): {
    solved: number;
    failed: number;
    totalAttempts: number;
    firstSolvedAt: number | null;
    wrong: Array<{ puzzleId: string; attempts: number; lastVerdict: string; updatedAt: number }>;
  };
  /** R01/R06：某局参与者的脱敏视图（座位/名次/来源），**不含** user_id 与用户名。 */
  matchParticipantViews(gameId: string): Array<{ seat: string; outcome: ParticipantOutcome; kind: string; source: AccountSource; ratingDelta: number }>;
  /** R02：某局最新权威快照（默认只含已结算局；includeUnsettled 供恢复路径使用）。 */
  latestSnapshot(gameId: string): { revision: number; seq: number; stateJson: string } | null;
  /** R06：创建去标识分享链接（终局后由本人主动创建）。 */
  createShareLink(input: { token: string; gameId: string; ownerId: string; ttlMs: number }): ShareLink;
  /** R06：按 token 读取（含已撤销/已过期，由调用方判定可见性）。 */
  findShareLink(token: string): ShareLink | null;
  /** R06：撤销本人创建的链接；返回是否真的撤销了（非本人/不存在 = false）。 */
  revokeShareLink(token: string, ownerId: string): boolean;
  /** R06：某局由本人创建的分享链接（用于前端显示“已分享/撤销”）。 */
  listShareLinks(gameId: string, ownerId: string): ShareLink[];
  /** R06：公开访问计数（审计用）。 */
  countShareView(token: string): void;
  saveGame(input: { id: string; boardSize: number; mode: string; winner: string | null; movesJson: string; createdAt: number }): void;
  saveMatch(input: {
    id: string;
    gameId: string;
    players: Array<string | null>;
    result: string | null;
    isRanked: boolean;
    createdAt: number;
    endReason?: string;
    winnerIds?: string[];
    loserIds?: string[];
  }): void;
  createInvitation(senderId: string, receiverId: string): { id: string; status: string; createdAt: number };
  listInvitationsFor(userId: string): Array<{ id: string; sender: string; senderName: string; receiver: string; status: string; createdAt: number }>;
  findInvitation(id: string): { id: string; sender: string; receiver: string; status: string } | null;
  setInvitationStatus(id: string, status: 'accepted' | 'rejected'): void;
  addFriends(a: string, b: string): void;
  listFriends(userId: string): string[];
  close(): void;
}

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      avatar TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      tutorial_completed INTEGER NOT NULL DEFAULT 0,
      online_status TEXT NOT NULL DEFAULT 'offline',
      rating INTEGER NOT NULL DEFAULT 1200
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL
    );
    -- S04：WebSocket 一次性认证票据。主键是**哈希**——库里永远不出现票据明文。
    CREATE TABLE IF NOT EXISTS ws_tickets (
      ticket_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ranking (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      wins INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      board_size INTEGER NOT NULL,
      mode TEXT NOT NULL,
      winner TEXT,
      created_at INTEGER NOT NULL,
      moves_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id),
      player_a TEXT, player_b TEXT, player_c TEXT,
      result TEXT,
      end_reason TEXT NOT NULL DEFAULT 'NORMAL_WIN',
      winner_ids TEXT NOT NULL DEFAULT '[]',
      loser_ids TEXT NOT NULL DEFAULT '[]',
      is_ranked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL REFERENCES users(id),
      friend_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'accepted',
      PRIMARY KEY (user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL REFERENCES users(id),
      receiver TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tutorial_progress (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      step INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    /* ---- P0A 可信结果：原子结算 / 幂等 / 账本 ---- */

    -- 终局唯一真源。game_id 是 PRIMARY KEY：同一局重复提交只会命中已有行，
    -- 这是“重复终局只结算一次”的数据库级保证，不依赖任何内存标志。
    CREATE TABLE IF NOT EXISTS match_results (
      game_id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      board_size INTEGER NOT NULL,
      end_reason TEXT NOT NULL,
      winner_seat TEXT,
      winner_user_ids TEXT NOT NULL DEFAULT '[]',
      loser_ids TEXT NOT NULL DEFAULT '[]',
      is_ranked INTEGER NOT NULL DEFAULT 0,
      score_policy TEXT NOT NULL DEFAULT 'legacy-online-v1',
      settlement_digest TEXT NOT NULL,
      settled_at INTEGER NOT NULL
    );

    -- 每座位名次结果：WIN / LOSS / DRAW / VOID。CHECK 同时是故障注入点。
    CREATE TABLE IF NOT EXISTS match_participants (
      game_id TEXT NOT NULL,
      seat TEXT NOT NULL,
      kind TEXT NOT NULL,
      user_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('WIN','LOSS','DRAW','VOID')),
      rating_delta INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, seat)
    );

    -- 积分账本：每次真实积分变化一行；(game_id,user_id) 唯一，重复结算不可能重复入账。
    CREATE TABLE IF NOT EXISTS rating_ledger (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      seat TEXT NOT NULL,
      delta INTEGER NOT NULL,
      rating_before INTEGER NOT NULL,
      rating_after INTEGER NOT NULL,
      policy TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (game_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_match_participants_user ON match_participants (user_id);
    CREATE INDEX IF NOT EXISTS idx_rating_ledger_user ON rating_ledger (user_id, created_at);

    /* ---- P0B 命令信封 / 持久事件 / 快照 ---- */

    -- 已生效命令。PRIMARY KEY (game_id, command_id) 是“同一命令只生效一次”的数据库级保证：
    -- 客户端在 ACK 丢失后重发，只会命中这一行，不会二次落子、不会重置落子时钟。
    CREATE TABLE IF NOT EXISTS game_commands (
      game_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      seat TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      revision_before INTEGER NOT NULL,
      revision_after INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      ack_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, command_id)
    );

    -- 持久事件流：每一步一次，seq 连续递增，是“状态从哪来”的可重放凭据。
    CREATE TABLE IF NOT EXISTS game_events (
      game_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, seq)
    );

    -- 权威状态快照：进程被强杀后据此恢复，不必重放全部事件。
    CREATE TABLE IF NOT EXISTS game_snapshots (
      game_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, revision)
    );

    CREATE INDEX IF NOT EXISTS idx_game_events_game ON game_events (game_id, seq);
    CREATE INDEX IF NOT EXISTS idx_game_snapshots_game ON game_snapshots (game_id, revision);

    /* ---- P2 棋谱历史 / 去标识分享（R01 R02 R06） ---- */

    -- 分享链接：token 是唯一对外标识。撤销 = 写 revoked_at（不删行，保留审计）。
    -- 公开响应绝不返回 game_id / owner_id，所以泄露面只有 token 本身。
    CREATE TABLE IF NOT EXISTS share_links (
      token TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      views INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_share_links_game ON share_links (game_id, owner_id);

    /* ---- P2 题库：尝试与进度（R08） ---- */

    -- 每一次作答一行。(user_id, attempt_id) 唯一 = 客户端重发不会重复计数，
    -- 也让“同一次尝试”可以被明确回放，而不是靠时间窗口猜。
    CREATE TABLE IF NOT EXISTS puzzle_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      puzzle_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      row INTEGER NOT NULL,
      col INTEGER NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('CORRECT','INCORRECT','ILLEGAL','OPEN')),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, attempt_id)
    );

    -- 每题一行进度：SOLVED 一旦达成不会被后来的答错覆盖（进度是成绩，不是最近一次状态）。
    CREATE TABLE IF NOT EXISTS puzzle_progress (
      user_id TEXT NOT NULL REFERENCES users(id),
      puzzle_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('SOLVED','FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      first_solved_at INTEGER,
      last_verdict TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, puzzle_id)
    );

    CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_user ON puzzle_attempts (user_id, puzzle_id);

    /* ---- 每日训练 Session（本轮新增，纯增量、幂等）---- */

    -- 每个用户每天一条：题目顺序当天固定，不再重新随机。
    CREATE TABLE IF NOT EXISTS daily_puzzle_sessions (
      user_id TEXT NOT NULL REFERENCES users(id),
      daily_key TEXT NOT NULL,
      puzzle_ids_json TEXT NOT NULL,
      current_index INTEGER NOT NULL DEFAULT 0,
      solved_count INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, daily_key)
    );

    -- 正解落子持久化：刷新/重登后必须还能看到玩家自己下的那一步。
    -- 存的是**玩家实际选择的**正确落子（不是答案集里的第一个）。
    CREATE TABLE IF NOT EXISTS daily_puzzle_solutions (
      user_id TEXT NOT NULL REFERENCES users(id),
      daily_key TEXT NOT NULL,
      puzzle_id TEXT NOT NULL,
      row INTEGER NOT NULL,
      col INTEGER NOT NULL,
      seat TEXT NOT NULL,
      attempt_id TEXT,
      solved_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, daily_key, puzzle_id)
    );

    /* ---- P3A 数据与隐私（规格 6.1 / 7.1 / 7.2，表名对齐 §8 建议） ---- */

    -- 训练许可：默认无记录 = 不纳入；版本不符 = 不纳入；撤回写 revoked_at 并保留版本以便审计。
    CREATE TABLE IF NOT EXISTS user_consents (
      user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      version TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      revoked_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    );

    -- 第一方产品事件：eventId 主键 = 天然去重；带 sample/test/source 标签，聚合时排除 bot 与合成。
    CREATE TABLE IF NOT EXISTS product_events (
      event_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT,
      game_id TEXT,
      source TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0,
      is_sample INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_product_events_name_time ON product_events (name, created_at);
    CREATE INDEX IF NOT EXISTS idx_product_events_user ON product_events (user_id, created_at);

    -- 数据集运行登记（规格 6.3 / D04）：相同 seed 区间 + 配置 + 轨迹哈希的阶段重跑不算新增独立样本。
    CREATE TABLE IF NOT EXISTS dataset_runs (
      run_id TEXT PRIMARY KEY,
      seed_from INTEGER NOT NULL,
      seed_to INTEGER NOT NULL,
      source_sha TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      budget TEXT NOT NULL,
      trajectory_hash TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      seed_key TEXT NOT NULL,
      unique_sample_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dataset_runs_identity ON dataset_runs (seed_key, config_hash, trajectory_hash);

    -- 数据导出/删除任务（异步登记 + 结果落库）。
    CREATE TABLE IF NOT EXISTS data_tasks (
      task_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('EXPORT','DELETE')),
      status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
      requested_at INTEGER NOT NULL,
      finished_at INTEGER,
      result_json TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_data_tasks_user ON data_tasks (user_id, requested_at);

    -- 举报：先人工复核（PENDING），不做任何自动封禁。
    CREATE TABLE IF NOT EXISTS reports (
      report_id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id),
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      reviewer_id TEXT,
      review_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at);

    -- 屏蔽：只有用户主动屏蔽，没有系统自动拉黑。
    CREATE TABLE IF NOT EXISTS blocks (
      user_id TEXT NOT NULL REFERENCES users(id),
      blocked_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, blocked_id)
    );

    -- 管理员审计：谁在什么时候对什么做了什么。
    CREATE TABLE IF NOT EXISTS admin_audit (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_kind TEXT,
      target_id TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit (created_at);
    CREATE INDEX IF NOT EXISTS idx_puzzle_progress_status ON puzzle_progress (user_id, status);

    -- 进行中对局的座位归属（终局即删除）。没有它，API 就无法区分
    -- “这局不是你的”（404）与“这局还没结束”（409）。
    CREATE TABLE IF NOT EXISTS live_games (
      game_id TEXT PRIMARY KEY,
      seats_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // 轻量迁移：老库 matches 表补 Player Leave System 列（幂等）
  const ensureColumn = (table: string, col: string, ddl: string): void => {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  ensureColumn('matches', 'end_reason', "end_reason TEXT NOT NULL DEFAULT 'NORMAL_WIN'");
  ensureColumn('matches', 'winner_ids', "winner_ids TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('matches', 'loser_ids', "loser_ids TEXT NOT NULL DEFAULT '[]'");
  // P1：账号来源标记。老库补列时默认 HUMAN —— 既有真实用户不会被误当成合成账号。
  ensureColumn('users', 'source', "source TEXT NOT NULL DEFAULT 'HUMAN'");
  // P3A：角色由受控 CLI 授予（不硬编码邮箱）；注销只做去标识，不物理删除他人相关记录。
  ensureColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'USER'");
  ensureColumn('users', 'deleted_at', 'deleted_at INTEGER');
  // 增量 C：账号类型。老库补列默认 CLAIMED —— 既有正式用户天然就是“已领取”，不需要单独迁移。
  ensureColumn('users', 'account_type', "account_type TEXT NOT NULL DEFAULT 'CLAIMED'");
  ensureColumn('users', 'claimed_at', 'claimed_at INTEGER');
  // 增量 C：最近活动时间（会话校验时刷新），仅供闲置临时账号清理队列使用。
  ensureColumn('users', 'last_seen_at', 'last_seen_at INTEGER NOT NULL DEFAULT 0');

  const mapUser = (r: Record<string, unknown> | undefined): User | null => {
    if (!r) return null;
    return {
      id: String(r.id),
      email: String(r.email),
      username: String(r.username),
      avatar: String(r.avatar),
      passwordHash: String(r.password_hash),
      salt: String(r.salt),
      createdAt: Number(r.created_at),
      tutorialCompleted: Number(r.tutorial_completed) === 1,
      onlineStatus: r.online_status as User['onlineStatus'],
      rating: Number(r.rating),
      // role 是 P4 迁移加的列：老库补列后默认 USER，这里用 COALESCE 兼容两种行。
      role: (r.role === 'ADMIN' ? 'ADMIN' : 'USER') as User['role'],
      // account_type 是增量 C 加的列：老库补列后默认 CLAIMED。
      accountType: (r.account_type === 'PROVISIONAL' ? 'PROVISIONAL' : 'CLAIMED') as User['accountType'],
      claimedAt: r.claimed_at == null ? null : Number(r.claimed_at),
      lastSeenAt: Number(r.last_seen_at ?? 0),
    };
  };

  const db: Db = {
    raw,
    createUser(input) {
      const id = randomUUID();
      const createdAt = Date.now();
      raw.prepare('INSERT INTO users (id,email,username,avatar,password_hash,salt,created_at,online_status,rating,account_type,claimed_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, input.email, input.username, '', input.passwordHash, input.salt, createdAt, 'online', 1200,
        input.accountType ?? 'CLAIMED', input.accountType === 'PROVISIONAL' ? null : createdAt, createdAt,
      );
      raw.prepare('INSERT INTO ranking (user_id,wins,games,score) VALUES (?,0,0,0)').run(id);
      return db.findUserById(id)!;
    },
    findUserByEmail(email) {
      return mapUser(raw.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, unknown> | undefined);
    },
    findUserByUsername(username) {
      return mapUser(raw.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined);
    },
    findUserByUsernameCI(username) {
      return mapUser(
        raw.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as Record<string, unknown> | undefined,
      );
    },
    findUserById(id) {
      return mapUser(raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined);
    },
    touchOnline(id, status) {
      raw.prepare('UPDATE users SET online_status = ? WHERE id = ?').run(status, id);
    },
    touchLastSeen(userId) {
      raw.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), userId);
    },
    claimAccount(userId, patch) {
      // 原地领取：只改这一行，userId 不变，所以对局/积分/好友/历史全部保留。
      const now = Date.now();
      const r = raw.prepare(
        "UPDATE users SET username = ?, password_hash = ?, salt = ?, email = ?, avatar = ?, account_type = 'CLAIMED', claimed_at = ? WHERE id = ?",
      ).run(patch.username, patch.passwordHash, patch.salt, patch.email, patch.avatar, now, userId);
      if (Number(r.changes ?? 0) === 0) return null;
      return db.findUserById(userId);
    },
    listProvisionalCleanupCandidates(idleBefore, limit = 200) {
      // “无资产”= 没有对局记录、没有好友、没有已结算名次。有资产的账号一律不进队列。
      const rows = raw.prepare(`
        SELECT u.id, u.username, u.created_at, u.last_seen_at
        FROM users u
        WHERE COALESCE(u.account_type,'CLAIMED') = 'PROVISIONAL'
          AND COALESCE(u.last_seen_at, 0) < ?
          AND NOT EXISTS (SELECT 1 FROM match_participants mp WHERE mp.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.user_id = u.id OR f.friend_id = u.id)
        ORDER BY u.last_seen_at ASC
        LIMIT ?
      `).all(idleBefore, limit) as Array<{ id: string; username: string; created_at: number; last_seen_at: number }>;
      return rows.map((r) => ({ id: String(r.id), username: String(r.username), createdAt: Number(r.created_at), lastSeenAt: Number(r.last_seen_at ?? 0) }));
    },
    accountTypeSummary() {
      const one = (sql: string): number => Number((raw.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
      return {
        provisional: one("SELECT COUNT(*) AS n FROM users WHERE COALESCE(account_type,'CLAIMED') = 'PROVISIONAL'"),
        claimed: one("SELECT COUNT(*) AS n FROM users WHERE COALESCE(account_type,'CLAIMED') = 'CLAIMED'"),
        idleProvisional: one("SELECT COUNT(*) AS n FROM users WHERE COALESCE(account_type,'CLAIMED') = 'PROVISIONAL' AND COALESCE(last_seen_at,0) < " + String(Date.now() - 30 * 24 * 3600 * 1000)),
      };
    },
    createSession(token, userId, expiresAt) {
      raw.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
    },
    createWsTicket(ticketHash, userId, expiresAt) {
    raw.prepare('INSERT INTO ws_tickets (ticket_hash,user_id,expires_at,consumed_at,created_at) VALUES (?,?,?,NULL,?)')
      .run(ticketHash, userId, expiresAt, Date.now());
  },
  peekWsTicket(ticketHash, now) {
    const r = raw.prepare('SELECT user_id, expires_at, consumed_at FROM ws_tickets WHERE ticket_hash = ?').get(ticketHash) as
      { user_id: string; expires_at: number; consumed_at: number | null } | undefined;
    if (!r || r.consumed_at !== null || r.expires_at < now) return null;
    return { userId: r.user_id };
  },
  consumeWsTicket(ticketHash, now) {
    // 单次消费必须是**原子**的：UPDATE ... WHERE consumed_at IS NULL 的 changes 才是唯一判据，
    // “先查再改”在并发下会让同一张票据被用两次。
    const r = raw.prepare('UPDATE ws_tickets SET consumed_at = ? WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at >= ?')
      .run(now, ticketHash, now);
    if (Number(r.changes ?? 0) !== 1) return null;
    const row = raw.prepare('SELECT user_id FROM ws_tickets WHERE ticket_hash = ?').get(ticketHash) as { user_id: string } | undefined;
    return row ? { userId: row.user_id } : null;
  },
  findSession(token) {
      const r = raw.prepare('SELECT token,user_id,expires_at FROM sessions WHERE token = ?').get(token) as
        | { token: string; user_id: string; expires_at: number }
        | undefined;
      if (!r) return null;
      return { token: r.token, userId: r.user_id, expiresAt: Number(r.expires_at) };
    },
    deleteSession(token) {
      raw.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },
    setTutorialCompleted(userId, done) {
      raw.prepare('UPDATE users SET tutorial_completed = ? WHERE id = ?').run(done ? 1 : 0, userId);
    },
    ranking(limit, offset = 0) {
      // 规格 4.1：合成用户、测试账号、管理员演示账号不进入公开排行榜
      // —— 是「来源标记 + 查询过滤」，不是删用户。
      // 增量 C：未领取的临时账号同样不进公开排行榜（一次性匿名账号不该出现在正式榜单上）。
      const rows = raw
        .prepare(
          `SELECT u.id,u.username,u.avatar,u.online_status,u.rating,
                  COALESCE(r.wins,0) AS wins, COALESCE(r.games,0) AS games
           FROM users u LEFT JOIN ranking r ON r.user_id = u.id
           WHERE COALESCE(u.source,'HUMAN') = 'HUMAN'
             AND COALESCE(u.account_type,'CLAIMED') = 'CLAIMED'
           ORDER BY u.rating DESC, u.created_at ASC, u.id ASC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as Array<Record<string, unknown>>;
      return rows.map((x) => ({
        id: String(x.id),
        username: String(x.username),
        avatar: String(x.avatar),
        onlineStatus: x.online_status as User['onlineStatus'],
        rating: Number(x.rating),
        wins: Number(x.wins),
        games: Number(x.games),
        winRate: Number(x.games) > 0 ? Number(x.wins) / Number(x.games) : 0,
      }));
    },
    recordMatchResult(userId, delta) {
      raw.prepare('UPDATE ranking SET games = games + 1, wins = wins + CASE WHEN ? > 0 THEN 1 ELSE 0 END, score = score + ? WHERE user_id = ?').run(delta, delta, userId);
      raw.prepare('UPDATE users SET rating = MAX(0, rating + ?) WHERE id = ?').run(delta, userId);
    },
    settleMatch(input) {
      // 快路径：已结算则原样返回数据库中的既有结果，绝不二次入账。
      const pre = db.findMatchResult(input.gameId);
      if (pre) return { ...pre, alreadySettled: true };

      const settledAt = Date.now();
      const digest = settlementDigest(input);
      const winnerSeat = input.winnerSeat ?? null;
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw
          .prepare('INSERT OR REPLACE INTO games (id,board_size,mode,winner,created_at,moves_json) VALUES (?,?,?,?,?,?)')
          .run(input.gameId, input.boardSize, input.mode, winnerSeat, settledAt, input.movesJson);

        // 幂等闸门：PRIMARY KEY(game_id)。并发/重复提交在这里被数据库拒绝。
        raw
          .prepare(
            `INSERT INTO match_results
               (game_id,match_id,mode,board_size,end_reason,winner_seat,winner_user_ids,loser_ids,is_ranked,score_policy,settlement_digest,settled_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            input.gameId, input.matchId, input.mode, input.boardSize, input.endReason,
            winnerSeat, JSON.stringify(input.winnerUserIds), JSON.stringify(input.loserIds),
            input.isRanked ? 1 : 0, input.scorePolicy, digest, settledAt,
          );

        // 历史 matches 行：保持旧查询（player_a/b/c、result 为座位）与既有测试契约。
        raw
          .prepare(
            'INSERT OR REPLACE INTO matches (id,game_id,player_a,player_b,player_c,result,end_reason,winner_ids,loser_ids,is_ranked,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            input.matchId, input.gameId,
            input.players[0] ?? null, input.players[1] ?? null, input.players[2] ?? null,
            winnerSeat, input.endReason,
            JSON.stringify(input.winnerUserIds), JSON.stringify(input.loserIds),
            input.isRanked ? 1 : 0, settledAt,
          );

        const settled: SettledParticipant[] = [];
        for (const p of input.participants) {
          raw
            .prepare('INSERT INTO match_participants (game_id,seat,kind,user_id,outcome,rating_delta) VALUES (?,?,?,?,?,?)')
            .run(input.gameId, p.seat, p.kind, p.userId ?? null, p.outcome, p.ratingDelta);
          settled.push({ seat: p.seat, kind: p.kind, userId: p.userId ?? null, outcome: p.outcome, ratingDelta: p.ratingDelta });
        }

        for (const p of settled) {
          // 只有参与了排位且确有分差的真人才会写账本 / 改分。
          // DRAW 记一局不变分；VOID（系统中止、仍在自身宽限期）完全不产生竞技变更。
          if (p.kind !== 'human' || !p.userId || !input.isRanked || p.outcome === 'VOID') continue;
          raw.prepare('INSERT OR IGNORE INTO ranking (user_id,wins,games,score) VALUES (?,0,0,0)').run(p.userId);
          const beforeRow = raw.prepare('SELECT rating FROM users WHERE id = ?').get(p.userId) as { rating?: number } | undefined;
          const ratingBefore = Number(beforeRow?.rating ?? 0);
          if (p.ratingDelta !== 0) {
            raw.prepare('UPDATE users SET rating = MAX(0, rating + ?) WHERE id = ?').run(p.ratingDelta, p.userId);
          }
          raw
            .prepare('UPDATE ranking SET games = games + 1, wins = wins + CASE WHEN ? > 0 THEN 1 ELSE 0 END, score = score + ? WHERE user_id = ?')
            .run(p.ratingDelta, p.ratingDelta, p.userId);
          const afterRow = raw.prepare('SELECT rating FROM users WHERE id = ?').get(p.userId) as { rating?: number } | undefined;
          const ratingAfter = Number(afterRow?.rating ?? 0);
          raw
            .prepare('INSERT INTO rating_ledger (id,game_id,user_id,seat,delta,rating_before,rating_after,policy,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), input.gameId, p.userId, p.seat, p.ratingDelta, ratingBefore, ratingAfter, input.scorePolicy, settledAt);
        }

        raw.exec('COMMIT');
        return {
          gameId: input.gameId,
          alreadySettled: false,
          settledAt,
          digest,
          mode: input.mode,
          boardSize: input.boardSize,
          endReason: input.endReason,
          winnerSeat,
          winnerUserIds: [...input.winnerUserIds],
          loserIds: [...input.loserIds],
          isRanked: input.isRanked,
          scorePolicy: input.scorePolicy,
          participants: settled,
        };
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* 连接已处于无事务状态：原始错误更重要，不掩盖 */
        }
        // 并发下另一个写入者可能刚好赢下 PK；此时回滚后按“已结算”返回既有行。
        const raced = db.findMatchResult(input.gameId);
        if (raced) return { ...raced, alreadySettled: true };
        throw err;
      }
    },
    findMatchResult(gameId) {
      const r = raw.prepare('SELECT * FROM match_results WHERE game_id = ?').get(gameId) as Record<string, unknown> | undefined;
      if (!r) return null;
      const parts = db.listMatchParticipants(gameId);
      return {
        gameId: String(r.game_id),
        alreadySettled: true,
        settledAt: Number(r.settled_at),
        digest: String(r.settlement_digest),
        mode: String(r.mode),
        boardSize: Number(r.board_size),
        endReason: String(r.end_reason),
        winnerSeat: r.winner_seat == null ? null : String(r.winner_seat),
        winnerUserIds: JSON.parse(String(r.winner_user_ids)) as string[],
        loserIds: JSON.parse(String(r.loser_ids)) as string[],
        isRanked: Number(r.is_ranked) === 1,
        scorePolicy: String(r.score_policy),
        participants: parts,
      };
    },
    listMatchParticipants(gameId) {
      const rows = raw
        .prepare('SELECT seat,kind,user_id,outcome,rating_delta FROM match_participants WHERE game_id = ? ORDER BY seat ASC')
        .all(gameId) as Array<Record<string, unknown>>;
      return rows.map((x) => ({
        seat: String(x.seat),
        kind: String(x.kind) as 'human' | 'ai',
        userId: x.user_id == null ? null : String(x.user_id),
        outcome: String(x.outcome) as ParticipantOutcome,
        ratingDelta: Number(x.rating_delta),
      }));
    },
    listRatingLedger(gameId) {
      const rows = raw
        .prepare('SELECT id,game_id,user_id,seat,delta,rating_before,rating_after,policy,created_at FROM rating_ledger WHERE game_id = ? ORDER BY created_at ASC, id ASC')
        .all(gameId) as Array<Record<string, unknown>>;
      return rows.map((x) => ({
        id: String(x.id),
        gameId: String(x.game_id),
        userId: String(x.user_id),
        seat: String(x.seat),
        delta: Number(x.delta),
        ratingBefore: Number(x.rating_before),
        ratingAfter: Number(x.rating_after),
        policy: String(x.policy),
        createdAt: Number(x.created_at),
      }));
    },
    saveGame(input) {
      raw
        .prepare('INSERT OR REPLACE INTO games (id,board_size,mode,winner,created_at,moves_json) VALUES (?,?,?,?,?,?)')
        .run(input.id, input.boardSize, input.mode, input.winner, input.createdAt, input.movesJson);
    },
    saveMatch(input) {
      raw
        .prepare(
          'INSERT OR REPLACE INTO matches (id,game_id,player_a,player_b,player_c,result,end_reason,winner_ids,loser_ids,is_ranked,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          input.id,
          input.gameId,
          input.players[0],
          input.players[1],
          input.players[2],
          input.result,
          input.endReason ?? 'NORMAL_WIN',
          JSON.stringify(input.winnerIds ?? []),
          JSON.stringify(input.loserIds ?? []),
          input.isRanked ? 1 : 0,
          input.createdAt,
        );
    },
    appendGameCommand(input) {
      const digest = commandPayloadDigest(input.payload);
      // 快路径：命中已有命令直接返回，不进事务、不写任何行。
      const existing = db.findGameCommand(input.gameId, input.commandId);
      if (existing) {
        return {
          appended: false,
          duplicate: existing.payloadDigest === digest,
          conflict: existing.payloadDigest !== digest,
          revision: existing.revisionAfter,
          seq: existing.seq,
          ack: JSON.parse(existing.ackJson) as unknown,
          row: existing,
        };
      }
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw
          .prepare('INSERT INTO game_events (game_id,seq,revision,type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
          .run(input.gameId, input.seq, input.revisionAfter, input.eventType, JSON.stringify(input.eventPayload ?? null), input.createdAt);
        raw
          .prepare('INSERT OR REPLACE INTO game_snapshots (game_id,revision,state_json,created_at) VALUES (?,?,?,?)')
          .run(input.gameId, input.revisionAfter, JSON.stringify(input.snapshot ?? null), input.createdAt);
        // 幂等闸门：并发/重复提交在这里被 PRIMARY KEY 拒绝。
        raw
          .prepare(
            'INSERT INTO game_commands (game_id,command_id,seat,payload_digest,revision_before,revision_after,seq,ack_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .run(
            input.gameId, input.commandId, input.seat, digest,
            input.revisionBefore, input.revisionAfter, input.seq,
            JSON.stringify(input.ack ?? null), input.createdAt,
          );
        raw.exec('COMMIT');
        return {
          appended: true, duplicate: false, conflict: false,
          revision: input.revisionAfter, seq: input.seq, ack: input.ack ?? null, row: null,
        };
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* 事务已不在：原始错误更重要 */
        }
        // 并发下另一个写入者赢了 PK —— 回滚后按“已生效命令”返回既有结果。
        const raced = db.findGameCommand(input.gameId, input.commandId);
        if (raced) {
          return {
            appended: false,
            duplicate: raced.payloadDigest === digest,
            conflict: raced.payloadDigest !== digest,
            revision: raced.revisionAfter,
            seq: raced.seq,
            ack: JSON.parse(raced.ackJson) as unknown,
            row: raced,
          };
        }
        throw err;
      }
    },
    findGameCommand(gameId, commandId) {
      const r = raw
        .prepare('SELECT * FROM game_commands WHERE game_id = ? AND command_id = ?')
        .get(gameId, commandId) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        gameId: String(r.game_id),
        commandId: String(r.command_id),
        seat: String(r.seat),
        payloadDigest: String(r.payload_digest),
        revisionBefore: Number(r.revision_before),
        revisionAfter: Number(r.revision_after),
        seq: Number(r.seq),
        ackJson: String(r.ack_json),
        createdAt: Number(r.created_at),
      };
    },
    listGameEvents(gameId) {
      const rows = raw
        .prepare('SELECT seq,revision,type,payload_json,created_at FROM game_events WHERE game_id = ? ORDER BY seq ASC')
        .all(gameId) as Array<Record<string, unknown>>;
      return rows.map((x) => ({
        seq: Number(x.seq),
        revision: Number(x.revision),
        type: String(x.type),
        payload: JSON.parse(String(x.payload_json)) as unknown,
        createdAt: Number(x.created_at),
      }));
    },
    loadRecoverableGames() {
      // 注意：不能 JOIN games —— games 行只在**终局结算**时写入，
      // 进行中的对局在 games 表里还不存在。mode/boardSize 一律从快照本身读取。
      const rows = raw
        .prepare(
          `SELECT s.game_id, s.revision, s.state_json
             FROM game_snapshots s
             JOIN (SELECT game_id, MAX(revision) AS r FROM game_snapshots GROUP BY game_id) m
               ON m.game_id = s.game_id AND m.r = s.revision
             LEFT JOIN match_results mr ON mr.game_id = s.game_id
            WHERE mr.game_id IS NULL
            ORDER BY s.created_at ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map((x) => {
        const snapshot = JSON.parse(String(x.state_json)) as { mode?: string; state?: { boardSize?: number } } | null;
        return {
          gameId: String(x.game_id),
          revision: Number(x.revision),
          seq: Number((raw.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM game_events WHERE game_id = ?').get(String(x.game_id)) as any)?.s ?? 0),
          mode: String(snapshot?.mode ?? 'online'),
          boardSize: Number(snapshot?.state?.boardSize ?? 0),
          snapshot,
        };
      });
    },
    setUserSource(userId, source) {
      raw.prepare('UPDATE users SET source = ? WHERE id = ?').run(source, userId);
    },
    getUserSource(userId) {
      const r = raw.prepare('SELECT COALESCE(source, ?, ?) AS source FROM users WHERE id = ?').get('HUMAN', 'HUMAN', userId) as { source?: string } | undefined;
      return (r?.source ?? 'HUMAN') as AccountSource;
    },
    countRecentMatchesForUsers(userIds, sinceMs) {
      if (userIds.length === 0) return 0;
      // 统计「恰好包含这一组人」的已结算对局：三名玩家的集合必须完全相同。
      const placeholders = userIds.map(() => '?').join(',');
      const r = raw
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT mr.game_id
               FROM rating_ledger rl
               JOIN match_results mr ON mr.game_id = rl.game_id
              WHERE rl.user_id IN (${placeholders}) AND mr.settled_at >= ?
              GROUP BY mr.game_id
             HAVING COUNT(DISTINCT rl.user_id) = ?
           )`,
        )
        .get(...(userIds as never[]), sinceMs, userIds.length) as { n?: number } | undefined;
      return Number(r?.n ?? 0);
    },
    createInvitation(senderId, receiverId) {
      const id = randomUUID();
      const createdAt = Date.now();
      raw.prepare("INSERT INTO invitations (id,sender,receiver,status,created_at) VALUES (?,?,?,'pending',?)").run(id, senderId, receiverId, createdAt);
      return { id, status: 'pending', createdAt };
    },
    listInvitationsFor(userId) {
      const rows = raw
        .prepare(
          `SELECT i.id, i.sender, u.username AS senderName, i.receiver, i.status, i.created_at AS createdAt
           FROM invitations i JOIN users u ON u.id = i.sender
           WHERE i.receiver = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
        )
        .all(userId) as Array<Record<string, unknown>>;
      return rows.map((x) => ({
        id: String(x.id),
        sender: String(x.sender),
        senderName: String(x.senderName),
        receiver: String(x.receiver),
        status: String(x.status),
        createdAt: Number(x.createdAt),
      }));
    },
    findInvitation(id) {
      const r = raw.prepare('SELECT id, sender, receiver, status FROM invitations WHERE id = ?').get(id) as
        | { id: string; sender: string; receiver: string; status: string }
        | undefined;
      return r ?? null;
    },
    setInvitationStatus(id, status) {
      raw.prepare('UPDATE invitations SET status = ? WHERE id = ?').run(status, id);
    },
    addFriends(a, b) {
      raw.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id,status) VALUES (?,?,?)').run(a, b, 'accepted');
      raw.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id,status) VALUES (?,?,?)').run(b, a, 'accepted');
    },
    listFriends(userId) {
      const rows = raw.prepare('SELECT friend_id FROM friends WHERE user_id = ?').all(userId) as Array<{ friend_id: string }>;
      return rows.map((x) => String(x.friend_id));
    },
    historyFor(userId, limit, offset) {
      // 只读本人座位视角：对手的 user_id / 邮箱一律不出现在返回结构里。
      const rows = raw
        .prepare(
          `SELECT mp.game_id, mp.seat, mp.outcome, mp.rating_delta,
                  mr.mode, mr.board_size, mr.end_reason, mr.winner_seat, mr.is_ranked, mr.score_policy, mr.settled_at,
                  (SELECT COUNT(*) FROM game_events e WHERE e.game_id = mp.game_id AND e.type = 'move.applied') AS move_count,
                  (SELECT COUNT(*) FROM share_links s
                    WHERE s.game_id = mp.game_id AND s.owner_id = mp.user_id
                      AND s.revoked_at IS NULL AND s.expires_at > ?) AS share_count
             FROM match_participants mp
             JOIN match_results mr ON mr.game_id = mp.game_id
            WHERE mp.user_id = ?
            ORDER BY mr.settled_at DESC, mp.game_id DESC
            LIMIT ? OFFSET ?`,
        )
        .all(Date.now(), userId, limit, offset) as Array<Record<string, unknown>>;
      return rows.map((x) => ({
        gameId: String(x.game_id),
        seat: String(x.seat),
        outcome: String(x.outcome) as ParticipantOutcome,
        ratingDelta: Number(x.rating_delta),
        mode: String(x.mode),
        boardSize: Number(x.board_size),
        endReason: String(x.end_reason),
        winnerSeat: x.winner_seat === null ? null : String(x.winner_seat),
        isRanked: Number(x.is_ranked) === 1,
        scorePolicy: String(x.score_policy),
        settledAt: Number(x.settled_at),
        moveCount: Number(x.move_count),
        hasShare: Number(x.share_count) > 0,
      }));
    },
    historyCount(userId) {
      const r = raw
        .prepare('SELECT COUNT(*) AS n FROM match_participants mp JOIN match_results mr ON mr.game_id = mp.game_id WHERE mp.user_id = ?')
        .get(userId) as { n?: number } | undefined;
      return Number(r?.n ?? 0);
    },
    participantOf(userId, gameId) {
      const r = raw
        .prepare('SELECT seat, outcome, rating_delta FROM match_participants WHERE game_id = ? AND user_id = ?')
        .get(gameId, userId) as Record<string, unknown> | undefined;
      if (!r) return null;
      return { seat: String(r.seat), outcome: String(r.outcome) as ParticipantOutcome, ratingDelta: Number(r.rating_delta) };
    },
    openLiveGame(gameId, members) {
      raw
        .prepare('INSERT OR REPLACE INTO live_games (game_id,seats_json,created_at) VALUES (?,?,?)')
        .run(gameId, JSON.stringify(members), Date.now());
    },
    closeLiveGame(gameId) {
      raw.prepare('DELETE FROM live_games WHERE game_id = ?').run(gameId);
    },
    seatInLiveGame(userId, gameId) {
      const live = raw.prepare('SELECT seats_json FROM live_games WHERE game_id = ?').get(gameId) as { seats_json?: string } | undefined;
      if (live?.seats_json) {
        try {
          const seats = JSON.parse(live.seats_json) as Record<string, string>;
          if (typeof seats[userId] === 'string') return seats[userId];
        } catch {
          /* 记录损坏时继续用快照兜底 */
        }
      }
      const snap = db.latestSnapshot(gameId);
      if (!snap) return null;
      try {
        const parsed = JSON.parse(snap.stateJson) as { members?: Record<string, string> } | null;
        const seat = parsed?.members?.[userId];
        return typeof seat === 'string' ? seat : null;
      } catch {
        return null;
      }
    },
    getDailySession(userId, dailyKey) {
      const r = raw.prepare('SELECT * FROM daily_puzzle_sessions WHERE user_id = ? AND daily_key = ?').get(userId, dailyKey) as Record<string, unknown> | undefined;
      if (!r) return null;
      let ids: string[] = [];
      try { ids = JSON.parse(String(r.puzzle_ids_json)) as string[]; } catch { ids = []; }
      return {
        userId: String(r.user_id), dailyKey: String(r.daily_key), puzzleIds: ids,
        currentIndex: Number(r.current_index), solvedCount: Number(r.solved_count), total: Number(r.total),
        completedAt: r.completed_at == null ? null : Number(r.completed_at),
        createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      };
    },
    createDailySession(input) {
      const now = Date.now();
      // OR IGNORE：两个并发请求同时创建时，只有第一条生效（题目顺序因此不会被后到的请求改掉）。
      raw.prepare('INSERT OR IGNORE INTO daily_puzzle_sessions (user_id,daily_key,puzzle_ids_json,current_index,solved_count,total,completed_at,created_at,updated_at) VALUES (?,?,?,0,0,?,NULL,?,?)')
        .run(input.userId, input.dailyKey, JSON.stringify(input.puzzleIds), input.puzzleIds.length, now, now);
      return db.getDailySession(input.userId, input.dailyKey)!;
    },
    advanceDailySession(userId, dailyKey, expectedIndex) {
      // CAS：只有当前索引仍然是调用方看到的那个值才前进，双请求只会成功一次。
      const r = raw.prepare('UPDATE daily_puzzle_sessions SET current_index = current_index + 1, updated_at = ? WHERE user_id = ? AND daily_key = ? AND current_index = ?')
        .run(Date.now(), userId, dailyKey, expectedIndex);
      return { advanced: Number(r.changes ?? 0) === 1, session: db.getDailySession(userId, dailyKey) };
    },
    markDailySessionCompleted(userId, dailyKey) {
      raw.prepare('UPDATE daily_puzzle_sessions SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE user_id = ? AND daily_key = ?')
        .run(Date.now(), Date.now(), userId, dailyKey);
    },
    recordDailySolved(input) {
      const inserted = raw.prepare('INSERT OR IGNORE INTO daily_puzzle_solutions (user_id,daily_key,puzzle_id,row,col,seat,attempt_id,solved_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(input.userId, input.dailyKey, input.puzzleId, input.row, input.col, input.seat, input.attemptId, Date.now());
      const isNew = Number(inserted.changes ?? 0) === 1;
      if (isNew) {
        raw.prepare('UPDATE daily_puzzle_sessions SET solved_count = solved_count + 1, updated_at = ? WHERE user_id = ? AND daily_key = ?')
          .run(Date.now(), input.userId, input.dailyKey);
      }
      const row = raw.prepare('SELECT solved_count FROM daily_puzzle_sessions WHERE user_id = ? AND daily_key = ?').get(input.userId, input.dailyKey) as { solved_count?: number } | undefined;
      return { inserted: isNew, solvedCount: Number(row?.solved_count ?? 0) };
    },
    getDailySolution(userId, dailyKey, puzzleId) {
      const r = raw.prepare('SELECT row, col, seat, solved_at FROM daily_puzzle_solutions WHERE user_id = ? AND daily_key = ? AND puzzle_id = ?').get(userId, dailyKey, puzzleId) as Record<string, unknown> | undefined;
      if (!r) return null;
      return { row: Number(r.row), col: Number(r.col), seat: String(r.seat), solvedAt: Number(r.solved_at) };
    },
    listDailySolutions(userId, dailyKey) {
      const rows = raw.prepare('SELECT puzzle_id, row, col, seat, solved_at FROM daily_puzzle_solutions WHERE user_id = ? AND daily_key = ? ORDER BY solved_at ASC').all(userId, dailyKey) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ puzzleId: String(r.puzzle_id), row: Number(r.row), col: Number(r.col), seat: String(r.seat), solvedAt: Number(r.solved_at) }));
    },
    findPuzzleAttempt(userId, attemptId) {
      const r = raw
        .prepare('SELECT puzzle_id, row, col, verdict, created_at FROM puzzle_attempts WHERE user_id = ? AND attempt_id = ?')
        .get(userId, attemptId) as Record<string, unknown> | undefined;
      if (!r) return null;
      return { puzzleId: String(r.puzzle_id), row: Number(r.row), col: Number(r.col), verdict: String(r.verdict), createdAt: Number(r.created_at) };
    },
    recordPuzzleAttempt(input) {
      const existing = db.findPuzzleAttempt(input.userId, input.attemptId);
      if (existing) {
        const cur = raw
          .prepare('SELECT attempts, first_solved_at FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?')
          .get(input.userId, existing.puzzleId) as { attempts?: number; first_solved_at?: number | null } | undefined;
        return {
          duplicate: true,
          attempts: Number(cur?.attempts ?? 0),
          solved: existing.verdict === 'CORRECT',
          firstSolvedAt: cur?.first_solved_at === null || cur?.first_solved_at === undefined ? null : Number(cur.first_solved_at),
        };
      }
      const now = Date.now();
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw
          .prepare('INSERT INTO puzzle_attempts (id,user_id,puzzle_id,attempt_id,row,col,verdict,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(randomUUID(), input.userId, input.puzzleId, input.attemptId, input.row, input.col, input.verdict, now);
        const prev = raw
          .prepare('SELECT status, attempts, first_solved_at FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?')
          .get(input.userId, input.puzzleId) as { status?: string; attempts?: number; first_solved_at?: number | null } | undefined;
        const solvedBefore = prev?.status === 'SOLVED';
        const solvedNow = solvedBefore || input.verdict === 'CORRECT';
        const firstSolvedAt = prev?.first_solved_at ?? (input.verdict === 'CORRECT' ? now : null);
        const attempts = Number(prev?.attempts ?? 0) + 1;
        raw
          .prepare(
            `INSERT INTO puzzle_progress (user_id,puzzle_id,status,attempts,first_solved_at,last_verdict,updated_at)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT (user_id, puzzle_id) DO UPDATE SET
               status = excluded.status, attempts = excluded.attempts,
               first_solved_at = excluded.first_solved_at, last_verdict = excluded.last_verdict,
               updated_at = excluded.updated_at`,
          )
          .run(input.userId, input.puzzleId, solvedNow ? 'SOLVED' : 'FAILED', attempts, firstSolvedAt, input.verdict, now);
        raw.exec('COMMIT');
        return { duplicate: false, attempts, solved: solvedNow, firstSolvedAt };
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* 事务已不在：原始错误更重要 */ }
        // 并发下同一 attemptId 被另一个写入者抢先 —— 按重发处理，不重复计数。
        const raced = db.findPuzzleAttempt(input.userId, input.attemptId);
        if (raced) {
          const cur = raw
            .prepare('SELECT attempts, first_solved_at FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?')
            .get(input.userId, raced.puzzleId) as { attempts?: number; first_solved_at?: number | null } | undefined;
          return {
            duplicate: true,
            attempts: Number(cur?.attempts ?? 0),
            solved: raced.verdict === 'CORRECT',
            firstSolvedAt: cur?.first_solved_at === null || cur?.first_solved_at === undefined ? null : Number(cur.first_solved_at),
          };
        }
        throw err;
      }
    },
    puzzleProgress(userId) {
      const agg = raw
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'SOLVED' THEN 1 ELSE 0 END) AS solved,
             SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(attempts) AS attempts,
             MIN(first_solved_at) AS first_solved_at
           FROM puzzle_progress WHERE user_id = ?`,
        )
        .get(userId) as Record<string, unknown> | undefined;
      const wrong = raw
        .prepare("SELECT puzzle_id, attempts, last_verdict, updated_at FROM puzzle_progress WHERE user_id = ? AND status = 'FAILED' ORDER BY attempts DESC, updated_at DESC")
        .all(userId) as Array<Record<string, unknown>>;
      return {
        solved: Number(agg?.solved ?? 0),
        failed: Number(agg?.failed ?? 0),
        totalAttempts: Number(agg?.attempts ?? 0),
        firstSolvedAt: agg?.first_solved_at === null || agg?.first_solved_at === undefined ? null : Number(agg.first_solved_at),
        wrong: wrong.map((x) => ({
          puzzleId: String(x.puzzle_id),
          attempts: Number(x.attempts),
          lastVerdict: String(x.last_verdict),
          updatedAt: Number(x.updated_at),
        })),
      };
    },
    matchParticipantViews(gameId) {
      const rows = raw
        .prepare(
          `SELECT mp.seat, mp.outcome, mp.kind, mp.rating_delta, COALESCE(u.source, 'HUMAN') AS source
             FROM match_participants mp
             LEFT JOIN users u ON u.id = mp.user_id
            WHERE mp.game_id = ?
            ORDER BY mp.seat`,
        )
        .all(gameId) as Array<Record<string, unknown>>;
      return rows.map((x) => ({
        seat: String(x.seat),
        outcome: String(x.outcome) as ParticipantOutcome,
        kind: String(x.kind),
        source: String(x.source) as AccountSource,
        ratingDelta: Number(x.rating_delta),
      }));
    },
    latestSnapshot(gameId) {
      const r = raw
        .prepare('SELECT revision, state_json FROM game_snapshots WHERE game_id = ? ORDER BY revision DESC LIMIT 1')
        .get(gameId) as Record<string, unknown> | undefined;
      if (!r) return null;
      const seq = raw.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM game_events WHERE game_id = ?').get(gameId) as { s?: number } | undefined;
      return { revision: Number(r.revision), seq: Number(seq?.s ?? 0), stateJson: String(r.state_json) };
    },
    createShareLink(input) {
      const createdAt = Date.now();
      const expiresAt = createdAt + input.ttlMs;
      raw
        .prepare('INSERT INTO share_links (token,game_id,owner_id,created_at,expires_at,revoked_at,views) VALUES (?,?,?,?,?,NULL,0)')
        .run(input.token, input.gameId, input.ownerId, createdAt, expiresAt);
      return { token: input.token, gameId: input.gameId, ownerId: input.ownerId, createdAt, expiresAt, revokedAt: null, views: 0 };
    },
    findShareLink(token) {
      const r = raw.prepare('SELECT * FROM share_links WHERE token = ?').get(token) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        token: String(r.token),
        gameId: String(r.game_id),
        ownerId: String(r.owner_id),
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
        revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
        views: Number(r.views),
      };
    },
    revokeShareLink(token, ownerId) {
      const res = raw
        .prepare('UPDATE share_links SET revoked_at = ? WHERE token = ? AND owner_id = ? AND revoked_at IS NULL')
        .run(Date.now(), token, ownerId);
      return Number(res.changes ?? 0) > 0;
    },
    listShareLinks(gameId, ownerId) {
      const rows = raw
        .prepare('SELECT * FROM share_links WHERE game_id = ? AND owner_id = ? ORDER BY created_at DESC')
        .all(gameId, ownerId) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        token: String(r.token),
        gameId: String(r.game_id),
        ownerId: String(r.owner_id),
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
        revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
        views: Number(r.views),
      }));
    },
    countShareView(token) {
      raw.prepare('UPDATE share_links SET views = views + 1 WHERE token = ?').run(token);
    },
    /* ---- P3A：许可 / 事件 / 数据集运行 / 数据任务 / 举报屏蔽审计 ---- */
    getUserRole(userId) {
      const r = raw.prepare("SELECT COALESCE(role, 'USER') AS role FROM users WHERE id = ?").get(userId) as { role?: string } | undefined;
      return r?.role === 'ADMIN' ? 'ADMIN' : 'USER';
    },
    setUserRole(userId, role) {
      raw.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    },
    getConsent(userId, kind) {
      const r = raw
        .prepare('SELECT user_id, kind, version, granted_at, revoked_at FROM user_consents WHERE user_id = ? AND kind = ?')
        .get(userId, kind) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        userId: String(r.user_id),
        kind: String(r.kind) as ConsentKind,
        version: String(r.version),
        grantedAt: Number(r.granted_at),
        revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
      };
    },
    grantConsent(input) {
      const now = Date.now();
      raw
        .prepare(
          `INSERT INTO user_consents (user_id,kind,version,granted_at,revoked_at,updated_at) VALUES (?,?,?,?,NULL,?)
           ON CONFLICT (user_id, kind) DO UPDATE SET
             version = excluded.version, granted_at = excluded.granted_at,
             revoked_at = NULL, updated_at = excluded.updated_at`,
        )
        .run(input.userId, input.kind, input.version, now, now);
      return db.getConsent(input.userId, input.kind)!;
    },
    revokeConsent(input) {
      const now = Date.now();
      const existing = db.getConsent(input.userId, input.kind);
      if (!existing) {
        // 撤回一条本来就不存在的许可：同样落一行（可追踪），而不是静默什么都不做。
        raw
          .prepare('INSERT INTO user_consents (user_id,kind,version,granted_at,revoked_at,updated_at) VALUES (?,?,?,?,?,?)')
          .run(input.userId, input.kind, input.version, now, now, now);
      } else {
        raw
          .prepare('UPDATE user_consents SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND kind = ?')
          .run(now, now, input.userId, input.kind);
      }
      return db.getConsent(input.userId, input.kind)!;
    },
    insertProductEvent(input) {
      const res = raw
        .prepare(
          'INSERT OR IGNORE INTO product_events (event_id,name,user_id,game_id,source,is_bot,is_sample,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          input.eventId, input.name, input.userId ?? null, input.gameId ?? null, input.source,
          input.isBot ? 1 : 0, input.isSample ? 1 : 0, JSON.stringify(input.payload ?? {}), Date.now(),
        );
      const inserted = Number(res.changes ?? 0) > 0;
      return { inserted, duplicate: !inserted };
    },
    countProductEvents(input) {
      const clauses = ['name = ?', 'created_at >= ?'];
      if (input.excludeBot !== false) clauses.push('is_bot = 0');
      if (input.excludeSynthetic !== false) clauses.push("source NOT IN ('SYNTHETIC','TEST','BOT')");
      const row = raw
        .prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users, COALESCE(SUM(is_sample),0) AS samples FROM product_events WHERE ${clauses.join(' AND ')}`)
        .get(input.name, input.sinceMs ?? 0) as Record<string, unknown> | undefined;
      return { total: Number(row?.n ?? 0), distinctUsers: Number(row?.users ?? 0), samples: Number(row?.samples ?? 0) };
    },
    registerDatasetRun(input) {
      const seedKey = input.seedFrom + '-' + input.seedTo;
      const existing = raw
        .prepare('SELECT run_id FROM dataset_runs WHERE seed_key = ? AND config_hash = ? AND trajectory_hash = ? LIMIT 1')
        .get(seedKey, input.configHash, input.trajectoryHash) as { run_id?: string } | undefined;
      if (existing) {
        // D04：相同 seed/配置/轨迹的阶段重跑 —— 记账，但不当作新增独立样本。
        return { runId: input.runId, isNewIndependentSample: false, duplicateOf: String(existing.run_id) };
      }
      raw
        .prepare(
          `INSERT INTO dataset_runs (run_id,seed_from,seed_to,source_sha,engine_version,budget,trajectory_hash,config_hash,seed_key,unique_sample_count,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.runId, input.seedFrom, input.seedTo, input.sourceSha, input.engineVersion, input.budget,
          input.trajectoryHash, input.configHash, seedKey, input.uniqueSampleCount, Date.now(),
        );
      return { runId: input.runId, isNewIndependentSample: true, duplicateOf: null };
    },
    listDatasetRuns(limit = 50) {
      const rows = raw
        .prepare('SELECT * FROM dataset_runs ORDER BY created_at DESC LIMIT ?')
        .all(limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        runId: String(r.run_id), seedFrom: Number(r.seed_from), seedTo: Number(r.seed_to),
        sourceSha: String(r.source_sha), engineVersion: String(r.engine_version), budget: String(r.budget),
        trajectoryHash: String(r.trajectory_hash), configHash: String(r.config_hash),
        uniqueSampleCount: Number(r.unique_sample_count), createdAt: Number(r.created_at),
      }));
    },
    createDataTask(input) {
      const taskId = randomUUID();
      const requestedAt = Date.now();
      raw.prepare("INSERT INTO data_tasks (task_id,user_id,kind,status,requested_at) VALUES (?,?,?,'PENDING',?)").run(taskId, input.userId, input.kind, requestedAt);
      return { taskId, status: 'PENDING', requestedAt };
    },
    finishDataTask(input) {
      raw
        .prepare('UPDATE data_tasks SET status = ?, finished_at = ?, result_json = ?, error = ? WHERE task_id = ?')
        .run(input.status, Date.now(), input.result === undefined ? null : JSON.stringify(input.result), input.error ?? null, input.taskId);
    },
    findDataTask(userId, taskId) {
      const r = raw.prepare('SELECT * FROM data_tasks WHERE user_id = ? AND task_id = ?').get(userId, taskId) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        taskId: String(r.task_id), kind: String(r.kind), status: String(r.status),
        requestedAt: Number(r.requested_at),
        finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
        result: r.result_json === null || r.result_json === undefined ? null : JSON.parse(String(r.result_json)),
        error: r.error === null || r.error === undefined ? null : String(r.error),
      };
    },
    listDataTasks(userId) {
      const rows = raw.prepare('SELECT task_id,kind,status,requested_at,finished_at FROM data_tasks WHERE user_id = ? ORDER BY requested_at DESC').all(userId) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        taskId: String(r.task_id), kind: String(r.kind), status: String(r.status),
        requestedAt: Number(r.requested_at),
        finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
      }));
    },
    createReport(input) {
      const reportId = randomUUID();
      const createdAt = Date.now();
      raw
        .prepare('INSERT INTO reports (report_id,reporter_id,target_kind,target_id,reason,detail,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(reportId, input.reporterId, input.targetKind, input.targetId, input.reason, input.detail, 'PENDING', createdAt);
      return { reportId, createdAt };
    },
    listReports(status, limit = 100) {
      const rows = (status
        ? raw.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at ASC LIMIT ?').all(status, limit)
        : raw.prepare('SELECT * FROM reports ORDER BY created_at ASC LIMIT ?').all(limit)) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        reportId: String(r.report_id), reporterId: String(r.reporter_id),
        targetKind: String(r.target_kind), targetId: String(r.target_id),
        reason: String(r.reason), detail: String(r.detail), status: String(r.status),
        createdAt: Number(r.created_at),
        reviewedAt: r.reviewed_at === null || r.reviewed_at === undefined ? null : Number(r.reviewed_at),
        reviewNote: r.review_note === null || r.review_note === undefined ? null : String(r.review_note),
      }));
    },
    reviewReport(input) {
      const res = raw
        .prepare('UPDATE reports SET status = ?, reviewed_at = ?, reviewer_id = ?, review_note = ? WHERE report_id = ?')
        .run(input.status, Date.now(), input.reviewerId, input.note, input.reportId);
      return Number(res.changes ?? 0) > 0;
    },
    blockUser(userId, blockedId) {
      raw.prepare('INSERT OR IGNORE INTO blocks (user_id,blocked_id,created_at) VALUES (?,?,?)').run(userId, blockedId, Date.now());
    },
    unblockUser(userId, blockedId) {
      const res = raw.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, blockedId);
      return Number(res.changes ?? 0) > 0;
    },
    listBlocks(userId) {
      const rows = raw.prepare('SELECT blocked_id FROM blocks WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Array<{ blocked_id: string }>;
      return rows.map((r) => String(r.blocked_id));
    },
    appendAudit(input) {
      raw
        .prepare('INSERT INTO admin_audit (id,actor_id,actor_role,action,target_kind,target_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), input.actorId, input.actorRole, input.action, input.targetKind ?? null, input.targetId ?? null, JSON.stringify(input.detail ?? {}), Date.now());
    },
    listAudit(limit = 100) {
      const rows = raw.prepare('SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id), actorId: String(r.actor_id), actorRole: String(r.actor_role), action: String(r.action),
        targetKind: r.target_kind === null || r.target_kind === undefined ? null : String(r.target_kind),
        targetId: r.target_id === null || r.target_id === undefined ? null : String(r.target_id),
        detail: JSON.parse(String(r.detail_json ?? '{}')),
        createdAt: Number(r.created_at),
      }));
    },
    listDatasetCandidates() {
      // 只取已结算对局；轨迹来自持久事件流；来源由参与者账号来源与 AI 座位共同决定。
      const games = raw
        .prepare('SELECT game_id, board_size, mode, end_reason, settled_at FROM match_results ORDER BY settled_at ASC')
        .all() as Array<Record<string, unknown>>;
      const out: DatasetCandidate[] = [];
      for (const g of games) {
        const gameId = String(g.game_id);
        const parts = raw
          .prepare(
            `SELECT mp.user_id, mp.kind, COALESCE(u.source, 'HUMAN') AS source
               FROM match_participants mp LEFT JOIN users u ON u.id = mp.user_id
              WHERE mp.game_id = ? ORDER BY mp.seat`,
          )
          .all(gameId) as Array<Record<string, unknown>>;
        const events = db.listGameEvents(gameId);
        const moves = events
          .filter((e) => e.type === 'move.applied')
          .map((e) => {
            const p = (e.payload ?? {}) as { seat?: string; row?: number; col?: number };
            return { seat: String(p.seat ?? 'A') as 'A' | 'B' | 'C', row: Number(p.row), col: Number(p.col) };
          })
          .filter((m) => Number.isInteger(m.row) && Number.isInteger(m.col));
        const anyAI = parts.some((p) => String(p.kind) !== 'human');
        const anyNonHumanSource = parts.some((p) => String(p.source) !== 'HUMAN');
        const endReason = String(g.end_reason);
        out.push({
          gameId,
          rulesetVersion: RULESET_VERSION,
          boardSize: (Number(g.board_size) === 17 ? 17 : 13) as 13 | 17,
          mode: String(g.mode),
          source: anyAI || anyNonHumanSource ? 'SYNTHETIC' : 'HUMAN',
          moves,
          terminal: endReason === 'NORMAL_WIN' ? 'win' : endReason === 'BOARD_DRAW' ? 'draw' : 'open',
          participantUserIds: parts.map((p) => (p.user_id === null || p.user_id === undefined ? '' : String(p.user_id))).filter(Boolean),
          createdAt: Number(g.settled_at),
        });
      }
      return out;
    },
    exportUserData(userId) {
      const user = db.findUserById(userId);
      const ranking = raw.prepare('SELECT wins,games,score FROM ranking WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
      const shares = raw
        .prepare('SELECT token,game_id,created_at,expires_at,revoked_at,views FROM share_links WHERE owner_id = ? ORDER BY created_at DESC')
        .all(userId) as Array<Record<string, unknown>>;
      const attempts = raw
        .prepare('SELECT puzzle_id,attempt_id,row,col,verdict,created_at FROM puzzle_attempts WHERE user_id = ? ORDER BY created_at ASC')
        .all(userId) as Array<Record<string, unknown>>;
      const consents = raw.prepare('SELECT kind,version,granted_at,revoked_at FROM user_consents WHERE user_id = ?').all(userId) as Array<Record<string, unknown>>;
      const blocks = db.listBlocks(userId);
      return {
        // 明确不含：密码哈希、盐、会话令牌、他人身份信息。
        exportedAt: new Date().toISOString(),
        profile: user ? {
          userId: user.id, username: user.username, email: user.email, rating: user.rating,
          createdAt: user.createdAt, tutorialCompleted: user.tutorialCompleted,
          role: db.getUserRole(userId), source: db.getUserSource(userId),
        } : null,
        ranking: ranking ? { wins: Number(ranking.wins), games: Number(ranking.games), score: Number(ranking.score) } : null,
        matches: db.historyFor(userId, 200, 0).map((h) => ({
          gameId: h.gameId, seat: h.seat, outcome: h.outcome, ratingDelta: h.ratingDelta,
          mode: h.mode, boardSize: h.boardSize, endReason: h.endReason, settledAt: h.settledAt, moveCount: h.moveCount,
        })),
        puzzleAttempts: attempts.map((a) => ({
          puzzleId: String(a.puzzle_id), attemptId: String(a.attempt_id), row: Number(a.row), col: Number(a.col),
          verdict: String(a.verdict), createdAt: Number(a.created_at),
        })),
        puzzleProgress: db.puzzleProgress(userId),
        consents: consents.map((c) => ({
          kind: String(c.kind), version: String(c.version), grantedAt: Number(c.granted_at),
          revokedAt: c.revoked_at === null || c.revoked_at === undefined ? null : Number(c.revoked_at),
        })),
        shares: shares.map((s) => ({
          token: String(s.token), gameId: String(s.game_id), createdAt: Number(s.created_at),
          expiresAt: Number(s.expires_at),
          revokedAt: s.revoked_at === null || s.revoked_at === undefined ? null : Number(s.revoked_at),
          views: Number(s.views),
        })),
        blockedUserIds: blocks,
        note: '导出物不包含他人身份信息、邮箱以外的凭据、会话令牌或密码材料。',
      };
    },
    anonymizeUser(userId) {
      const now = Date.now();
      raw.exec('BEGIN IMMEDIATE');
      try {
        // 多人记录去标识：把自己的 user_id 从名次行里摘掉，**不删除**这一局（他人的合法记录保留）。
        const parts = raw.prepare('UPDATE match_participants SET user_id = NULL WHERE user_id = ?').run(userId);
        const shares = raw.prepare('UPDATE share_links SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL').run(now, userId);
        const sessions = raw.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        raw.prepare('DELETE FROM user_consents WHERE user_id = ?').run(userId);
        raw.prepare('DELETE FROM puzzle_attempts WHERE user_id = ?').run(userId);
        raw.prepare('DELETE FROM puzzle_progress WHERE user_id = ?').run(userId);
        raw.prepare('DELETE FROM ranking WHERE user_id = ?').run(userId);
        raw.prepare('DELETE FROM friends WHERE user_id = ? OR friend_id = ?').run(userId, userId);
        raw.prepare('DELETE FROM invitations WHERE sender = ? OR receiver = ?').run(userId, userId);
        raw.prepare('DELETE FROM blocks WHERE user_id = ? OR blocked_id = ?').run(userId, userId);
        // 账号本体只做去标识（保留 id 让历史证据的引用仍然成立），不改动他人的任何行。
        raw
          .prepare("UPDATE users SET email = ?, username = ?, avatar = '', password_hash = '', salt = '', source = 'TEST', deleted_at = ?, online_status = 'offline', tutorial_completed = 0 WHERE id = ?")
          .run('deleted+' + userId + '@deleted.invalid', ('已注销用户' + userId.slice(0, 8)).slice(0, 24), now, userId);
        raw.exec('COMMIT');
        return {
          deidentifiedParticipants: Number(parts.changes ?? 0),
          revokedShares: Number(shares.changes ?? 0),
          deletedSessions: Number(sessions.changes ?? 0),
        };
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* 事务已不在：原始错误更重要 */ }
        throw err;
      }
    },
    close() {
      raw.close();
    },
  };
  return db;
}
