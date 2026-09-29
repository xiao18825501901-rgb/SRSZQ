/**
 * SRSZQ backend — SQLite 存储层（node:sqlite，零外部依赖）。
 * 通过仓储接口组织，未来可平滑替换为 PostgreSQL（见 docs/DATABASE_SCHEMA.md）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { User } from './models.js';
import { settlementDigest, type SettlementPlan, type ParticipantOutcome } from '../../shared/src/product/resultModel.js';
import { commandPayloadDigest } from '../../shared/src/product/protocol.js';

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
  createUser(input: { email: string; username: string; passwordHash: string; salt: string }): User;
  findUserByEmail(email: string): User | null;
  findUserByUsername(username: string): User | null;
  findUserByUsernameCI(username: string): User | null;
  findUserById(id: string): User | null;
  touchOnline(id: string, status: User['onlineStatus']): void;
  createSession(token: string, userId: string, expiresAt: number): void;
  findSession(token: string): { token: string; userId: string; expiresAt: number } | null;
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
  /** R08：按 attemptId 查一次尝试（幂等重发时回放既有结论）。 */
  findPuzzleAttempt(userId: string, attemptId: string): { puzzleId: string; row: number; col: number; verdict: string; createdAt: number } | null;
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
    };
  };

  const db: Db = {
    raw,
    createUser(input) {
      const id = randomUUID();
      const createdAt = Date.now();
      raw.prepare('INSERT INTO users (id,email,username,avatar,password_hash,salt,created_at,online_status,rating) VALUES (?,?,?,?,?,?,?,?,?)').run(
        id, input.email, input.username, '', input.passwordHash, input.salt, createdAt, 'online', 1200,
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
    createSession(token, userId, expiresAt) {
      raw.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
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
      const rows = raw
        .prepare(
          `SELECT u.id,u.username,u.avatar,u.online_status,u.rating,
                  COALESCE(r.wins,0) AS wins, COALESCE(r.games,0) AS games
           FROM users u LEFT JOIN ranking r ON r.user_id = u.id
           WHERE COALESCE(u.source,'HUMAN') = 'HUMAN'
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
    close() {
      raw.close();
    },
  };
  return db;
}
