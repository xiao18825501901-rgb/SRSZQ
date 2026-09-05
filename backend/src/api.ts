/** SRSZQ backend — HTTP API 服务（用户/认证/排行），WebSocket 见 ws/ */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from './db.js';
import { avatarFor, createSessionToken, hashPassword, makeSalt, sessionExpiry, validateEmail, validatePassword, validateUsername, verifyPassword } from './auth.js';
import type { PublicUser, User } from './models.js';

export interface ApiContext {
  db: Db;
  /** 从 Authorization: Bearer <token> 解析并校验会话，返回用户或 null */
  authUser(req: IncomingMessage): User | null;
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

export function createApi(db: Db): { server: Server; ctx: ApiContext } {
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

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
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
            }
          }
          return send(res, 200, {});
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
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
          return send(res, 200, { ranking: db.ranking(limit) });
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
