# CODEX_FINAL_HANDOFF_REPORT — SRSZQ.com · BAC Timeline Visualization（W4）

> 面向 Codex / 后续维护者的最终交接。仓库根：`D:\three-player-connect-four`（monorepo npm workspaces）。
> 提交：**`Add BAC qualification timeline display for online matches`**（W4；W3 = `Implement online match player forfeit and leave handling`）。

## 1. Current Project Status（已完成的波次）

| 波次 | 内容 | 状态 |
|---|---|---|
| W0 | 本地三人四子棋 + 规则 v2 引擎（13×13/17×17、资格 R1-5 NONE & R6 起 C→B→A、禁手、auto-pass、仅当前手成四获胜）+ 5 档 AI（★1–5 隐藏档位名） | ✅ |
| W1 | SRSZQ.com 平台化：auth/session(SQLite)、Online Match（60s AI 补位匹配、服务器权威房间）、Human vs AI / Local / 教学（3 局门禁）/ 排行榜（仅 Online ±30/−10）/ 好友与邀请 / Docker / 文档 | ✅ |
| W2 | UI/UX 商业化 + 多人修复：Design System（ui.tsx / tokens）、Landing Hero v2、Lobby 大卡、glass nav、framer-motion、邀请状态机、排队倒计时、全局 GameLink | ✅ |
| W3 | **Player Leave System**：Leave Match + 确认弹窗、掉线 10s 宽限判负、MATCH_ENDED/end_reason 落盘、房间清理与重匹配、AI 不继续、排行 Bug 修复 | ✅ |
| W4 | **BAC Qualification Timeline Visualization**：Online Match 实时胜权时间线面板（服务器权威 payload + 本地/人机同引擎展示）、CURRENT/NEXT/FUTURE 8 轮、YOUR VICTORY WINDOW 视角、响应式布局、断线重连恢复 | ✅ 本次 |

已建成模块：**BAC Game Engine**（shared，唯一规则源）· **AI**（5 档，★ 隐藏）· **Online Match** ·
**Player Leave System** · **BAC Timeline Visualization**。

测试基线：vitest **80/80** · WS 集成 **14/14** · API 集成 10/10 · 平台 E2E（25+ 断言）· 本地规则 E2E（37+ 断言）全绿。

## 2. Architecture

- **shared/**：规则与 AI 唯一来源。
  - `game/eligibility.ts`：`getEligiblePlayer(round)`——R1-5 null；R6+ `ELIGIBLE_ORDER[(round-6)%3]`（C→B→A）。
  - `game/qualification.ts`（W4 新增）：时间线窗口层 `qualificationOf(currentRound, lookahead=8)` /
    `qualificationFromState(state)` / `nextEligibleRoundAfter`；不重复实现资格规则。
  - `ai/`：random/tactical/selfish/3ply/maxn（★1-5），与人类共享引擎。
- **backend/**：Node24 + ws + node:sqlite。
  - `ws/gameServer.ts`：权威房间（匹配/邀请/服务器校验/终局）；**W4**：`game.start`/`game.state`
    每帧附加 `qualification`（服务器权威时间线）；W3 状态机 PLAYING/PLAYER_LEFT/FINISHED 与判负/宽限/清理。
  - `db.ts`：仓储接口（可换 PG）；matches 含 end_reason/winner_ids/loser_ids（幂等迁移）。
- **frontend/**：React19 + Vite + hash router。
  - `ws.ts`：GameLink 全局对局态（GameSnapshot.qualification）。
  - `components/BacTimelinePanel.tsx` + `bacTimelineModel.ts`（W4 新增：面板 + 纯模型）。
  - `platform/OnlinePage.tsx`（Online/邀请页，侧栏时间线）；`App.tsx`（Local/HvAI/教学 host 同面板）。
- **Database**：SQLite（users/sessions/ranking/games/matches/friends/invitations/tutorial_progress）。
- **WebSocket**：ws://:8081/ws；HTTP API :8080。

## 3. Recent Change — BAC Timeline Visualization（W4 增量）

详见 `BAC_TIMELINE_FEATURE_REPORT.md`。要点：

1. **共享数据源**：新增 `shared/src/game/qualification.ts`（取窗口，规则仍复用 eligibility）。
2. **后端**：`game.start` / 每次 `game.state` 广播携带
   `qualification{currentRound, currentEligible, upcoming[8]{round,player}}`；服务器权威，客户端不推算。
3. **前端**：
   - Online/邀请页（`OnlinePage`）：棋盘右侧 BAC 面板（桌面网格）/ 下方折叠卡片（移动），
     数据来自服务器 payload；断线重连由 `game.start` 恢复；
   - Local/HvAI/教学 host（`App.tsx`）：旧 chips 时间轴 → 同一 BacTimelinePanel（共享引擎计算）；
   - 视觉：CURRENT 卡（VICTORY LOCKED / 🏆 Victory Right 高亮辉光）+ NEXT 8 ROUNDS 行 +
     自己的胜权窗口打 `YOU` / `★ YOUR VICTORY WINDOW` 视角文案（他人持权提示防守）；
   - 规则展示严格跟随引擎真值（R1-5 NONE；R6=C/R7=B/R8=A…循环）。
4. **测试**：+16 单测（R1 NONE / R4 引擎输出 / R100 周期 / payload→行模型 / 视角文案）、
   +2 WS 集成（payload 与多人同步/推进/resume 恢复）、平台 E2E HvAI R1→R6 与邀请双端 R1/R6 一致、
   本地 E2E 面板断言 + 截图（results/bac-timeline/）。

## 4. How To Run

```bash
npm install
npm run dev:backend          # API :8080 + WS :8081（tsx watch）
npm run dev                  # 前端 Vite :5173
npm test                     # vitest 80（shared/backend/frontend 纯模型）
npm run test:backend         # API 集成 10
npm run test:ws              # WS 集成 14（真实多客户端；含 W4 BAC payload 场景）
npm run e2e                  # 平台 E2E（headless Edge×2；HvAI/邀请 BAC 面板断言）
node e2e-local.cjs           # 本地规则 E2E（BAC 面板 R1/R6；SRSZQ_SHOT_DIR=... 可出截图）
npm run build                # 前端生产构建
```
E2E 浏览器默认 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（`EDGE_PATH` 覆盖）。

## 5. Env Vars（backend，全部可选）

PORT=8080 · SRSZQ_WS_PORT=8081 · SRSZQ_QUEUE_TIMEOUT_MS=60000 · SRSZQ_AI_DELAY_MS=350 ·
SRSZQ_DISCONNECT_SKIP_MS=30000（好友局自动跳过）· **SRSZQ_FORFEIT_GRACE_MS=10000（Online 判负宽限）** ·
SRSZQ_INVITE_GATHER_MS=30000 · VITE_API_URL / VITE_WS_URL（前端构建注入）。

## 6. Deployment Checklist

- [ ] `npm run build`（frontend/dist）+ 后端 Node ≥ 22.5（推荐 24）启动
- [ ] SQLite 自动迁移（matches 三列幂等 ALTER）；生产首次启动自检
- [ ] 反向代理支持 WebSocket upgrade（`/api`、`/ws` 同域反代；见 docker/、docs/DEPLOYMENT.md）
- [ ] 环境变量注入（§5）；`SRSZQ_FORFEIT_GRACE_MS` 与前端提示文案一致（10s）
- [ ] 冒烟清单：注册→教学→Online 排队→对局页 BAC 面板（R1 LOCKED→R6 C 持权）→Leave Match 判负→排行变化→再匹配
- [ ] 数据目录 `backend/data/` 持久化（容器 volume `srszq-data`）

### Deployment Ready Status（距离 production 还差什么）

**已就绪**：完整可运行单体（前端 SPA + 后端 + SQLite + Docker Compose 配方）；真实多客户端 WS/E2E 全绿。

**尚未完成（建议下一步，交给部署方）**：
1. **Cloud 主机**：未上线任何云环境（本地 dev 形态）；需按 docs/DEPLOYMENT.md 选型（支持 WS 长连接）
   并配置 TLS（wss）。
2. **Domain**：srszq.com 域名 DNS/证书未接入。
3. **Database migration 策略**：SQLite 已幂等；若切 PostgreSQL 需按 db.ts 仓储接口实现 + 显式迁移工具
   （node:sqlite 方言：COLLATE NOCASE、INSERT OR IGNORE 等需替换）。
4. **CI/CD**：尚无流水线（本地脚本化测试：npm test / test:ws / e2e* 可作为 CI 步骤模板）。
5. 可选：对局历史页、回合时钟（TIMEOUT 已预留）、评分平滑、指标页（见 §8）。

## 7. Known Issues（有意为之/边界）

- 多人同时掉线：首个宽限到期即结算，其余离场者也记败（不重复计分）——W3 设计决定。
- Online 端若 qualification payload 缺失会回退共享引擎计算（同规则源，理论不发生）。
- `TIMEOUT` endReason 预留（回合时钟未启用）。
- 好友局无判负/排位（PLAYER_RESIGN 被拒）；断线自动跳过语义保留在好友局。
- 教学/本地/人机页无“我的座位”概念 → 不显示 YOUR VICTORY WINDOW 横幅（其余一致）。
- AI 档位名永不暴露（★1-5）；BAC 面板 AI 持权时显示 “AI ★n”。

## 8. Recommended Next Steps

1. 部署四件套：Cloud + Domain + DB migration（PG 可选）+ CI/CD（§6）。
2. 对局历史页（games/matches 含 end_reason 展示；“判负后回站可见结果”）。
3. 回合时钟（启用 TIMEOUT）+ 掉线本端自动 resume UI（宽限倒计时提示）。
4. 评分平滑（ELO 类，含 AI 座位因子）；指标页（终局原因/掉线率）。
5. 多标签/异地登录策略细化（新连接顶替旧 socket 已防误判负）。
