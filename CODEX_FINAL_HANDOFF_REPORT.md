# CODEX_FINAL_HANDOFF_REPORT — SRSZQ.com · Player Leave System（W3）

> 面向 Codex / 后续维护者的最终交接。仓库根：`D:\three-player-connect-four`（monorepo npm workspaces）。
> 提交：**`Implement online match player forfeit and leave handling`**（W3 单提交，含本报告前全部文档）。

## 1. Project Status

SRSZQ.com 三人四子棋平台，本地增量开发完成三大波次，当前 HEAD 为 W3 Player Leave System：

| 波次 | 内容 | 状态 |
|---|---|---|
| W1 | 平台化：Rules v2 引擎（13/17、BAC 资格 C→B→A、禁手、auto-pass）、5 档 AI（★1-5 隐藏）、后端（auth/session、匹配 60s AI 补位、服务器权威房间）、SQLite、SPA（Landing/Auth/Tutorial/Lobby/Online/HvAI/Local/Ranking/Friends/邀请）、Docker/文档 | ✅ |
| W2 | UI/UX 商业化 + 多人 Bug 修复：Design System（ui.tsx/global.css tokens）、Landing Hero v2、Lobby 大卡、glass nav、framer-motion、邀请状态机（GATHER/超时 AI_FILL）、排队倒计时、全局 GameLink 自动进入对局 | ✅ |
| W3 | **Online Match 玩家主动离开判负**：Leave Match + 确认弹窗、掉线 10s 宽限判负、MATCH_ENDED/end_reason 落盘、排行 ±30/−10（修复旧排名 Bug）、房间清理与重匹配、AI 不继续、全量测试与交接文档 | ✅ 本次 |

所有测试绿：vitest 64/64 · WS 集成 12/12（Test1–7 全覆盖）· API 10/10 · 平台 E2E 25/25 ·
UI 真机流 9/9（含截图）· 前端生产构建 ✓。

## 2. Architecture（简要）

- **shared/**：唯一规则源（引擎 v2 + AI）。`rules.ts`（applyMove/forcePass/eligibility 资格 R6 起 C→B→A）、
  `legalMoves.ts`、`ai/`（random/tactical/selfish/3ply/maxn，对外 ★1–5）。
- **backend/**：Node24 + `ws` + `node:sqlite`（零外部依赖）。
  - `src/ws/gameServer.ts`：WebSocket 权威房间。队列（60s AI 补位）→ `startRoom`（按序占座 A/B/C，AI 补齐）→
    共享引擎校验每步 → 广播。房间状态机（W3 扩展）：`PLAYING / PLAYER_LEFT(宽限) / FINISHED`，座位连接态
    `connected / disconnected / left`。终局唯一出口 `finalizeRoom`（落盘 + 排行 + MATCH_ENDED + 清理）。
  - `src/db.ts`：仓储接口（可换 PostgreSQL）；`matches` 现含 `end_reason/winner_ids/loser_ids`（幂等迁移）。
  - `src/api.ts / server.ts`：HTTP（auth/好友/邀请/排行）+ 启动装配（env 见 §5）。
- **frontend/**：React19 + Vite + 自研 hash router。全局 `GameLink`（`src/ws.ts`）驱动对局态；
  `platform/OnlinePage.tsx` 为 Online 对局页（Leave Match / 结算卡 / 掉线横幅）。
- **docs/**：ARCHITECTURE（根）、API_DOC、DATABASE_SCHEMA、DEPLOYMENT、DesignSystem、TEST_REPORT 等。

## 3. Recent Change — Player Leave System（W3 增量明细）

见 `PLAYER_LEAVE_FEATURE_REPORT.md`（前后对照）与 `PLAYER_LEAVE_SYSTEM_TEST_REPORT.md`（测试证据）。要点：

1. **协议**：客户端新增 `PLAYER_RESIGN`；服务端新增 `MATCH_ENDED{matchId,mode,reason,winnerIds,loserIds,winnerSeats,loserSeats,timestamp}`、
   `player.status{seat,status,graceMs?}`；`queue.join` 对“掉线但房间未结束”者自动续局；`game.end` 增补 reason/胜败数组。
2. **判负语义**：主动 Leave 立即终局（PLAYER_FORFEIT）；断线进入 DISCONNECTED_TEMPORARY 宽限
   （`SRSZQ_FORFEIT_GRACE_MS` 默认 10s）→ resume/重入恢复 → 超时 PLAYER_DISCONNECT 终局；1H+2AI/2H+1AI 人类退出即终局（AI 不继续）。
3. **排行（仅 Online）**：败者 games+1 / −10，胜者 games+1 / wins+1 / +30（同时修复旧代码胜者被判 −10 的 Bug）。
4. **清理/重匹配**：终局释放全部成员 userGame/客户端绑定并删除房间；残留绑定在 queue.join 自动释放。
5. **前端**：Leave Match（danger）+ 确认弹窗（Cancel/Confirm Leave）；结算文案
   “You left the match. / Result: Loss”、“Opponent left. / You win!”；掉线/重连横幅；好友局 UI 与语义不变。

### 变更文件
```
backend/src/ws/gameServer.ts    （核心：状态机/判负/终局/续局/清理）
backend/src/db.ts               （matches 3 列 + 幂等迁移 + saveMatch）
backend/src/server.ts           （SRSZQ_FORFEIT_GRACE_MS）
backend/tests/ws.integration.ts （Test1–7 + 回归 12 场景重写）
frontend/src/ws.ts              （GameLink：MATCH_ENDED/player.status/endInfo/resign）
frontend/src/platform/OnlinePage.tsx（Leave Match/Modal/结算卡/横幅）
docs/API_DOC.md · docs/DATABASE_SCHEMA.md · .env.example
PLAYER_LEAVE_FEATURE_REPORT.md · PLAYER_LEAVE_SYSTEM_TEST_REPORT.md · 本文件
ui-leave-check.cjs · results/leave-ui/*.png（UI 真机验证脚本与截图）
```

## 4. How To Run

```bash
npm install                     # workspaces（前端无第三方 UI 库依赖新增）
npm run dev:backend             # API :8080 + WS :8081（tsx watch，热载）
npm run dev                     # 前端 Vite :5173
# 测试（独立 tsx 进程跑真实 WS/HTTP；vitest worker 沙箱禁回环故不走 HTTP）
npm test                        # vitest 64
npm run test:backend            # API 集成 10
npm run test:ws                 # WS 集成 12（含 Test1–7）
npm run e2e                     # 平台 E2E（需 5173/8080/8081 运行；headless Edge×2）
node ui-leave-check.cjs         # Leave Match UI 真机流（需服务运行，约 2.5 分钟；截图入 results/leave-ui/）
npm run build                   # 前端生产构建 → frontend/dist
docker compose up -d            # 容器化部署（见 docker/）
```
浏览器端到端默认用 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（`EDGE_PATH` 可覆盖）。

## 5. Env Vars（backend，全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 8080 | HTTP API |
| SRSZQ_WS_PORT | 8081 | WebSocket |
| SRSZQ_QUEUE_TIMEOUT_MS | 60000 | 匹配等待，超时 AI 补位 |
| SRSZQ_AI_DELAY_MS | 350 | AI 思考延迟 |
| SRSZQ_DISCONNECT_SKIP_MS | 30000 | **好友局**断线轮到自动跳过间隔 |
| SRSZQ_FORFEIT_GRACE_MS | **10000** | **Online Match 掉线判负宽限期（W3 新增）** |
| SRSZQ_INVITE_GATHER_MS | 30000 | 双邀请聚合窗口 |
| VITE_API_URL / VITE_WS_URL | localhost:8080 / ws://localhost:8081/ws | 前端构建期注入 |

## 6. Deployment Checklist

- [ ] `npm install && npm run build`（前端产物 `frontend/dist`，Nginx 托管 SPA + `/api`、`/ws` 反代；
      详情见 `docs/DEPLOYMENT.md`、`docker-compose.yml`）
- [ ] 后端以 Node ≥ 22.5（用 node:sqlite，建议 24）启动；`data/` 可写
- [ ] 首次启动对旧库自动补 `matches.end_reason/winner_ids/loser_ids`（幂等，无需手工迁移）
- [ ] 长连接：反向代理须支持 WebSocket upgrade；生产建议 `SRSZQ_FORFEIT_GRACE_MS` 保持 10s（与前端提示一致）
- [ ] 环境变量经 `.env` / compose 注入（§5）
- [ ] 冒烟：注册→教学→Online Match 排队→对局中出现 Leave Match→确认判负→排行变化→可再匹配

## 7. Known Issues / 边界（有意为之，见 FEATURE_REPORT §8）

- 多人同时掉线：首个宽限到期即结算，其余离场者也按败记录（不重复计分）。
- 判负后返回的玩家无“历史结果弹窗”（对局历史页为未来规划；排行榜已即时反映）。
- `TIMEOUT` endReason 预留（回合时钟未启用）。
- 好友局无判负/排位（旧语义保留），`PLAYER_RESIGN` 被服务器拒绝。
- 旧版“Online 断线自动跳过”语义已迁移为宽限判负；好友局仍自动跳过（断线不判负）。

## 8. Recommended Next Steps

1. **对局历史页**：按 games/matches 提供“我的战绩/最近对局（含 end_reason）”UI；判负玩家回站可见。
2. **回合时钟**：启用 TIMEOUT 终局（如每手 60s 累计池），配套倒计时 UI。
3. **掉线提示给离场者**：断线期间本端显示“重连中/宽限剩余秒数”并自动 resume（当前返回匹配页即自动恢复）。
4. **评分平滑**：胜负 ±30/−10 可平滑为 ELO 类公式（含 AI 座位因子），matches 已具备扩展字段。
5. **鉴权重试**：多标签/异地登录策略（当前同一用户新连接顶替旧 socket，旧 socket close 已被忽略）。
6. **数据可观测**：matches 行数/终局原因分布/掉线率指标页（管理员）。
