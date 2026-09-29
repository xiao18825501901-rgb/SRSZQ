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
  // P0C：有界 AI worker / 硬超时 / WS 安全边界。默认值全部有界，不随房间数增长。
  aiPoolSize: Number(process.env.SRSZQ_AI_POOL_SIZE ?? 0),           // 0 = 自动 min(4, CPU-1)
  aiQueueLimit: Number(process.env.SRSZQ_AI_QUEUE_LIMIT ?? 64),
  aiHardTimeoutMs: Number(process.env.SRSZQ_AI_HARD_TIMEOUT_MS ?? 1500),
  wsMaxMessageBytes: Number(process.env.SRSZQ_WS_MAX_MESSAGE_BYTES ?? 65536),
  wsCommandRateLimit: Number(process.env.SRSZQ_WS_RATE_LIMIT ?? 60),
  wsCommandRateWindowMs: Number(process.env.SRSZQ_WS_RATE_WINDOW_MS ?? 10_000),
  ...(process.env.SRSZQ_ALLOWED_ORIGINS
    ? { allowedOrigins: process.env.SRSZQ_ALLOWED_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean) }
    : {}),
});
// P0B：进程重启后从快照恢复未完成对局（RECOVERY_PAUSED + 60 秒窗口）。
const recovery = gameServer.recover();
if (recovery.recovered > 0) {
  console.log(`[srszq] recovery: ${recovery.recovered} paused game(s): ${recovery.gameIds.join(', ')}`);
} else {
  console.log('[srszq] recovery: no unfinished games to resume');
}

// P0C：预热 AI worker 池。worker 首次加载 tsx + 共享 AI 模块约 300-400ms，
// 放到启动阶段，避免重启后第一个 AI 任务被硬超时误判为降级。
void gameServer.aiHost.warmup().then((w) => {
  console.log('[srszq] ai worker pool warmed: ' + w.warmed + '/' + gameServer.aiHost.stats.poolSize);
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
  // S07：登出即撤销长连接，否则登出只对 HTTP 生效。
  onSessionRevoked: (userId, reason) => gameServer.revokeUserSession(userId, reason),
});
const apiPort = Number(process.env.PORT ?? 8080);
apiServer.listen(apiPort, '127.0.0.1', () => {
  console.log(`[srszq] API listening on http://127.0.0.1:${apiPort}`);
});

console.log('[srszq] backend ready. Frontend: http://127.0.0.1:5173');

export { apiServer, wsHttp, gameServer };
