# SRSZQ_GAME_MODE_RANDOMIZATION_REPORT

> SRSZQ.com 三人四子棋 —— Tutorial / Online Match / Guest Local Game 玩家与 AI 随机化修正（W6）
> 生产已上线并公网验证通过。

## 1. Status

**READY**

## 2. Production Commit

- 功能提交：`75237c2` `feat(game): randomize seats and AI difficulty across game modes`（已 push `origin/main`）
- 部署前生产 SHA（回滚目标）：`9ad19dc`
- 香港后端生产 checkout：`75237c2`（已 `git pull --ff-only` 并 PM2 重启，HEAD 与本地一致）

## 3. Tutorial

- **真人座位**：每次新 Tutorial session 初始化时从 A/B/C 均匀随机（`tutorialHumanSeat`，约 1/3 各）。
- **AI 难度**：剩余两座必为 AI；每个 AI 独立从真实 registry `AI_LEVELS` 均匀随机（1★–5★，**可相同**）。
- **随机来源**：`shared/src/ai/assignment.ts` 的可注入 `Rng`（生产 `Math.random`，测试 deterministic mulberry32）。
- **Session 持久化**：`createTutorialAssignment()` 在 `useState` 初始化调用一次；重渲染/切 tab/resize 不改变；重开教程（重新挂载）= 重新随机。
- **Human=B/C 流程**：engine 行动顺序仍为 A→B→C（未改规则）；`useAIController` 会在 AI 座位先手时自动行动——A(B/C) 依序由 AI 完成，轮到真人再等待点击（无卡死/无人替 AI/double-move/turn-mismatch）。
- **身份展示**：严格按 A/B/C 真实顺序（`tutorialRoleLines`），不把真人挪到第一行。
- **示例**（多次真实运行）：`Human=A + (3-Ply,Random)`、`Human=B + (MaxN,Random)`、`Human=C + (Selfish,3-Ply)`、`Human=B + (Tactical,Random)` 等——非固定。

## 4. Online Match

- **座位分配**：`startRoom(mode='online')` 将所有已匹配参与者（真人 + AI 补位）`shuffled()` 后分配到 A/B/C；1H+2AI / 2H+1AI / 3H 统一；**不改变 A→B→C 行动顺序**（只随机谁坐哪）。
- **AI fill 难度**：仅 `3ply`(4★) 或 `maxn`(5★)（`onlineAiFillLevel` 均匀二选一，逐个独立，**不固定全 5★**）。
- **server authority**：座位与难度在 `game.start`/`game.state` 的 `seats` 中下发，所有客户端一致；前端只读取实际 match state 的 stars（`AI_STARS[level]`），不自算/不另随机。
- **rematch**：每次 `startRoom` 都是新的随机（新 room、新 shuffle、新 AI fill）。
- 好友邀请（mode='invite'）保持原有邀请顺序与 1–5★ 补位（本轮范围限定 Online Match）。

## 5. Local Game

- **Guest 可进入**：`/local` 无登录/无 auth API/无 401；未登录点击「本地对局」直接进入设置屏（已公网验证）。
- **设置屏**：A/B/C 每座选择 真人/AI；AI 可选 随机 / 1★–5★（`LocalSetup`，复用现有 `.seat-row` 设计风格）。
- **难度解析**：`resolveLocalSeats()` 在「开始对局」时把 `auto`(随机) 解析一次为具体真实档（之后 immutable）。
- **约束**：至少一名真人（全 AI 被禁用并提示）；1H/2H/3H 与任意 AI 组合均可用；本地局不写 ranking/friends/账号（纯本地 engine 状态）。

## 6. Files Changed

- `shared/src/ai/assignment.ts`（新：pickUniform/shuffled/tutorialHumanSeat/tutorialAiLevel/onlineAiFillLevel）
- `shared/src/ai/tests/assignment.test.ts`（新：分布 sanity + O4–O7）
- `backend/src/ws/gameServer.ts`（startRoom 随机座位 + online 4/5★ AI fill）
- `backend/tests/ws.integration.ts`（适配随机座位；+ Online 座位随机/全端一致、AI 4/5★ 断言）
- `frontend/src/platform/tutorialModel.ts`（重写：随机真人座 + 每 AI 独立难度 + 身份 A/B/C 顺序）
- `frontend/src/platform/__tests__/tutorialModel.test.ts`（重写 T1–T14）
- `frontend/src/platform/localGameModel.ts`（新：draft 解析/校验）
- `frontend/src/platform/__tests__/localGameModel.test.ts`（新：L4–L8）
- `frontend/src/platform/Platform.tsx`（TutorialPage 随机 assignment + LocalSetup + LocalHost 接线）
- `e2e.cjs` / `e2e-local.cjs`（guest local 设置、教程随机人座、local 先设置）

## 7. Tests Added

- 单元：`assignment.test.ts`（8）、`tutorialModel.test.ts`（9，覆盖 T1–T14）、`localGameModel.test.ts`（6，覆盖 L4–L8/L11）。
- 集成：WS 新增「Online 座位随机分配 + 全端一致」「Online AI 补位只允许 4/5★」（1H+2AI 与 2H+1AI）。
- E2E：Guest local 设置屏 + AI 难度下拉；教程随机人座断言；local 先设置再开局。

## 8. Full Test Results

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（root + frontend） | PASS |
| `npm test` | **107/107** PASS |
| `npm run test:backend`（API） | 10/10 PASS |
| `npm run test:ws`（WS 集成） | **15/15** PASS |
| `npm run build` | PASS（412KB / gzip 131KB） |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `node e2e-local.cjs` | ALL PASS |
| `npm run e2e`（本地 dev） | ALL PASS |

## 9. Browser QA

- Tutorial（多次真实启动）：human=A/B/C 均观察到；AI 难度出现 Random/Tactical/Selfish/3-Ply/MaxN 等组合，非固定；身份按 A/B/C 顺序正确。
- Online Match AI fill：WS 集成对真实 1H+2AI、2H+1AI 房间断言 AI stars ∈ {4,5}；`assignment.test` 10000 样本证明只出现 4/5 且二者均现、绝不出现 1/2/3。
- Guest Local：清登录态进入 /local → 设置屏（Human/AI + 随机/1★–5★ 下拉）→ 三真人开局；AI 组合由单测覆盖。
- 规则回归：A→B→C 行动顺序未变（`shuffled` 只作用于 participant 分配；engine 未动）。

## 10. Netlify Deployment

- push `75237c2` 后 Netlify 自动生产构建，`https://srszq.com` 新 bundle 已上线：`/assets/index-D2CviiN3.js`（含「座位与 AI 设置」等新文案，确认新 build 生效）。

## 11. Backend Deployment

- 香港 `ssh srszq-hk` `/var/www/SRSZQ`：HEAD `75237c2`。
- 部署前 `sqlite3 data/srszq.sqlite ".backup …"` → `/var/www/SRSZQ/backups/manual-20260906T205454Z.sqlite`（integrity ok）。
- `npm ci` → `npm run typecheck` → `npm test`（107/107）→ `pm2 restart srszq-backend`（online, pid 5716）→ `curl 127.0.0.1:8080/api/ranking?limit=1` = 200。
- DB 路径未变 `/var/www/SRSZQ/data/srszq.sqlite`（mode 0600）；未清库；未触碰 Caddy/CourseMate/DNS/TLS。

## 12. Production E2E

- 公网 `https://srszq.com` 平台 E2E：**ALL PASS**（guest landing/rules/local setup+AI dropdown；tutorial 随机人座=本例 B + 随机 AI；门禁；HvAI；邀请双端；local 设置→开局；online queue；无 JS 错误）。
- 公网 `wss://api.srszq.com/ws` lifecycle smoke：**ALL PASS**（resume 宽限 / PLAYER_RESIGN→PLAYER_FORFEIT / disconnect→PLAYER_DISCONNECT / 排行持久化）。

## 13. Regression Results

qualification/BAC timeline/victory/legal moves/AI/online queue/disconnect/friends/ranking 全部不回归（vitest 107、WS 15、API 10、双 e2e 全绿）；A→B→C 行动顺序未变。

## 14. Remaining Issues

- 好友邀请（mode='invite'）仍保持“发送者坐 A、AI 补位 1–5★”的旧行为（本轮明确范围仅 Online Match 队列）。若产品希望好友局也随机座位/限 4-5★，可后续统一 `startRoom` 的 invite 分支。
- 本地局“随机”难度使用普通随机源在开局解析一次；如需可复现可后续加 seed 入口（现有 `makeSeed`/`makeRng` 已具备）。
- 生产 E2E 的 register 延迟依赖放宽后的 sleep/poll；极端慢网络下双浏览器邀请仍可能偶发（已容忍 12s 轮询）。
