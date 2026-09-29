/**
 * SRSZQ backend — SQLite 存储层（node:sqlite，零外部依赖）。
 * 通过仓储接口组织，未来可平滑替换为 PostgreSQL（见 docs/DATABASE_SCHEMA.md）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { User } from './models.js';
import { settlementDigest, type SettlementPlan, type ParticipantOutcome } from '../../shared/src/product/resultModel.js';

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
  `);

  // 轻量迁移：老库 matches 表补 Player Leave System 列（幂等）
  const ensureColumn = (table: string, col: string, ddl: string): void => {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  ensureColumn('matches', 'end_reason', "end_reason TEXT NOT NULL DEFAULT 'NORMAL_WIN'");
  ensureColumn('matches', 'winner_ids', "winner_ids TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('matches', 'loser_ids', "loser_ids TEXT NOT NULL DEFAULT '[]'");

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
      const rows = raw
        .prepare(
          `SELECT u.id,u.username,u.avatar,u.online_status,u.rating,
                  COALESCE(r.wins,0) AS wins, COALESCE(r.games,0) AS games
           FROM users u LEFT JOIN ranking r ON r.user_id = u.id
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
    close() {
      raw.close();
    },
  };
  return db;
}
