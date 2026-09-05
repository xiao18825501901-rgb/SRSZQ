# CODEX_HANDOFF_REPORT

> 面向接手 Agent（如 Codex）的完整交接：本仓库 = SRSZQ.com（三人四子棋在线策略游戏平台）。
> 生成时间：UI/UX 升级 + Multiplayer 修复完成后。所有结论来自本会话真实运行。

## Project Overview
三人四子棋（Three-Player Four-in-a-Row）在线平台：3 名玩家在 13×13/17×17 棋盘轮流落子，
正式规则 v2 —— Round 1-5 无人可胜，Round 6 起胜权 C→B→A 循环，仅持胜权玩家凭本手 ≥4 连获胜；
无资格成四 = 禁手；无合法步自动 Pass。产品：注册/教学门禁/大厅/在线匹配（AI 补位）/
人机（★ 隐藏档位）/本地/排行榜/好友邀请；服务器权威对局 + WebSocket 实时。

## Current Architecture
- Monorepo（npm workspaces）：`shared/`（规则引擎 + 五档 AI，唯一规则来源，纯 TS）
  · `frontend/`（React 19 + TS + Vite；哈希路由 SPA；framer-motion；自研 Design System tokens）
  · `backend/`（Node 24 + TS + ws；HTTP :8080 + WS :8081；SQLite node:sqlite）
  · `docs/` · `docker/` · `scripts/`（AI 评测）· `results/`（存档与截图）
- 后端模块：auth（scrypt+盐+会话 token）· rooms（GameRoom 权威状态，共享引擎逐手校验）·
  matchmaker（60s 队列 + 权重 AI 补位 100/200/300/400/500）· invite sessions（好友开房状态机）·
  ranking（仅 online 计分，胜+30/负-10）· social（friends/invitations）
- 前端关键：`platform/Platform.tsx`（路由壳）· `platform/OnlinePage.tsx` · `ws.ts` GameLink（全局对局状态）
  · `api.ts` · `components/`（Board/Cell/…）· `ui.tsx`（Btn/Card/StatusBadge/Stars/PageMotion）
- 关键数据流：客户端只发落子意图 → 服务端校验（回合/禁手/占位）→ 广播权威 state → 终局落盘+计分

## Completed Features
规则 v2 全栈、五档 AI（★ 展示）、账号/教学门禁（3 局隐藏 AI）、Online（3H / 2H+1AI / 1H+2AI 补位）、
Human vs AI（★1-5）、Local、邀请状态机（1 接受→HHAI；2 接受→HHH；GATHER 回退）、断线强制 Pass+resume、
排行榜、好友/在线状态、双浏览器自动进局、Design System + 动效、Docker/部署资产、全套文档。

## Recent Changes
- UI/UX：Landing/Lobby/Auth/Ranking/Friends 重设计（tokens、玻璃导航、大型 Feature Cards、
  迷你棋盘预览、克制动效、落子动画）；docs/DesignSystem.md
- Multiplayer：GameServer 邀请会话状态机与队列元数据；api hooks（onInviteCreated/Accepted/Rejected）；
  前端 GameLink + 自动跳转 + Searching 倒计时；测试扩至 9 场景 + 双浏览器 E2E
- 审计与报告：UI_UPGRADE_AUDIT / TEST_REPORT_UI_UPGRADE / SRSZQ_UI_UPGRADE_REPORT / 本文件

## Remaining Tasks
1. Docker 实机验证：`docker compose up --build`（本机无 Docker，未执行）
2. 浏览器端多人同局 UI 长程回归（教学全 3 局自动完成、邀请聚合 UI 状态提示）
3. 上线：域名/备案/HTTPS(WSS)/监控备份（docs/DEPLOYMENT.md 清单）
4. 可选：PostgreSQL/Redis 切换与多实例房间集群；评估函数改进后放开 MaxN 深搜

## Deployment Preparation
- 本地：`npm run dev:backend` + `npm run dev`（见 How To Run）
- 容器：`docker-compose.yml`（backend :8080/:8081，frontend nginx :8088，SQLite 卷）
- 生产调研：国内轻量云 + Docker 首选；Fly.io/Render 海外起步；Vercel/Netlify 仅前端；
  Cloudflare 建议 DNS/CDN/WSS 前置（docs/DEPLOYMENT.md 附上线清单）

## Environment Variables
| 变量 | 默认 | 位置 |
|---|---|---|
| PORT | 8080 | backend API |
| SRSZQ_WS_PORT | 8081 | backend WS |
| SRSZQ_QUEUE_TIMEOUT_MS | 60000 | 匹配超时 |
| SRSZQ_AI_DELAY_MS | 350 | AI 思考延迟 |
| SRSZQ_DISCONNECT_SKIP_MS | 30000 | 断线跳过 |
| SRSZQ_INVITE_GATHER_MS | 30000 | 邀请聚合窗口（GameServer 读取需接线，测试直接构造参数） |
| VITE_API_URL / VITE_WS_URL | 127.0.0.1:8080 / 8081/ws | 前端构建期注入 |

## How To Run
```bash
npm install
npm run dev:backend      # API 8080 + WS 8081 + SQLite
npm run dev              # 前端 http://127.0.0.1:5173
# 验证
npm test                 # vitest（引擎/AI/backend 纯函数）
npm run test:backend     # API 集成
npm run test:ws          # WS 集成（9 场景）
npm run e2e              # 平台浏览器 E2E（含双浏览器邀请局）
npm run e2e:local        # 本地规则回归
npm run build            # 前端生产构建
```

## Known Issues
- vitest worker 沙箱禁回环网络 → 集成测试用 tsx 独立进程（npm run test:*）
- Docker 未实跑；多浏览器同局 UI 长程回归待补；教学全 3 局流程建议加自动化
- 邀请聚合依赖发送者窗口；若被邀者离线，在线真人 <2 时不开房（前端可提示重试）
- AI 强度说明：3-Ply/MaxN 当前同深度量级（d4+ 实测净负收益，见 AI_TUNING_REPORT.md，v1 存档；
  规则 v2 下重跑脚本已支持 13/17）

## Recommended Deployment Steps
1. `git remote add origin <url> && git push`（本仓库尚未推送，需凭据）
2. 国内：备案域名 → 轻量云装 Docker → `docker compose up -d --build` → Nginx/Caddy TLS（WSS）→ 备份 data 卷
3. 监控：docker logs + 进程守护（restart: unless-stopped）；压测后决定是否启用 Postgres/Redis 多实例
4. 回归：上线前跑完 How To Run 全部验证命令
