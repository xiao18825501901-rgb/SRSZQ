/** SRSZQ backend 启动入口：HTTP API + WebSocket 游戏服务 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createApi } from './api.js';
import { GameServer } from './ws/gameServer.js';

const dataDir = process.env.SRSZQ_DATA_DIR || join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'srszq.sqlite'));

// WebSocket 游戏服务（ws://127.0.0.1:8081）
const gameServer = new GameServer(db, {
  queueTimeoutMs: Number(process.env.SRSZQ_QUEUE_TIMEOUT_MS ?? 60_000),
  aiMoveDelayMs: Number(process.env.SRSZQ_AI_DELAY_MS ?? 350),
  disconnectSkipMs: Number(process.env.SRSZQ_DISCONNECT_SKIP_MS ?? 30_000),
  inviteGatherMs: Number(process.env.SRSZQ_INVITE_GATHER_MS ?? 30_000),
  forfeitGraceMs: Number(process.env.SRSZQ_FORFEIT_GRACE_MS ?? 10_000),
  turnTimeoutMs: Number(process.env.SRSZQ_TURN_TIMEOUT_MS ?? 30_000),
});
const wsPort = Number(process.env.SRSZQ_WS_PORT ?? 8081);
const wsHttp = createServer();
gameServer.attach(wsHttp, '/ws');
wsHttp.listen(wsPort, '127.0.0.1', () => {
  console.log(`[srszq] WS listening on ws://127.0.0.1:${wsPort}/ws`);
});

// HTTP API（邀请状态机接线：登记 → 接受/拒绝）
const { server: apiServer } = createApi(db, {
  onInviteCreated: (a, b) => gameServer.registerInvitation(a, b),
  onInviteAccepted: (a, b) => gameServer.handleInviteAccept(a, b),
  onInviteRejected: (a, b) => gameServer.onInviteRejected(a, b),
});
const apiPort = Number(process.env.PORT ?? 8080);
apiServer.listen(apiPort, '127.0.0.1', () => {
  console.log(`[srszq] API listening on http://127.0.0.1:${apiPort}`);
});

console.log('[srszq] backend ready. Frontend: http://127.0.0.1:5173');

export { apiServer, wsHttp, gameServer };
