/**
 * SRSZQ backend — SQLite 存储层（node:sqlite，零外部依赖）。
 * 通过仓储接口组织，未来可平滑替换为 PostgreSQL（见 docs/DATABASE_SCHEMA.md）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { User } from './models.js';

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
  ranking(limit: number): RankingRow[];
  recordMatchResult(userId: string, delta: number): void;
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
    ranking(limit) {
      const rows = raw
        .prepare(
          `SELECT u.id,u.username,u.avatar,u.online_status,u.rating,
                  COALESCE(r.wins,0) AS wins, COALESCE(r.games,0) AS games
           FROM users u LEFT JOIN ranking r ON r.user_id = u.id
           ORDER BY u.rating DESC LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
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
