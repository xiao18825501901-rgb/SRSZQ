# SRSZQ_UI_TUTORIAL_REDESIGN_REPORT

> SRSZQ.com 三人四子棋 —— UI 去 AI 味改版 + 规则 onboarding 重构 + 新手教程 1H+2AI · 正式部署上线
> 提交：`feat(ui): refine visual design and tutorial onboarding`（`b62bbf1`）＋ `chore(ui): finalize public verification and redesign report`

## 1. Status

**READY** — 新版 UI 已在生产上线并公网验证通过。

## 2. Design Skill（实际使用）

- **主规范：Anthropic `frontend-design`**（https://github.com/anthropics/skills/tree/main/skills/frontend-design）
  - `skills/frontend-design/SKILL.md` 已读取（保存于本地临时，未并入业务仓库；遵守其 LICENSE）。
  - 应用：按“以主体为本（棋盘即产品）”“避开模板 tell（渐变巨字 hero、卡片汤、eyebrow、全大写小标签、中缀点元信息、近黑 tinted 底）”“克制动效、动效回答动作”“紧凑 token 系统 + 先写方向再实现 + 截图自评”执行。
- **审计辅助：avoid-ai-design**（https://github.com/funboy322/avoid-ai-design `SKILL.md` 已读取），作为 AI-slop 检查表用于 before/after 审计。

## 3. Before Problems（审计结论）

- 模板化 SaaS 首屏：紫色 orb 光斑 + 渐变巨字标题 + “Think. Predict. Dominate.” + 同构卡阵列。
- 紫蓝渐变滥用（主色 #7c5cff）；glass 毛玻璃导航；卡片同半径同投影“卡汤”；pill/badge 泛滥。
- 装饰性 eyebrow/全大写小标签；逐卡上浮等无意义动效；背景径向紫光。
- 规则入口弱势：藏在 hero 下方次级 strip；登录后大厅无规则入口；胜权解释零散。
- 教程错误：人类座位在 A/B/C 间轮换、每局仅 1 个 AI、第 3 局把人类 A 变成 AI —— 违反“1 真人 + 2 AI”。
- index.html 缺 description；无 focus-visible / reduced-motion / tap 目标规范；双主题变量混用。

## 4. New Design Direction

- **基底**：深色棋桌暖石墨（`--ds-bg-0 #0d1014/#12161c/#181d25`），去掉紫色光污染；单一低饱和青蓝交互色 `--ds-accent #5f9bd8`（取代紫）。
- **字体**：单系统 sans（Segoe UI/系统）；明确字阶（11/12.5/14/15/16/20/28/40+）；棋盘数字 tabular；标题不加宽字距、不做渐变字、去全大写 eyebrow。
- **布局**：首屏 = 棋盘本体（MiniBoard 无光晕）+ 一句话 + 明确动作；登录后 = 规则速览卡（above the fold）+ 大厅；棋盘区高对比实体、辅助面板低对比。
- **组件**：导航实体暗底细边框（去玻璃化）；按钮两级（primary/线框）；状态用“字母+颜色+文字”三重编码；动效只回答动作（落子/展开/结果），尊重 `prefers-reduced-motion`。
- **可访问性**：全局 `:focus-visible`、`coarse` 指针 tap 目标 ≥40px、胜权 `?` tooltip（hover/focus 可见）、时间线不依赖 hover。

## 5. Rules Redesign（规则入口变明显）

- 新增 `/rules` 页 + 导航“怎么玩”（登录/未登录均可见）；Landing above-the-fold 直接内嵌「三人四子棋怎么玩 · 规则速览」区块 + 「查看完整规则」。
- 大厅顶部新增规则入口条：「三人四子棋怎么玩？· 胜权规则一分钟讲清」。教程页顶部也有「规则速览」。
- 两层结构：第一层 `规则速览`（6 条），第二层 `完整规则`（10 条列表）+ 胜权七问 + 时间线。

## 6. Victory Right / 胜权

- 文案全部依据 shared engine/eligibility 真值写定（R1–5 NONE；R6=C · R7=B · R8=A；之后 C→B→A 循环），非凭空。
- 新增「什么是『胜权』？」区块：七问（①是什么②谁拥有③何时变④有胜权成四后果⑤无胜权成四后果⑥已有四连为何不算⑦对局中如何看）。
- 视觉时间线 `VictoryTimelineTable`（Round 1–14，字母+颜色双重编码，`vline-grid` 移动端横滚，无需 hover），行数据由引擎 `getEligiblePlayer` 生成（`victoryTimelineRows`，单测校验与引擎一致）。
- 对局中“直读”：本地/人机 StatusBar 增 `当前胜权 Eligible`（含 `?` tooltip）；Online 状态栏新增「本回合胜权」项（服务器 qualification 权威）；`BAC Victory Timeline` 面板持续展示当前+未来 8 轮；轮到谁与谁持权分开显示（“当前回合 A / 本回合胜权 C 或 暂无(R1–5)”）。

## 7. Tutorial

- **结构**：`sampleAiPair()`（session 初始化时一次随机，均匀、真实 registry `AI_LEVELS`、两档互异）→ `tutorialSeats(pair)` = A 人类 + B/C AI；`tutorialRoleLines` 生成身份行（你=玩家A真人；对手 B/C · AI · 实际名称+星级）。
- **行为**：重渲染不换 AI（useState 一次初始化）；重开教程=重新随机；身份卡实时展示；`useAIController` 现有思考延迟（minDisplayMs）保证节奏；**全程复用 shared 引擎**（legal/qualification/victory/auto-pass），无 tutorialRules、无第二套引擎。
- **教学**：顶部规则速览（可收起）+ 上下文教练 `coach-line`（轮到你了 / 本回合胜权是谁 / 为何禁手 / 何时可四连成胜 / AI 行动提示），progressive & lightweight，不弹窗轰炸。

## 8. Files Changed

- `frontend/src/components/HowToPlay.tsx`（新：速览/胜权七问/时间线/完整规则页）
- `frontend/src/components/__tests__/howToPlay.test.ts`（新：TEST3 时间线=引擎）
- `frontend/src/platform/tutorialModel.ts`（新：随机对/身份/座位模型）
- `frontend/src/platform/__tests__/tutorialModel.test.ts`（新：TEST4–11）
- `frontend/src/platform/Platform.tsx`（Landing 重构 / 导航“怎么玩” / /rules 路由 / Lobby 规则条 / TutorialPage 1H+2AI 重构）
- `frontend/src/App.tsx`（coach 渲染 prop + 胜权 `?` glossary）
- `frontend/src/platform/OnlinePage.tsx`（「本回合胜权」直读 + `?`）
- `frontend/src/styles/global.css`（token/底色去紫、去玻璃、howto/vline/coach/tut/land 样式、focus/reduced-motion/tap）
- `frontend/index.html`（description/theme-color）
- `e2e.cjs`（规则/胜权/教程 1H+2AI 断言 + 生产延迟容忍）
- `SRSZQ_DESIGN_DIRECTION.md`（方向文档）· `shot-ui.cjs`（截图工具）· `results/ui-before|after|prod/*`

## 9. Tests

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（root + frontend） | PASS |
| `npm test` | **91/91**（原 80 + 新 11：tutorialModel 7 + howToPlay 4） |
| `npm run test:backend`（API） | 10/10 PASS |
| `npm run test:ws`（WS 集成） | 14/14 PASS |
| `npm run build`（vite 生产构建） | PASS（398KB gzip 126KB） |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `node e2e-local.cjs` | ALL PASS |
| `npm run e2e`（本地 dev） | ALL PASS |
| `npm run e2e`（**https://srszq.com** 公网） | **ALL PASS** |
| `scripts/smoke-public-lifecycle.mjs`（wss://api.srszq.com/ws） | ALL PASS |

测试覆盖映射：TEST1 规则入口明显(✔ e2e 规则页/首页速览) · TEST2 胜权完整解释(✔) · TEST3 时间线与引擎一致(✔ 单测+e2e) ·
TEST4 3 玩家(✔) · TEST5 1 human(✔) · TEST6 2 AI(✔) · TEST7 来自真实 registry(✔ 单测 60 组+生产运行) ·
TEST8 render 稳定(✔ 用例语义+身份卡) · TEST9 restart 重随机(✔ 200 组覆盖 10 组合+生产多次不同对) ·
TEST10/11 AI 不替 human / human 不控 AI(✔ 控制器+座位模型+生产首局) · TEST12 BAC 不变(✔ 引擎单测) · TEST13 既有 80+ 仍过(✔ 91)。

## 10. Screenshots

- Before：`results/ui-before/{1440x900,390x844}/*.png`（landing/auth/lobby/local/tutorial/ranking）
- After：`results/ui-after/{1440x900,390x844}/*.png`（同上 + rules）
- Production：`results/ui-prod/1440x900/*.png`（landing/auth/lobby/local/tutorial/rules）
- 视觉审计（主观+截图）：首页棋盘为主角、无紫 orb/渐变；教程身份卡；规则页七问/时间线；本地/在线状态栏「本回合胜权」+ `?`；移动端教程身份卡已收紧、规则速览可折叠；无横向溢出（移动端时间线横滚不影响）。

## 11. Git

- 提交：`b62bbf1` `feat(ui): refine visual design and tutorial onboarding`（pushed main）
- 提交：`chore(ui): finalize public verification and redesign report`（pushed main）
- 部署前生产 SHA（rollback 目标）：`9ad19dc`

## 12. Deployment

- **前端**：push main → Netlify 自动生产构建（netlify.toml：`npm run build` → `frontend/dist`，env `VITE_API_URL=https://api.srszq.com`、`VITE_WS_URL=wss://api.srszq.com/ws`）。
- 已验证 `https://srszq.com` HTML + JS bundle 均含新版内容（`玩家 A（真人）`、`三人四子棋怎么玩`、`什么是「胜权」`）——新 build 已上线（`/assets/index-DczmB7Aj.js`）。
- **后端**：本波改动仅前端/前端测试；**未修改 shared backend game rules / server 行为**，故**无需更新香港后端**（符合“仅当修改 backend/shared/运行行为时才须更新”）；未触碰 Caddy/CourseMate/DNS/TLS。
- 说明：本地 dev 后端以 `SRSZQ_ALLOWED_ORIGINS`（含 localhost）重启以支持浏览器测试；生产默认白名单仅 srszq.com（未改动生产配置）。

## 13. Production URLs（验证）

- `https://srszq.com` → 200（新 UI）· `https://www.srszq.com` → 200 · `https://srszq.netlify.app` → 200
- `https://api.srszq.com` → 根 404（正常）· `/api/ranking` → 200 · `wss://api.srszq.com/ws` → 鉴权生命周期 PASS

## 14. Production E2E（公网，逐项 PASS）

首页 ✔ · 登录/注册 ✔ · 首次登录规则入口（速览+完整规则） ✔ · 胜权说明（七问） ✔ · 胜权时间线与引擎一致 ✔ ·
Tutorial 1 真人+2 AI ✔ · AI 随机初始化（多次运行得到不同对：MaxN/Selfish、3-Ply/Selfish 等） ✔ · Human turn ✔ · AI turns ✔ · 合法/禁手 ✔ ·
13×13 / 17×17 ✔（本地 E2E） · Human vs AI ✔ · Online lobby ✔ · 在线/邀请双端同步（BAC 面板 R1→R6 一致） ✔ · 无 JS 错误 ✔ ·
胜权一致性：生产本地/在线页 R1–5 暂无、R6=C（BAC 面板/状态栏与引擎一致，无篡改规则）。

## 15. Rollback

- 回滚目标 SHA：`9ad19dc`。
- 策略：`git revert b62bbf1`（或推送新提交撤销前端改动）→ Netlify 自动回滚部署；后端未动无需回滚。
- 本次未发生需要回滚的问题。

## 16. Remaining Issues

- 生产延迟下固定 sleep 的 E2E 时序已放宽；极端慢网络下双浏览器邀请仍可能偶发需要更长轮询（已容忍至 12s）。
- 视觉上：设备字体栈导致中英混排细节依平台略有差异（系统字，无网络字体/无重依赖，符合约束）。
- 教程身份卡显示真实 AI 档位名（按要求）；其余对战页面（HvAI/在线/本地）仍只显示 ★（板级展示保留原“隐藏档位”策略；可在后续统一）。
