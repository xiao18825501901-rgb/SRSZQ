# PROJECT_AUDIT — SRSZQ.com 升级前审计报告

> 审计时间：本会话（规则 v2 指令下达后第一阶段）
> 审计对象：`D:\three-player-connect-four`（三人四子棋网页 + SRSZQ AI，已完成并验证的本地应用）
> 审计方式：实际读取 package.json / tsconfig / vite.config / src 全树 / 测试 / E2E / 报告存档，
> 并在审计前复跑验证：`npx tsc --noEmit` 通过、`npm test` 80/80、`node e2e.cjs` 66/66 ALL PASS。

---

## 0. 结论先行（TL;DR）

1. 现状是一个**纯前端本地 SPA**（React 19 + TS + Vite），含完整规则引擎 `src/game/` 与五档 AI `src/ai/`，
   规则/引擎/AI 全部在**浏览器端**，无任何后端。
2. 本次升级为 SRSZQ.com 需要**新增整个服务端层**（账号/匹配/房间/WebSocket/排行/好友/教学门禁），
   并把引擎与 AI 抽到 **shared/** 供前后端共用（服务器为唯一权威状态源）。
3. 新指令（规则 v2）**显式修订正式规则**：仅 BAC、棋盘 13×13/17×17、资格 R1-5=NONE 且 R6 起 C→B→A。
   这是对上一任务“保留 CBA/CBACC/11×11、前三轮规则”约束的**有意取代**，属产品决策变更，将按
   “记录问题 → 修改引擎/AI/UI/测试 → 补测试”的方式落地，不绕过、不双写规则。
4. 本机环境：Node v24.19.0、npm 11、git 2.54；**无 Docker、无本机 PostgreSQL/Redis/MySQL**。
   本地完整运行将采用 Node 内置 SQLite（零依赖）+ 仓储抽象（可平滑换 Postgres/Redis），
   Docker Compose 作为可部署形态提供（DEPLOYMENT.md 中说明）。

---

## 1. 当前技术栈

| 层 | 技术 | 版本 | 位置 |
|---|---|---|---|
| UI | React + TypeScript + Vite | react 19.2.8 / vite 8.2.2 / ts 7.0.2 | 根目录 SPA（index.html → src/main.tsx → src/App.tsx） |
| 样式 | 手写 CSS（深色竞技风格，响应式） | — | src/styles/global.css（**无 Tailwind**） |
| 规则引擎 | 纯 TS（无框架依赖，可独立测试/复用） | — | src/game/ |
| AI | 纯 TS（五档 + MaxN 搜索 + Web Worker 传输） | — | src/ai/ |
| 状态 | React hooks（useGame / useAIController） | — | src/hooks/ |
| 测试 | Vitest 5（node 环境）+ headless Edge E2E（CDP） | vitest 5.0.0 | src/**/*.test.ts（80 项）、e2e.cjs（66 项检查） |
| 脚本 | tsx（离线评测） | tsx 4.23 | scripts/ai-selfplay.ts、ai-benchmark.ts |
| 构建 | tsc --noEmit && vite build（产物 dist/，含 ai.worker chunk） | — | build.bat / npm run build |

## 2. 目录结构（当前，审计时点）

```
D:\three-player-connect-four\
├── src/
│   ├── game/                  # ★ 规则引擎（唯一规则来源）
│   │   ├── types.ts           #   Player/Schedule/BoardSize/GameState/MoveRecord/常量
│   │   ├── eligibility.ts     #   资格：R1-3 NONE；R4+ 按 CBA/CBACC/BAC 循环（← v2 需改）
│   │   ├── winDetection.ts    #   穿过落子格的 ≥4 判定（横/竖/两斜）
│   │   ├── legalMoves.ts      #   合法落子/禁手/胜点/棋盘满（资格感知）
│   │   ├── rules.ts           #   状态机：applyMove/自动Pass链/replay/undoN/importMoves
│   │   └── __tests__/         #   eligibility.test.ts + rules.test.ts
│   ├── ai/                    # ★ AI（五档 + 评测权重/搜索/Worker/座位）
│   │   ├── types.ts / seats.ts / rng.ts
│   │   ├── threatAnalysis.ts / evaluation.ts / moveOrdering.ts
│   │   ├── search.ts（MaxN：迭代加深/换位表/候选剪枝/时间预算/叶稳定化）/ searchAgents.ts
│   │   ├── randomAgent / tacticalAgent / selfishAgent
│   │   ├── chooseAIMove.ts    #   统一入口（座位校验+引擎合法集二次校验）
│   │   ├── config/defaultWeights.ts（一套权重，无座位特化；在线/离线预算）
│   │   ├── worker/（ai.worker.ts + aiWorkerClient.ts）
│   │   └── tests/（合法性扫掠/禁手专项/战术行为）
│   ├── components/            #   Board/Cell/PlayerCard/SeatSetup/MoveHistory/Timeline/Modal 等
│   ├── hooks/                 #   useGame.ts + useAIController.ts（AI 异步行动链）
│   ├── styles/global.css
│   ├── App.tsx / main.tsx
├── scripts/                   # ai-selfplay.ts（自对弈，--rotate 轮转）/ ai-benchmark.ts
├── results/                   # 12 份真实运行存档（benchmark-*.json / selfplay-*.json）
├── e2e.cjs                    # 66 项浏览器 E2E（CDP + headless Edge）
├── SRSZQ_AI_REPORT.md / AI_TUNING_REPORT.md / AI_BENCHMARK_REPORT.md / SRSZQ_AI_FINAL_RESULT.md
├── package.json / tsconfig.json / vite.config.ts / index.html
├── start.bat / build.bat / README.md / .gitignore
└── （dist/ node_modules/ 为产物与依赖）
```

**确认（指令要求项）**：
- Frontend = 整个现有项目（浏览器 SPA，含 UI 与本地状态）。
- Game Engine = `src/game/`（纯 TS，唯一规则来源，无框架依赖）。
- AI Engine = `src/ai/`（纯 TS，依赖 game 的合法集；浏览器经 Worker 调用，测试/脚本直接同步调用）。
- **不存在 backend/、shared/、数据库、账号、网络层** —— 全部待建。

## 3. 游戏核心模块清单（审计细节）

| 模块 | 文件 | 职责 | 升级影响 |
|---|---|---|---|
| 类型 | src/game/types.ts | Player A/B/C、Schedule(3 种)、BoardSize(11\|13)、GameState、MoveRecord、胜负状态 | v2：Schedule 仅保留单一生效序列；BoardSize 13\|17；资格常量随 eligibility 改 |
| 资格 | src/game/eligibility.ts | `getEligiblePlayer(round, schedule)`：R1-3 NONE，R4+ cycle[(round-4)%len]；round=turn/3+1；player=turn%3 | **v2 核心改动点**：R1-5 NONE，R6+ cycle C→B→A：`(round-6)%3 → C,B,A` |
| 落子/禁手 | src/game/legalMoves.ts | 当前玩家合法集（无资格时剔除“成四”禁手点）、isLegalMove、getWinningPoints、getForbiddenCells | 逻辑与资格引擎解耦，v2 自动跟随（仅资格函数变化） |
| 胜负 | src/game/winDetection.ts | `createsFourThroughCell`：仅“穿过本次落子格”的 ≥4 才算；≥4 含 5/6… | **无需改动**（已满足“仅当前手触发、禁止存量四连自动胜”） |
| 状态机 | src/game/rules.ts | createInitialState/applyMove（禁手拒绝、胜判定、和棋、自动 Pass 链）/skip/replay/undoN/importMoves | 无需改动（与资格解耦）；BoardSize 泛型由类型层收紧 |
| UI 规则展示 | QualificationTimeline/RulesModal/StatusBar/SetupOptions | 展示 3 种 schedule 与 11/13 | v2：UI 移除 CBA/CBACC/11×11 入口，时间轴改 R1-5 NONE + R6 起 C→B→A |

## 4. AI 模块清单（升级影响）

| 模块 | 说明 | v2 影响 |
|---|---|---|
| 评估 | src/ai/evaluation.ts：`roundsUntilEligible` 按 BAC R4=B/R5=A/R6=C 周期；sigmoid 锚定 | **需改**：周期改 R6=C/R7=B/R8=A（R1-5 无资格，firstEligibleRound 映射更新） |
| 搜索 | search.ts / searchAgents.ts：MaxN + 迭代加深/换位表/候选剪枝/时间预算/叶必胜稳定化 | 叶稳定化用 legalMoves 资格函数，自动跟随 |
| 各档 agent | random/tactical/selfish | 依赖 evaluation/legalMoves，随资格函数自动生效 |
| chooseAIMove | 统一入口 + 引擎合法集二次校验 + 兜底计数 | 保留（服务器端 AI 补位将直接调用同一实现） |
| Worker | ai.worker.ts | 前端保留；**后端补位 AI 直接同步调用 chooseAIMove（同一 shared 代码）** |

## 5. 已有功能（实测可用）

- 本地三人对弈（A→B→C 轮流）、人类/AI 混合座位（BAC 模式，0–2 AI、≥1 人类）
- 五档 AI（★ 分级隐藏仅在在线/AI 模式需做 UI 改造；本地座位选择器当前显示真实档名，v2 按平台规范改 ★）
- 规则：自动 Pass、禁手（无资格成四不可落）、胜权获胜、悔棋/悔棋到上一人类回合、导入导出（含 players/ai 统计）
- 测试与评测：80 单测、66 E2E、自对弈/基准脚本与报告、真实运行存档
- `?debug=1&seed=` 测试钩子 window.__tcf、headless E2E 基建

## 6. 缺失功能（SRSZQ.com 差距清单）

| 领域 | 缺失 | 备注 |
|---|---|---|
| 工程结构 | 非 monorepo；引擎/AI 与 UI 同目录 | 目标：frontend/ backend/ shared/ docs/ scripts/ docker/ |
| 后端 | 无服务器/无 API/无数据库/无 WebSocket/无匹配/无房间 | 全部新建（Node + WS + SQLite 起步，Postgres 可换） |
| 用户 | 无注册/登录/会话/资料/头像 | JWT + 密码哈希 |
| 教学 | 无 Tutorial 门禁 | 新用户必须完成 3 局隐藏星级 AI 陪练（内部 random/tactical/selfish） |
| 在线 | 无 3 真人匹配、60s 超时 AI 补位、重连 | 服务器为唯一状态源 |
| 社交 | 无好友/邀请/在线状态 | User.onlineStatus + Friend + Invitation |
| 排行 | 无 Rating/排行榜 | 仅 Online Match 计分 |
| 正式规则 v2 | 引擎仍为旧资格（R1-3/R4+，BAC=B,A,C；另有 CBA/CBACC；11×11） | 按新指令修订引擎+AI+UI+测试（记录于 §8 决策） |
| 部署/开源 | 无 Docker/CI/域名/仓库 | 本机无 Docker：出 Docker 文件 + 本地进程编排；DEPLOYMENT.md 调研云 |
| Git | 未初始化仓库 | 按阶段提交；远程 push 需凭据（无 GitHub 凭据，将在 FINAL REPORT 注明） |

## 7. 风险点

1. **规则 v2 波及面广**：资格函数是引擎/AI/UI/测试的共同基座，修改必须同步 eligibility 单测、
   rules 测试中的 R4 断言、AI 评估周期、时间轴 UI、E2E 断言、离线脚本（无显式资格依赖，但棋盘尺寸需支持 17）。
2. **E2E 大量断言过期**（如 “11×11”“R4 🏆B”“CBA/CBACC 时间轴”）：需要系统性改写而非打补丁。
3. **17×17 性能**：合法点 ~289、AI 搜索分支增大；需基准回归（MaxN k9-d3 预算可能需上调或保持，用 benchmark 实测）。
4. **后端权威性**：客户端必须放弃“本地直接改状态”，全部动作经 WS → 服务器校验（复用 shared 引擎）。
5. **环境**：无 Docker/Postgres/Redis —— 本地交付以零外部依赖优先；部署文件照规范产出但标注“需安装 Docker 后执行”。
6. **防呆**：在线对局中 AI 补位、断线重连、同账号多端登录、非法消息防作弊（校验顺序/禁手/资格）。
7. **“AI 名称隐藏”**：所有玩家可见 UI 只能显示 ★，真实档位只存服务端/本地内部（座位选择器在 Human vs AI 模式需改 ★ 选择而非档名）。

## 8. 产品规则决策变更记录（本次指令，有意取代旧约束）

| 项 | 旧（上一任务约束/现状） | 新（SRSZQ.com 正式版 v2） |
|---|---|---|
| 资格顺序选择 | CBA / CBACC / BAC 三选 | **仅 BAC 正式序列，UI 移除其余** |
| 资格生效 | Round 4 起（R1-3 NONE） | **Round 6 起（R1-5 NONE）** |
| 资格周期 | BAC=B→A→C（R4=B R5=A R6=C） | **C→B→A（R6=C R7=B R8=A）** |
| 棋盘尺寸 | 11×11 / 13×13 | **13×13 / 17×17** |
| 胜利规则 | 同 v2（当前手触发、资格限定） | 不变（保持） |

> 该变更是产品规格升级的一部分，将作为“规则 v2”在 shared/ 落地并在本仓库测试矩阵中全部更新；
> 上一任务交付的 80 单测 / 66 E2E 基线保留在 git 历史中（先提交基线再改）。

## 9. 升级方案（分阶段，每阶段真实运行验证）

1. **P0 工程化**：git init 提交当前基线（“Initial architecture”）→ 目录重组为 monorepo
   （frontend/ backend/ shared/ docs/ scripts/ docker/）；`shared/` 承载 engine+AI（禁止双份）；
   frontend 以 workspace 方式引用 shared。
2. **P1 规则 v2**：shared 资格引擎改 R1-5 NONE / R6+ C→B→A；类型去 Schedule 选择、BoardSize=13|17；
   同步 eligibility/rules/AI 评估/AI firstEligibleRound/UI（Setup/Timeline/RulesModal）/测试/E2E；
   17×17 benchmark 回归；App 保持 localhost 可玩。
3. **P2 backend 核心**：Node+TS+WS 服务：Auth(JWT/注册/登录/登出)、用户表、
   房间/游戏会话（服务器权威状态，复用 shared 引擎校验每步）、匹配队列（60s 补 AI，权重
   100/200/300/400/500）、观战/广播、历史落盘、重连；SQLite 起步 + 仓储接口。
4. **P3 在线功能**：Online Match（3H / 2H+1AI / 1H+2AI）、Human vs AI（★ 显示）、Tutorial
   （新用户门禁 + 3 局隐藏 AI）、Lobby/在线状态、排行榜（仅 Online 计分）、好友/邀请。
5. **P4 平台前端**：Landing/Hero、注册登录页、Lobby、对局页（WS 客户端）、教学流程、排行/好友 UI。
6. **P5 质量与交付**：单测（规则 13/17、R1-5 NONE、R6=C…；AI；在线流程用 WS 双端测试）、
   E2E 账号/教学/邀请/排行场景、Dockerfile/compose/.env.example、文档
   （ARCHITECTURE/DATABASE_SCHEMA/API_DOC/DEPLOYMENT/TEST_REPORT/README）、git 分阶段提交、
   云部署调研（DEPLOYMENT.md）、SRSZQ.COM FINAL REPORT。

## 10. 升级红线（自检清单）

- [ ] 不新建第二个项目/第二套规则；引擎唯一来源 shared/（最终）
- [ ] 不删除五档 AI 与既有评测；AI 名称对用户隐藏（★），库内保留 aiType
- [ ] 服务器为在线对局唯一权威；客户端仅提交意图，服务器校验后广播
- [ ] 每阶段：tsc/vitest/E2E/本地起服实测；发现缺陷 → 记录→修复→补测试
- [ ] 规则变更在 git 提交信息与文档中可追溯
