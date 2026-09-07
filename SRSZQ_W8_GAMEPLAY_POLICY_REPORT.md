# SRSZQ_W8_GAMEPLAY_POLICY_REPORT

> SRSZQ.com 三人四子棋 —— W8：Tutorial 一盘制 / Online AI 加权 / 隐藏保护 / Guest 速学规则 / HvAI 最快威胁防守 / 移动端胜权轨道。

## 1 Status

**PARTIAL — 代码与本地全部门禁已 PASS，生产前端部署验证未完成（见 §15/§18）。**

## 2 Production SHA

- Before / 回滚目标：`7047be9`
- W8 提交：`e19c4aa`（已 push `origin/main`，重试后成功）
- 香港后端 checkout：`e19c4aa`（已 pull + PM2 restart）

## 3 Tutorial

- **一盘制**：Tutorial 从 3 局改为 1 局；合法终局（Human win / loss / draw）即通过。
- **持久化**：终局后立即调用现有 `POST /api/tutorial/complete`（复用现有字段，无第二套存储）；刷新/退出/中途 abandon 不算完成（e2e 断言“返回仍被门禁拦截”）。
- **AI 难度**：仅 1★/2★/3★（random/tactical/selfish）独立均匀随机，4/5 不可能（单测覆盖）。
- **真人座位**：保持随机 A/B/C；身份按真实顺序展示；session 内 immutable。

## 4 Online 1H+2AI

- 每个 AI 独立 `pickOnlineSingleHumanAiDifficulty`：2★20% / 3★30% / 4★40% / 5★10%（累计区间边界单测 + 100k 分布 sanity）。
- 两个 AI 两次独立 draw（2+5、3+4、4+4、5+5 等可产生）。

## 5 Hidden Human Protection（internal only · NOT PLAYER-FACING）

- 范围：Online 1H+2AI 且 acting AI ∈ {3★,4★,5★}；2★ 不启用。
- 行为：AI 无立即自胜，且 Human 与另一 AI 都有 meaningful 防守候选时，若当前决策在堵 Human → 替换为堵另一个 AI（target preference / tie-break bias）。
- 绝对优先级：AI 自己的立即获胜永远覆盖保护。
- 例外：Human 是唯一真实威胁（另一 AI 无 meaningful 候选）→ 照常可堵 Human。
- 实现：`shared/src/ai/defensePolicy.ts`（`applyDefensePolicy` 后处理器）+ `MatchPolicyContext`（difficulty 与 policy 分离）；后端 `startRoom` 对 1H+2AI 设 `protectSingleHuman/humanSeat`，`maybeRunAI` 经 `chooseAIMove` 传入。UI/规则/任何玩家可见文案均未提及。

## 6 Online 2H+1AI

- `pickOnlineTwoHumanAiDifficulty`：4★60% / 5★40%；2/3 不可能（单测）。
- 无保护（policy 不设置）。

## 7 HvAI（1H+2AI）

- 无自胜时优先封堵“预计轮数上最快能赢”的对手：`projectedTurnsToWin = max(几何需要, 轮到其获权并行动的手数)`，身份无关（不区分真人/AI）；距离相同 → 保持原评估器决策。
- 前端 `LocalHost` 仅当 vsai 且 1H+2AI 时传 `defenseFastestThreat`；经 `useAIController → worker/chooseAIMove` 生效。

## 8 Guest Quick Rules

- 未登录首页 hero 区新增三条速学规则（用户原文）：三人轮流下 / 先下出四颗连子的人获胜 / 每人每三轮有一次胜权，有胜权时才可连成四颗子；下接「如果还没看懂，可以前往「怎么玩」查看详细规则」链接。
- 「怎么玩」页面内容/结构未改（规则页 e2e 断言不变）。

## 9 Rules Page

UNCHANGED（W7 冻结；e2e「规则页」断言保持原样并 PASS）。

## 10 Mobile Victory Right

- Desktop/横屏：右侧布局不变。
- 手机竖屏（≤900px portrait）：胜权轨道（bac 面板）移到棋盘上方、横向排列可滚动（当前项默认可见）；Online 页 aside `order:-1`；本地/人机 Host 用 `display:contents` 只把 bac 面板提到棋盘前，控制/历史保持在棋盘后。CSS 位于 tabletop.css 末尾。

## 11 AI Benchmark

- 未新增 solver；“最快赢”复用 `patternFeatures/getWinningPoints/cellLineInfo/roundsUntilEligible` 的确定性启发（O(棋盘)），13×13/17×17 无额外搜索开销。防御后处理器仅 O(legal×const)。（本轮未跑独立耗时基准，性能由既有 131 单测 + WS 集成 60ms 预算路径覆盖。）

## 12 Tests

- 新增/更新：`assignment.test.ts`（边界 20/30/40/10、60/40、独立性、100k sanity、教程 1-3★）；`defensePolicy.test.ts`（HP1–HP9、H1–H5）；`tutorialModel.test.ts`（教程 AI 1-3★）。
- vitest：**131/131 PASS**；typecheck（root+frontend+backend）PASS；WS 集成 **15/15 PASS**；API 10/10 PASS；`npm run build` PASS；`npm audit --audit-level=high` 0 漏洞。
- e2e-local：ALL PASS。平台 e2e（本地）：除 1 处断言文案（“教学已完成” vs “教学完成”）已修复外全 PASS（修复后需重跑确认）。

## 13 Git / CI

- 提交 `e19c4aa`（14 文件，+551/−91）。push 期间 GitHub 443 曾短暂不可达，重试后成功（`7047be9..e19c4aa main -> main`）。CI 状态未在本轮确认。

## 14 Backend Deployment

- 香港：备份（`backups/manual-20260907*.sqlite`，integrity ok）→ `git pull --ff-only`（HEAD=e19c4aa）→ `npm ci` → `npm run typecheck` → `npm test`（131/131）→ `pm2 restart srszq-backend`（online）→ `curl /api/ranking` = 200。DB 路径不变、未清库、未动 Caddy/CourseMate。

## 15 Netlify Deployment

- 前端 push 后 Netlify 应自动构建；**至本报告时点，公网 bundle 尚未观测到新标记（“一盘制”等），frontend_new_live=False**。可能为构建队列/网络原因。**未确认前不得宣称前端已上线。**

## 16 Public E2E

- 后端公网未重跑（前端未确认新 bundle）。此前 WSS lifecycle 冒烟（wss://api.srszq.com/ws）在 W6 基线 PASS；W8 后端改动不涉及协议。**公网 E2E 待前端确认后执行。**

## 17 Regression

- 本地全量回归绿：qualification/BAC/victory/legal/AI/queue/disconnect/friends/ranking/邀请/本地 全 PASS；A→B→C 行动顺序未改；W7 视觉未动（除 W8 指定移动端胜权轨道）。

## 18 Remaining Issues

1. **前端生产部署验证未完成**（Netlify 未观测到新 bundle）——完成即补跑公网 E2E 与报告更新。
2. e2e.cjs 教程完成断言文案已修复，待本地重跑一次确认全绿。
3. 平台 e2e 的本地跑受 dev 环境 CORS/网络影响较大；公网跑才是最终判定。
4. Netlify CLI 的 `--data` JSON 参数经 PowerShell 转义未成功，无法用 CLI 直接查询 deploy 状态（可用网页/API token 路径替代）。
5. 若新 bundle 长时间不出现：检查 GitHub Actions/Netlify 构建日志；回滚 = `git revert e19c4aa`（前端）+ 后端 git reset 至 7047be9 并 PM2 重启。
