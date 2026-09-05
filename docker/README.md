# SRSZQ.com — 本地与容器化部署

本文件描述两种运行形态：
1. **本地开发运行**（零外部依赖，推荐优先）
2. **容器化运行**（Docker Compose，需本机安装 Docker）

> 调研结论（云托管，详见 DEPLOYMENT.md）：正式上线优先推荐**国内轻量云服务器 + Docker Compose**
> （阿里云/腾讯云）承载 API+WS，前端可同机 Nginx 托管或托管到 CDN/对象存储；
> 海外快速起步可选 Fly.io/Render（原生 WebSocket 支持）。本机未安装 Docker 时用形态 1。

## 形态 1：本地一键运行（Node ≥ 22.5，无需 Docker/数据库）

```bash
# 首次
npm install

# 终端 1 —— 后端（API http://127.0.0.1:8080 · WS ws://127.0.0.1:8081/ws · SQLite data/srszq.sqlite）
npm run dev:backend

# 终端 2 —— 前端（http://127.0.0.1:5173）
npm run dev
```

打开 http://127.0.0.1:5173 → 注册 → 完成 3 局教学 → 大厅（Online / Human vs AI / Local / 好友）。

环境变量（可选，均带默认值）：
| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 8080 | API 端口 |
| SRSZQ_WS_PORT | 8081 | WebSocket 端口 |
| SRSZQ_QUEUE_TIMEOUT_MS | 60000 | 匹配等待超时后 AI 补位 |
| SRSZQ_AI_DELAY_MS | 350 | 服务器 AI“思考”延迟 |
| SRSZQ_DISCONNECT_SKIP_MS | 30000 | 断线玩家轮到时自动跳过等待 |
| VITE_API_URL / VITE_WS_URL | 见 frontend/src/api.ts | 前端指向后端（构建期注入） |

## 形态 2：Docker Compose

```bash
cp .env.example .env      # 按需修改
docker compose up --build
# 前端 http://localhost:8088 · API :8080 · WS :8081
```

`docker/` 目录：
- `docker/backend.Dockerfile` —— Node 24 + tsx，启动 backend/src/server.ts，挂载 `backend/data` 卷（SQLite 持久化）
- `docker/frontend.Dockerfile` —— 构建 SPA → Nginx 静态托管，反代 `/api` 与 `/ws` 到 backend
- `docker/nginx.conf` —— 前端路由回退 + API/WS 反代（含 WebSocket Upgrade）
- `docker-compose.yml` —— backend + frontend 两个服务；`data` 卷持久化

PostgreSQL 说明：默认使用 SQLite（`node:sqlite`，零依赖）。`backend/src/db.ts` 已按仓储接口组织，
如需 PostgreSQL：替换实现并保持接口即可；compose 中预留了 `postgres` 服务注释模板（DATABASE_SCHEMA.md 有表结构）。

## 生产构建（无 Docker）

```bash
npm run build              # 产物 dist/（frontend）
node --import tsx backend/src/server.ts   # 后端常驻
```

## 验证命令（全部在仓库根目录执行）

```bash
npm test                    # vitest：shared 引擎/AI + backend 纯函数
npm run test:backend        # API 集成（真实 HTTP+SQLite）
npm run test:ws             # WebSocket 集成（3 真人 / AI 补位 / 断线 / 邀请）
npm run e2e                 # 浏览器平台 E2E（Landing/注册/教学门禁/大厅/人机/排行/好友/在线排队）
node e2e-local.cjs          # 规则 v2 本地对局回归（棋盘/禁手/资格/悔棋/导入导出）
npm run ai:benchmark        # AI 分档基准
npm run ai:selfplay         # AI 自对弈
```
