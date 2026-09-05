# ARCHITECTURE — SRSZQ.com 目标架构

> 本文描述从“纯前端 SPA”（见 PROJECT_AUDIT.md）升级为 SRSZQ.com 在线平台的**目标架构**与
> **迁移映射**。原则：不新建第二套规则；引擎与 AI 唯一来源 shared/；服务器是在线对局唯一权威。

---

## 1. Monorepo 布局（目标）

```
D:\three-player-connect-four\          ← SRSZQ 仓库根（保持现路径，内容重组）
├── package.json                       # npm workspaces: shared / frontend / backend
├── tsconfig.base.json                 # strict 公共 TS 配置
├── vitest.config.ts                   # 全仓单测（node 环境）
├── .gitignore / .env.example
├── LICENSE / README.md
├── PROJECT_AUDIT.md / ARCHITECTURE.md（本文）
│
├── shared/                            # ★ @srszq/shared — 纯 TS，零框架依赖，禁止 UI/IO
│   ├── package.json
│   ├── src/
│   │   ├── game/                      # ← 迁移自 src/game（引擎唯一来源）
│   │   │   ├── types.ts / eligibility.ts / winDetection.ts / legalMoves.ts / rules.ts
│   │   │   └── __tests__/
│   │   ├── ai/                        # ← 迁移自 src/ai（五档 AI + MaxN 搜索 + 配置）
│   │   │   ├── chooseAIMove.ts / evaluation.ts / search.ts / searchAgents.ts
│   │   │   ├── random|tactical|selfish Agent.ts / threatAnalysis.ts / moveOrdering.ts
│   │   │   ├── rng.ts / seats.ts / types.ts / config/defaultWeights.ts
│   │   │   └── tests/
│   │   ├── proto/                     # 网络/房间消息类型（房间/动作/事件 Schema，前后端共享）
│   │   └── index.ts                   # 公共导出面（引擎+AI+proto）
│   └── tsconfig.json
│
├── frontend/                          # @srszq/frontend — 平台 SPA（React 19 + TS + Vite）
│   ├── package.json / vite.config.ts / tsconfig.json / index.html
│   ├── src/
│   │   ├── pages/                     # Landing / Auth(注册登录) / Tutorial / Lobby / Game / Ranking / Friends
│   │   ├── components/                # ← 迁移自 src/components + 新平台组件（含 ★ 星级 AI 展示）
│   │   ├── hooks/                     # ← useGame(瘦身，接 WS) + useAIController(本地 AI 局用)
│   │   ├── ws/                        # WebSocket 客户端（连接/重连/队列/房间消息）
│   │   ├── worker/aiWorker.ts         # 浏览器 Worker 传输层（逻辑 import 自 shared）
│   │   ├── styles/                    # Tailwind（新增）+ 既有 global.css 兜底
│   │   └── App.tsx / main.tsx         # 路由：/ → landing、/auth、/tutorial、/lobby、/game/:id …
│   └── e2e/（迁移 e2e.cjs 基座到平台场景）
│
├── backend/                           # @srszq/backend — Node + TS + WebSocket
│   ├── package.json / tsconfig.json
│   ├── src/
│   │   ├── server.ts                  # HTTP(API)+WS 启动、优雅退出
│   │   ├── api/                       # 路由：auth / ranking / friends / match（见 API_DOC.md）
│   │   ├── auth/                      # 注册/登录/登出、密码哈希(sha256+盐)、JWT
│   │   ├── rooms/                     # GameRoom：唯一权威状态；每步用 shared 引擎校验后落子/广播
│   │   ├── matchmaker/                # 队列：3 真人 / 60s 超时按权重补 AI
│   │   │   └── ai-picker.ts           # 权重 random100/tactical200/selfish300/3ply400/maxn500
│   │   ├── ranking/                   # 仅 Online Match 计分（elo/评分更新）
│   │   ├── social/                    # friend + invitation
│   │   ├── presence/                  # online/offline/playing/matching
│   │   ├── db/                        # 仓储接口 + SQLite(node:sqlite) 实现（可换 Postgres）
│   │   └── __tests__/                 # 账号/房间/匹配/排行/教学门禁 单测（真实执行）
│   ├── data/                          # 本地 SQLite 文件（gitignore）
│   └── scripts/                       # 启动/建表
│
├── scripts/                           # 评测脚本迁移（selfplay/benchmark 指向 shared/ai）
├── docker/                            # Dockerfile(backend/frontend) + docker-compose.yml + .env.example
├── docs/                              # DATABASE_SCHEMA.md / API_DOC.md / DEPLOYMENT.md / TEST_REPORT.md
└── results/                           # 评测存档（保留）
```

## 2. 规则 v2（正式版，shared 唯一实现）

| 项 | 正式规则 |
|---|---|
| 玩家顺序 | A → B → C 轮流，全局回合 0-based；Round = floor(turn/3)+1 |
| 棋盘 | **13×13 / 17×17**（删除 11×11 类型与 UI 入口） |
| 资格 | **Round 1–5：NONE**（任何玩家不可凭落子获胜，成四 = 禁手） |
| 资格序列 | **R6=C、R7=B、R8=A，C→B→A 循环**：eligible = [C,B,A][(round-6) mod 3]，round ≥ 6 |
| 胜利 | 仅“当前玩家有资格”且“本手形成穿过落子格的 ≥4”才胜利（禁止存量四连自动胜） |
| 禁手 | 无资格玩家形成 ≥4 的落子 = illegal（引擎拒绝/UI 不可点） |
| 无合法步 | 自动 Pass（回合照常消耗） |

实现位置：`shared/src/game/eligibility.ts`（单一函数 + 常量），legalMoves/winDetection 逻辑不变；
AI 评估的资格距离（evaluation.ts）与首次获权轮（B→R7、A→R8、C→R6）同步；UI 移除 schedule 选择。

## 3. 分层与数据流

```
[Frontend SPA]
  用户操作(点击落子) ──WS──▶ [Backend GameRoom]
                                 │ 1. 鉴权/校验轮到谁
                                 │ 2. shared/rules.applyMove 校验（禁手/资格/占位）
                                 │ 3. 更新唯一状态 → 判定胜负/自动Pass链
                                 │ 4. 落盘 Game/Match/Ranking
                                 └──WS 广播──▶ 全员（棋盘/回合/终局/重连快照）
本地模式（Local Match / Tutorial / Human vs AI）
  直接调用 shared 引擎（前端权威），结果可上报存档（仅记录，不计排行）
```

- 在线对局**服务器为唯一状态源**：客户端不发“新状态”，只发 `{type:'move', row, col}`；
  服务器广播权威状态（防作弊）。
- AI 座位：在线匹配由服务器跑 shared AI（补位/人机模式可服务端执行或前端执行——在线局一律服务端执行，
  保证断线/作弊不可篡改）；本地 Human vs AI 由前端 Worker 执行（同一 shared 代码）。
- AI 展示：UI 只见 ★~★★★★★；真实 aiType（random…maxn）只存库/内部消息。

## 4. 数据模型概要（详见 docs/DATABASE_SCHEMA.md）

User(id,email,username,avatar,passwordHash,createdAt,tutorialCompleted,onlineStatus,rating)
Game(id,boardSize,mode,winner,createdAt,movesJson)
Match(id,gameId,playerA,playerB,playerC,result,isRanked)
Ranking(userId,wins,games,winRate,score)
Friend(userId,friendId,status) / Invitation(sender,receiver,status)
TutorialProgress(userId,step) / Session(token,userId,expires)

## 5. 技术选型与取舍（审计结论）

- **Backend 框架**：轻量 Node + TS（http + ws 自管路由），而非 NestJS —— 单体规模可控、无魔法依赖、
  便于本机零外部依赖运行与测试；结构按“api/auth/rooms/matchmaker/social/db”模块化，可平滑演进。
- **数据库**：本地开发用 Node 内置 `node:sqlite`（Node ≥22.5；零依赖，本机无 Postgres 的事实）；
  仓储接口隔离，docker-compose 形态提供 Postgres 服务与连接串切换（DEPLOYMENT.md）。
- **实时**：原生 `ws`（无 Redis 也可单机横向：房间路由表；Redis pub/sub 为多实例扩展预留说明）。
- **前端样式**：平台页（Landing/Auth/Lobby…）用 Tailwind 新增；对局棋盘沿用既有 global.css 视觉，
  降低回归风险。
- **测试**：vitest 单测（shared 引擎/AI + backend 流程）+ headless Edge E2E（平台场景 + 回归）。

## 6. 阶段映射（git 提交计划）

1. `Initial architecture` —— 审计/架构文档 + 基线提交（现有完整可玩应用）
2. `Rules v2` —— shared 引擎规则修订（R1-5 NONE / R6 C→B→A / 13|17）+ AI/UI/测试同步
3. `Backend implementation` —— auth/rooms/matchmaker/ranking/social + SQLite + WS 单测
4. `Frontend migration` —— monorepo 化 + 平台 SPA（Landing/Auth/Tutorial/Lobby/Game）
5. `Online multiplayer` —— 在线对局联调（3H/2H+1AI/1H+2AI、补位、重连）
6. `AI integration` —— ★ 隐藏体系、Tutorial 三局、权重补位实测
7. `Deployment` —— Docker 文件、DEPLOYMENT.md（云调研）、README/LICENSE
