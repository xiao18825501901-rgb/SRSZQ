/** SRSZQ backend 启动入口：HTTP API（+ 后续 WebSocket 游戏服务） */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { bootApi } from './api.js';

const dataDir = join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'srszq.sqlite'));

bootApi(db);

console.log('[srszq] backend ready. Frontend: http://127.0.0.1:5173 · API: http://127.0.0.1:8080');
