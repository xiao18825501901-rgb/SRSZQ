# PLAYER_LEAVE_SYSTEM_TEST_REPORT — Online Match 离开判负机制 · 完整测试

> 环境：Windows 11 · Node 24 · monorepo（shared/frontend/backend）· SQLite
> 全部测试在真实代码/真实服务器上执行（非分析推断），时间：本波次提交前最后一次全量回归。

## 1. 测试环境与命令

| 套件 | 命令 | 形态 |
|---|---|---|
| 单元（引擎/AI/后端纯函数） | `npm test`（vitest run） | 64 tests |
| WS 集成（多客户端真实长连接） | `cd backend && npx tsx tests/ws.integration.ts` | 12 场景（含 Test1–7） |
| HTTP/API 集成 | `npx tsx backend/tests/api.integration.ts` | 10 场景 |
| 平台 E2E（headless Edge ×2 + CDP） | `npm run e2e` | 25 项断言 |
| 前端生产构建 | `npm run build`（vite） | ✓ 456 modules |
| UI 真机流（双浏览器 × 真实匹配） | `node ui-leave-check.cjs` | 9 项断言 + 截图 |

测试参数（WS 集成）：`queueTimeoutMs=250, aiMoveDelayMs=10, disconnectSkipMs=250, aiTimeBudgetMs=60, inviteGatherMs=800, forfeitGraceMs=350`（生产宽限 10s 由 `SRSZQ_FORFEIT_GRACE_MS` 控制）。

## 2. 需求测试矩阵（Test1–7）

| # | 场景 | 通过 | 关键断言 |
|---|---|---|---|
| Test1 | 正常终局（1H+2AI 打到终局） | ✅ | `MATCH_ENDED.reason=NORMAL_WIN`；matches 落盘 `end_reason/winner_ids/loser_ids`；排行 games+1 且 rating = 胜 +30（wins+1）/ 负 −10（wins+0），winner/loser 数组与胜负一致 |
| Test2 | A 主动 Leave（PLAYER_RESIGN） | ✅ | 三方均收 `MATCH_ENDED{PLAYER_FORFEIT}`；loserSeats=[A]、winnerSeats=[B,C]、winnerIds=[B,C 的 id]、loserIds=[A]；DB `end_reason=PLAYER_FORFEIT`；排行 A −10/games+1/wins+0，B、C 各 +30/games+1/wins+1 |
| Test3 | 浏览器关闭/掉线 → 超宽限判负 | ✅ | 1H+2AI 人类关闭 socket 后（宽限 350ms）自动终局：`end_reason=PLAYER_DISCONNECT`、loserIds=[本人]、winnerIds=[]（AI 不获胜）；排行 −10；games 仅 1 行（AI 未继续） |
| Test4 | 宽限内重连恢复 | ✅ | A 掉线 → B/C 收到 `player.status disconnected`；B、C 各走一手后轮到 A 暂停（无自动跳过）；A 在宽限内 `resume` → 恢复同 gameId、收到 reconnected；越过原宽限时刻无 MATCH_ENDED、无落盘、排行不变；恢复后继续走子广播正常 |
| Test5 | 结束后可再次 Online Match | ✅ | Test2 判负后 A 立即重新入队得到**新 gameId** 新对局（无 “still in room/already playing/occupied”）；Test3 判负后再次匹配正常；3H 全员关闭宽限终局清理后再匹配正常；UI 层 X 离开后点“再来一局”回到 Searching（见 §4） |
| Test6 | 排行仅 Online 变化 | ✅ | 好友局发送 PLAYER_RESIGN → error（resign not allowed in this mode）、无 MATCH_ENDED；邀请局结束不计 games（非排位）；Human vs AI/教学/本地不走服务器 Match（零影响） |
| Test7 | AI 补位局人类退出 → 立即终局 | ✅ | 2H+1AI：A 退出 → `PLAYER_FORFEIT`，loser=[A]、winner=[B]（人类）；**终局后 500ms 无任何 game.state**（AI 不继续）；排行 B +30 / A −10；胜者立即可再匹配 |

## 3. 全量回归结果（真实输出）

- **vitest**：`Test Files 5 passed · Tests 64 passed (64)` ✅
- **WS 集成**：12/12 PASS —— Test1 正常终局 / Test2 主动离开判负 / Test5 结束后可再次匹配 /
  Test3 掉线超宽限判负 / Test4 宽限内重连恢复 / 3H 全员关闭清理 / Test6 好友局拒绝判负不计排位 /
  Test7 AI 补位退出即终局 / 教学门禁 / 两个好友 3H / GATHER 超时 2H+1AI / 离线接受不空转 ✅
- **API 集成**：10/10 PASS ✅
- **平台 E2E**：25/25 PASS（Landing/注册/教学门禁/HvAI/排行/邀请双浏览器/本地/在线排队/无 JS 错误）✅
- **前端生产构建**：✓ built in 363ms ✅
- **类型检查**：backend + frontend `tsc --noEmit` 0 error ✅

## 4. UI 真机验证（ui-leave-check.cjs，双 headless Edge + 真实 60s 匹配）

1. X、Y 注册并排队 → 60s 后 2H+1AI 自动开局 ✅
2. 对局页出现 **Leave Match**（在线对局头，仅真人）✅
3. 点击 Leave Match → 弹窗文案
   “Are you sure you want to leave? Leaving will count as a loss.” + Cancel / Confirm Leave ✅
4. Cancel → 仍在对局页，未判负 ✅
5. Confirm Leave → X 结算卡 **“You left the match. / Result: Loss”** ✅
6. Y 结算卡 **“Opponent left. / You win!”**（附 “玩家 A · LeaveA… left the match.”）✅
7. 排行：X 1200→**1190**（−10），Y 1200→**1230**（+30，games+1/wins+1）✅
8. X 点“再来一局” → 立即回到 Searching players（重新匹配能力）✅

截图（`results/leave-ui/`）：01-match-live / 02-leave-confirm-modal / 03-x-loss-card /
04-y-win-card / 05-x-requeue。

## 5. 测试中发现并修复的问题

1. **[E2E 回归] queue.join 自动续局过宽**：连接仍在房间内的玩家（好友局点了“离开”只是退出页面，
   socket 未断）再进匹配页时被自动“续局”回好友局，导致平台 E2E 的在线排队场景失败。
   → 修复：仅当玩家**不在房间 humanIds**（真掉线/刷新）时自动 resume；在房间内仍返回
   `already in game`（与旧版一致）。WS 集成 12 项 + E2E 25 项复跑全绿。
2. **[存量 Bug 顺带修复] 终局排行计算错误**：旧 `finishRoom` 用 `userId === winner(座位字母)` 比较，
   恒为 false → 正常终局时所有人类（含胜者）都被记 −10、wins 永不增加。
   → 新 `finalizeRoom` 按座位→userId 权威映射：败 −10 / 胜 +30（Test1/2/7 断言 rating 精确 ±30/−10 验证）。
3. **[语义迁移] Online 断线自动跳过 → 宽限判负**：旧 WS 测试 5 依赖“断线自动 forcePass（250ms）”，
   与 W3 判负语义冲突 → 改写为 Test4（宽限内 resume 恢复、无自动跳过），好友局保留自动跳过。

## 6. 结论

Test1–7 与全部回归 **PASS**；离开判负（主动/掉线）、宽限恢复、结算落盘、排行（仅 Online）、
房间清理与重匹配、AI 不继续、前端确认流程与双端结算文案均按需求验证通过。
