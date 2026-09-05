# PLAYER_LEAVE_FEATURE_REPORT — Online Match 玩家主动离开判负系统

> 项目：SRSZQ.com（三人四子棋） ｜ 波次：W3（增量，不重建/不替换架构）
> 提交：`Implement online match player forfeit and leave handling`
> 范围：Online Match（排位在线对局）专属；好友对局 / Human vs AI / 教学 / 本地对局不受影响。

## 1. 需求落地对照

| 需求 | 实现 |
|---|---|
| A. 主动离开 = 立即判负 | 对局页新增 **Leave Match**（danger 按钮，不可误触）+ 确认弹窗（Cancel / Confirm Leave）→ 发送 `PLAYER_RESIGN` → 服务器立即结算 |
| B. 关闭标签/刷新/断网 = 掉线判负 | socket close → 座位进入 **DISCONNECTED_TEMPORARY**（宽限期 `SRSZQ_FORFEIT_GRACE_MS`，默认 **10s**）→ 超时 → FORFEIT 判负结算（`PLAYER_DISCONNECT`） |
| C. 短暂网络抖动可恢复 | 宽限期内 `resume` / 重新进入匹配页自动恢复原局（服务端续局，清定时器、广播 `player.status reconnected`）；AI 在有人离场期间暂停推进，公平恢复 |
| 状态机 | `PLAYING →(resign)→ PLAYER_LEFT → FINISHED(PLAYER_FORFEIT)`；`PLAYING →(disconnect)→ PLAYER_LEFT(宽限) →resume→ PLAYING / 超时 → FINISHED(PLAYER_DISCONNECT)`；正常终局 → FINISHED(NORMAL_WIN) |
| MATCH_ENDED 广播 | `{matchId, mode, reason, winnerIds, loserIds, winnerSeats, loserSeats, timestamp}`；`game.end` 同步扩展（向后兼容保留 status/winner） |
| 结果落盘 | `matches` 表新增 `end_reason / winner_ids / loser_ids`（幂等 ALTER 迁移）；`result` 仍存胜者座位 |
| 排行规则 | 仅 Online：败者 `games+1, loss+1, rating−10`；胜者 `games+1, win+1, rating+30` |
| AI 补位兼容 | 1H+2AI / 2H+1AI 人类退出 → **立即终局，AI 不继续**（无 AI 胜者/败者记录） |
| 房间/会话清理 | 终局唯一出口 `finalizeRoom`：清宽限定时器、释放全部人类成员 `userGame`、`touchOnline`、删房间 → 可立即重新匹配 |
| 安全 | winner/loser 全部由服务器按 `seats/members` 推导；客户端任何消息都不携带胜负声明；`PLAYER_RESIGN` 仅限本人座位 + online 模式 + 未终局 |

## 2. Backend 变更（before → after）

`backend/src/ws/gameServer.ts`
- **Before**：断线玩家仅周期自动 Pass（`disconnectSkipMs` 30s），无判负；`finishRoom` 排行计算用
  `uid === winner`（userId 与座位字母比较 → **恒 false**：胜者也被记 −10、wins 永不 +1，潜在 Bug）。
- **After**：
  1. 类型扩展：`EndReason`（NORMAL_WIN/PLAYER_FORFEIT/PLAYER_DISCONNECT/TIMEOUT）、座位连接态
     `SeatConn`、房间阶段 `RoomPhase`（PLAYING/PLAYER_LEFT/FINISHED）、`Room.endReason/phase`。
  2. 新消息 `PLAYER_RESIGN`（仅 online 房间有效，好友局 error `resign not allowed in this mode`）。
  3. `onClose` 按模式分流：好友局保留旧逻辑（全员离开中止 / 轮到自动 Pass）；Online Match → `beginLeaveGrace`
     （座位 disconnected、通知他人、定时器 = 宽限期）。
  4. 新增 `beginLeaveGrace / resumeIntoRoom / forfeitSeat / finishNormal / finalizeRoom`：
     - `resumeIntoRoom`：resume 消息与 `queue.join`（掉线重连后回到匹配页）共用；清宽限定时器、广播 reconnected；
     - 旧 socket 关闭但新连接已在（刷新竞态）→ 忽略，不误判负；
     - `forfeitSeat`：败者 = 离开者 + 宽限中的其他离场人类；胜者 = 在场人类；1H+2AI 人类离场 → 无胜者仅记败；
     - `finalizeRoom`：落盘（games/matches 含 end_reason/winner/loser 数组）+ 排行（败 −10 / 胜 +30，按 userId 正确映射座位）+ MATCH_ENDED/game.end 广播 + 释放全部成员与房间。
  5. `maybeRunAI`：Online 房间有人宽限时暂停 AI 推进；对局恢复/判负后再触发。
  6. `queue.join`：房间已清理的残留 userGame 绑定 → 自动释放再入队（消灭 “still in room/already playing” 僵尸态）。
  7. 修正旧排行 Bug：正常终局胜者（人类座位）+30 & wins+1，其余人类 −10（按座位→userId 推导）。

`backend/src/server.ts`：新增 `SRSZQ_FORFEIT_GRACE_MS`（默认 10000ms）。

`backend/src/db.ts`：`matches` 建表加 `end_reason/winner_ids/loser_ids`；对已有库启动时
`PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 幂等迁移；`saveMatch` 扩展入参并 JSON 存储 id 数组。

## 3. Frontend 变更（before → after）

- `frontend/src/ws.ts`（GameLink）
  - 新消息处理：`MATCH_ENDED` / 扩展 `game.end` → `endInfo{status,reason,winnerSeats,loserSeats,…}`；`player.status` → 座位状态横幅事件；`resign()` 发送 `PLAYER_RESIGN`。
  - 结算文案按 reason + 本人座位归属推导（败者/胜者判定只信服务器数组）。
- `frontend/src/platform/OnlinePage.tsx`
  - Online Match 对局头：旧 “离开” 幽灵按钮 → **Leave Match**（Design System danger）；
  - 确认弹窗（Design System Modal + ds-btn）：*“Are you sure you want to leave? Leaving will count as a loss.”* + Cancel / Confirm Leave；点 Cancel 不产生任何后果；
  - 结算卡文案：离开者 **“You left the match. / Result: Loss”**（掉线超时附宽限说明）；在场者 **“Opponent left. / You win!”**；正常终局保留原有文案；
  - 掉线/重连横幅：`玩家 X 掉线了 — N 秒内未返回将判负（本局暂停等待）` / `玩家 X 已重连，对局继续`；
  - 好友局仍显示旧 “离开”（不判负）；结束页/匹配页无变化（copy 兼容既有 E2E 断言）。

## 4. WebSocket 协议（新增）

客户端 → `PLAYER_RESIGN`；服务端 → `MATCH_ENDED`、`player.status{seat,status,graceMs?}`；
`queue.join` 增加“已在未结束对局中且掉线 → 自动续局”语义；`game.end` 增补 reason/胜败数组字段。

## 5. 数据库变更（迁移）

```sql
ALTER TABLE matches ADD COLUMN end_reason TEXT NOT NULL DEFAULT 'NORMAL_WIN';
ALTER TABLE matches ADD COLUMN winner_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE matches ADD COLUMN loser_ids TEXT NOT NULL DEFAULT '[]';
```
（`end_reason ∈ NORMAL_WIN|PLAYER_FORFEIT|PLAYER_DISCONNECT|TIMEOUT`；数组存 userId JSON。）

## 6. 环境变量

`SRSZQ_FORFEIT_GRACE_MS=10000` — 掉线判负宽限期（ms）。已写入 `.env.example`。

## 7. 覆盖验证

见 `PLAYER_LEAVE_SYSTEM_TEST_REPORT.md`（Test1–Test7 + 回归全绿）与 `CODEX_FINAL_HANDOFF_REPORT.md`。

## 8. 已知边界（有意为之）

- 多人在场同时掉线：首个宽限到期即结算，其余离场者也记败（宽限被房间终局打断，不重复计分）。
- 掉线者超时判负后返回页面：显示可重新匹配（无历史弹窗；对局历史页为后续版本规划）。
- `TIMEOUT` endReason 保留给未来的回合时钟，当前不触发。
- 好友局保持旧“断线自动 Pass / 全员离开中止”语义（无判负、无排位），PLAYER_RESIGN 被拒。
