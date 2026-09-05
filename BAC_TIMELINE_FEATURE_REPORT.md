# BAC_TIMELINE_FEATURE_REPORT — BAC Qualification Timeline（Online Match 实时胜权可视化）

> 项目：SRSZQ.com 三人四子棋 ｜ 波次：W4（增量；不重建项目、不改 BAC 规则、不复制资格系统）
> 提交：`Add BAC qualification timeline display for online matches`

## 0. 规则真值（以代码为准，非猜测）

资格引擎唯一来源 `shared/src/game/eligibility.ts`（v2 正式规则）：
- **Round 1–5：无任何玩家拥有胜权**（`getEligiblePlayer(round) === null`）；
- **Round ≥ 6：按 C → B → A 循环**：R6=C、R7=B、R8=A、R9=C…（`ELIGIBLE_ORDER=['C','B','A']`）。
- Round 与回合换算：`round = floor(turnIndex/3)+1`。
- 用户需求描述中“Round 4 起 B/A/C”与现引擎不符，按指令“以项目当前实现为准”，
  全部展示/测试以引擎真实输出为准（R6=C 首次持权）。

## 1. 功能目标（达成）

- Online Match（含邀请对局）游戏页新增 **BAC Qualification Timeline Panel**：
  1) 当前 Round 谁持胜权（CURRENT 卡）；
  2) 下一轮是谁（NEXT）；
  3) 未来 8 轮连续安排（FUTURE 8 ROUNDS，R1-5 显示“— 无人”，数据层 lookahead 可扩展）。
- 玩家视角：自己持权 → **YOUR VICTORY WINDOW**（“You currently have the legal winning right.”）；
  他人持权 → “Player X currently has winning right. / 注意防守”；R1-5 → VICTORY LOCKED + 下次窗口提示。
- Human vs AI / Local / 教学共用同一面板（本地引擎数据），AI 座位照常显示（如 “AI ★★★ holds”），
  **资格状态不因 AI/人类而异**。
- 实时性：Online 每次 `game.state` 广播携带 qualification（服务器权威）；落子推进 Round 即自动更新；
  断线重连（resume/刷新）由 `game.start` 恢复完整 timeline。
- 不破坏棋盘：桌面 = Board + 侧栏面板；小屏 = 面板折叠至棋盘下方（可展开，不遮挡）。
- 未改：BAC 规则 / AI / 排行榜 / Leave-Feature / WebSocket 会话语义。

## 2. 架构设计

```
shared/src/game/eligibility.ts   ← 资格规则唯一实现（未动）
shared/src/game/qualification.ts ← 新增：时间线“取窗口”层（qualificationOf / qualificationFromState /
                                    nextEligibleRoundAfter / QUALIFICATION_LOOKAHEAD=8）
        ▲ 后端 import（WS payload）          ▲ 前端 import（本地/人机引擎页 fallback）
backend/src/ws/gameServer.ts     ← game.start / game.state 每帧附加 qualification（服务器权威）
frontend/src/ws.ts               ← GameSnapshot.qualification（随广播刷新）
frontend/src/components/bacTimelineModel.ts   ← 纯模型：resolveView/rowsFromView/seatName/perspectiveLines
frontend/src/components/BacTimelinePanel.tsx  ← Design System 面板组件（CURRENT/NEXT/8-round rows）
frontend/src/platform/OnlinePage.tsx          ← Online/邀请页嵌入（侧栏；移动折叠）
frontend/src/App.tsx                          ← Local/VsAI/Tutorial host 嵌入（替换旧 chips 时间轴）
frontend/src/styles/global.css                ← .bac-* Design System 样式 + .online-layout 响应式
```

原则：**前端不自行推导资格**——Online 只消费服务器 payload；本地/人机用共享引擎同源函数。
“取窗口”逻辑仅一份（shared），无第二套 BAC。

## 3. Backend 修改（before → after）

| 位置 | Before | After |
|---|---|---|
| `gameServer.ts` startRoom/resumeIntoRoom `game.start` | {gameId,mode,seats,yourSeat,state} | + `qualification: qualificationFromState(room.state)` |
| `gameServer.ts` broadcastRoom `game.state` | {state,seats} | + `qualification`（每步广播实时刷新） |
| 新增 import | — | `shared/src/game/qualification.js` |

DB：无改动。排行/判负/清理逻辑：无改动。负载：每帧一次纯函数窗口计算（≤10 轮 × O(1)）。

## 4. Frontend 修改（before → after）

- **新增 `BacTimelinePanel`**（Design System tokens：ds 边框/圆角/阴影/色板；玩家色 PLAYER_COLORS）：
  - 标题：BAC Victory Timeline（副标：Round 6 起 C → B → A 循环）；
  - CURRENT 卡：`CURRENT · ROUND N` + 持权者彩色圆章 + `🏆 Victory Right` pill；
    R1-5 显示 `VICTORY LOCKED`（虚线边框）+ “下次胜权窗口：Round 6 · C”；
  - 持权视角横幅：自己 → 紫色辉光 `★ YOUR VICTORY WINDOW`；他人 → 防守提示（human 显示用户名 / AI 显示 ★）；
  - NEXT 8 ROUNDS 行：每行 R{round} + NOW/NEXT 徽标 + 持权圆章 + 名称 + 自己的窗口行打 `YOU`；
  - 结束态：ENDED 徽标 + 胜者注记；
  - 移动端：面板内“展开/收起”按钮（<980px 默认折叠，CSS 媒体查询控制，不遮挡棋盘）。
- **OnlinePage**：`.online-layout`（棋盘 1fr + 侧栏 336px；<980px 单列）；数据 = `game.qualification`
  （服务器 payload），mySeat/seats 用于视角文案；重连后 `game.start` 自动恢复。
- **App.tsx（Local/HvAI/教学 host）**：侧栏旧 chips 时间轴 `QualificationTimeline`（已删除）
  → 新 `BacTimelinePanel`（state 走共享引擎 qualificationFromState；AI 座位只显示 ★）。
- **ws.ts**：GameSnapshot 增加 `qualification`；game.start/game.state 均吸收。
- 既有 UI（大厅/排行/结算/Leave Match/匹配页）未动。

## 5. WebSocket 修改

- `game.start` / `game.state` 新增字段 `qualification`：
  ```json
  { "currentRound": 8, "currentEligible": "A",
    "upcoming": [ {"round":9,"player":"C"}, {"round":10,"player":"B"}, … ×8 ] }
  ```
- 无新消息类型；向后兼容（旧客户端忽略新字段）。
- 服务器权威：客户端不能传 qualification，也不能改 Round 归属。

## 6. 测试结果（真实执行）

| 套件 | 结果 |
|---|---|
| vitest 单测（新增 16：shared qualification 9 + 前端模型 7） | **80/80 PASS**（原 64 + 新 16） |
| WS 集成（新增 2 场景） | **14/14 PASS**：W4-BAC payload（开局 R1 NONE+8 轮窗口；推进至 R6 自动更新 qualification=C）；
  W4-BAC 多人同步（三方 qualification 完全一致）+ resume 恢复 timeline |
| 平台 E2E（新增 4 断言组） | **ALL PASS**：HvAI R1 VICTORY LOCKED → 实时推进 R6（AI ★★★ 持权）；邀请对局双浏览器 R1/R6 双端一致 |
| 本地规则 E2E（改造 3 断言组 + 截图钩子） | **ALL PASS**：R1 锁定视图 / R2 自动更新 / R6 视角（Player C + Victory Right + R7/R8） |
| 前端生产构建 / tsc | 待终检（本报告后全量复跑） |

需求测试映射：
- Test1 新开局显示 Round 1/No one → WS payload R1 null + UI VICTORY LOCKED ✅
- Test2 Round 资格正确 → 引擎真值 R6=C（R4 依引擎仍 NONE，文档化）✅（shared 单测 + WS + UI）
- Test3 Round 推进自动更新 ✅（WS 每帧 payload + UI 驱动至 R6）
- Test4 A/B/C 三视角一致 ✅（3H WS：三方 qualification JSON 全等；视角文案按座位单元测试）
- Test5 Human vs AI 显示 ✅（平台 E2E HvAI R1→R6）
- Test6 Online WS 多人同步 ✅（邀请双浏览器 + WS 3H）
- Test7 刷新重连恢复 ✅（WS resume 携带 qualification；game.start 恢复断言）
- 单元：Round 1 NONE / Round 4 按引擎输出 / Round 100 周期正确 / payload→渲染行模型 ✅

## 7. 截图说明（results/bac-timeline/）

| 文件 | 内容 |
|---|---|
| `bac-r1-locked.png` | Local 页 R1：CURRENT · ROUND 1 + No one + VICTORY LOCKED + 下次胜权窗口 Round 6 · C + 未来 8 轮（— 无人） |
| `bac-r6-eligible-C.png` | 同局推进至 R6：CURRENT · ROUND 6 · Player C 🏆 Victory Right（圆章高亮）+ R7/R8 未来行 |

（Online 页双端 R1/R6 实况文本断言见平台 E2E 输出；“YOU”窗口视角在 Online 端以 mySeat 驱动，前端模型单测覆盖文案。）

## 8. 已知边界

- Online 端以服务器 payload 为准；若 payload 缺失（理论不发生）会回退共享引擎计算（同规则源）。
- 未来窗口固定 8 轮（常量可调）；数据层 `qualificationOf(currentRound, lookahead)` 已支持扩展。
- 教学/本地/人机页无 mySeat 概念，不显示 “YOUR VICTORY WINDOW”，其余展示一致。
