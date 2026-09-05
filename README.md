# SRSZQ.com — 三人四子棋在线策略游戏平台

三名玩家在 13×13 / 17×17 棋盘轮流落子：Round 1–5 无人可胜，Round 6 起胜权按 **C → B → A** 循环，
只有持胜权的玩家凭本手连成 ≥4 才获胜。支持 **在线真人匹配（AI 补位）、人机陪练（仅 ★ 显示档位）、
本地对局、账号/教学门禁、好友邀请、排行榜**。

Monorepo：`shared/`（规则引擎 + 五档 AI，唯一来源）· `frontend/`（React 平台 SPA）·
`backend/`（Node + WebSocket + SQLite）· `docs/` · `docker/` · `scripts/`（AI 评测）。

## 快速开始（本地完整运行，Node ≥ 22.5）

```bash
npm install

# 终端 1：后端（API :8080 · WS :8081 · SQLite）
npm run dev:backend

# 终端 2：前端 http://127.0.0.1:5173
npm run dev
```

打开 http://127.0.0.1:5173 → 注册 → 完成 3 局教学（AI 难度隐藏为 ★）→ 大厅 →
Online Match / Human vs AI / Local Match / 好友邀请 / 排行榜。

## 验证

```bash
npm test              # vitest：引擎规则 v2 + AI + backend 纯函数
npm run test:backend  # API 集成（真实 HTTP）
npm run test:ws       # WebSocket 集成（3H/2H+1AI/1H+2AI、断线、邀请）
npm run e2e           # 平台浏览器 E2E（注册/门禁/大厅/人机/排行/好友/排队）
npm run e2e:local     # 本地对局规则回归（棋盘/禁手/资格/悔棋/导入导出）
npm run ai:benchmark  # AI 分档基准（真实运行 → results/）
npm run ai:selfplay   # AI 自对弈评测
npm run build         # 生产构建（frontend/dist）
```

## 部署 / 文档

- Docker：`cp .env.example .env && docker compose up --build`（前端 :8088，后端 :8080/8081）
- `docs/DEPLOYMENT.md`（云调研与上线清单）、`docs/API_DOC.md`、`docs/DATABASE_SCHEMA.md`、
  `docs/TEST_REPORT.md`、`docker/README.md`
- 设计：`PROJECT_AUDIT.md`（升级审计）、`ARCHITECTURE.md`（monorepo 与规则 v2）
- AI 调参与基准历史报告：`SRSZQ_AI_REPORT.md`、`AI_TUNING_REPORT.md`、`AI_BENCHMARK_REPORT.md`
  （规则 v1 时期存档，当前代码以正式规则 v2 为准）

## 正式规则 v2

| Round | 1–5 | 6 | 7 | 8 | 9 | 10 | 11 | … |
|---|---|---|---|---|---|---|---|---|
| 胜权 | 无 | C | B | A | C | B | A | C→B→A 循环 |

- 非资格玩家形成 ≥4 = 禁手；胜利只由「持胜权玩家本手连成 ≥4」触发（无储存四连）；
- 无合法步自动 Pass；棋盘仅 13×13 / 17×17。

## 在线对局防作弊

服务器为唯一权威状态：客户端只提交落子意图，服务端用共享引擎逐手校验（回合/禁手/占位），
广播权威状态并落盘；匹配 60 秒超时按权重补 AI（random100/tactical200/selfish300/3ply400/maxn500），
AI 对用户仅显示 ★1–5。

## License

MIT（LICENSE 见仓库根目录）。
