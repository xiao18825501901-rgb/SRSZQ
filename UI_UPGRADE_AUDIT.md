# UI_UPGRADE_AUDIT — SRSZQ.com UI/UX 升级前审计

> 审计对象：`D:\three-player-connect-four`（SRSZQ.com monorepo，正式规则 v2）
> 审计方式：读取 frontend/backend 实际代码与运行状态；本地服务 5173(前端)/8080+8081(后端) 运行中。

## 1. 当前技术栈与结构

| 层 | 技术 | 位置 |
|---|---|---|
| 前端 | React 19 + TS + Vite 8，**手写 CSS**（无 Tailwind/组件库/动效库），哈希路由 | `frontend/src/` |
| 页面 | 单文件路由 `platform/Platform.tsx`：Landing/Auth/Lobby/Ranking/Friends/Tutorial/LocalHost；`platform/OnlinePage.tsx`（排队/对局）；本地/人机/教学复用 `App.tsx`（宿主 props：presetSeats/hostTitle/onExit/onGameEnd/embedded） | frontend/src/platform |
| 通用组件 | Board/Cell/PlayerCard/Modal/GameControls/MoveHistory/QualificationTimeline/SeatSetup/StatusBar(内联 App)/DebugPanel | frontend/src/components |
| 网络 | `api.ts`（fetch+token）、`ws.ts`（SrszqSocket 单例、自动重连） | frontend/src |
| 样式 | `styles/global.css`（深色竞技基调）+ 追加的 `.pf-*` 平台样式 | frontend/src/styles |
| 后端 | Node+TS+ws：HTTP(8080) auth/social/ranking；WS(8081) GameServer（队列/房间/AI 补位/断线/resume）；SQLite | backend/src |
| 共享 | 引擎+rules v2+五档 AI（★ 隐藏） | shared/src |

## 2. 页面结构（路由一览）

`#/` Landing · `#/auth` · `#/tutorial`（3 局教学门禁）· `#/lobby` · `#/online` · `#/vsai` · `#/local` · `#/ranking` · `#/friends`

## 3. 组件结构要点
- Lobby 用 `.mode-card` 按钮卡片（四张平铺）
- Landing 为单列 hero + 规则列表（大面积空白）
- 在线对局页自绘 statusbar 变体（与本地 App 的 StatusBar 不统一）
- Auth/Lobby/Ranking/Friends/Tutorial 各自内联样式类（`.auth-card/.lobby/.pf-table/.friend-row…`），无共享设计令牌

## 4. 设计问题（现状）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| D1 | Landing 空旷：无截图/特色/AI/排行入口，白底感强，hero 文案平淡 | Platform Landing | 无商业质感 |
| D2 | Lobby 四入口是窄按钮卡，占屏 <15%，余下大段空白，信息密度低 | Lobby | 视觉失衡 |
| D3 | 无统一 Design System：按钮/卡片/圆角/阴影/间距各页自行定义（`.btn/.panel/.pf-panel/.mode-card/.auth-card…`），类名与风格不收敛 | global.css | 不一致、难维护 |
| D4 | 无动效体系：无 hover 反馈（除少量 border/translate）、无页面过渡、棋子落下无动画 | 全局 | 无“高级感” |
| D5 | 排版层次弱：标题字号/字重/行高未成体系；大面积单色背景缺层次（无 gradient/glow/glass） | 全局 | Demo 感 |
| D6 | 导航仅是普通按钮行，无 sticky/glass/状态视觉（rating/在线点弱） | Platform nav | 弱 |
| D7 | 排行/好友页信息密度低、无状态徽章体系 | Ranking/Friends | 弱 |

## 5. 用户体验问题

| # | 问题 | 影响 |
|---|---|---|
| U1 | Online 排队无倒计时与阶段提示（只有“正在排队…当前等待 N 人”） | 用户不知道还要等多久/何时 AI 补位 |
| U2 | 好友接受邀请后若不在对局页，**房间已开但页面不跳转**；用户被困“playing”直到房间中止 | 邀请流程断裂（Bug，见 B2） |
| U3 | Local/教学/人机视图顶部重复两行（平台返回条 + App topbar），信息重复 | 拥挤 |
| U4 | 移动端无专门适配验证；部分表格/卡组可能溢出 | 响应式弱 |
| U5 | 胜负/结算反馈单调（仅 notice 文本） | 缺仪式感 |

## 6. Multiplayer Bug 位置（结合代码与测试证据）

| # | Bug | 根因（代码位置） | 影响 |
|---|---|---|---|
| B1 | 60s 匹配超时 AI 补位（用户侧可见） | 服务端逻辑已实现并有 250ms 集成测试通过；**前端无倒计时/无阶段提示**，且 `queue.joined` 未携带超时元数据 | 用户感知“卡在等待页” |
| B2 | 好友接受邀请后不自动进入对局 | 邀请接受走 REST hook → GameServer.startInviteGame；`game.start` 只推送给**当时已连 WS 且在线**的客户端；大厅/好友页**未连接 WS** → 消息丢失；服务端已把用户标记 playing、humanIds 空 → 房间空转不结束（仅当全员 close 才 abort，这里无人 close） | 邀请后卡死/无法再匹配 |
| B3 | 两个好友接受时应三真人，目前每个 accept 各自开 2H+AI 房 | accept 直接 `startInviteGame(sender, receiver)`，无“邀请会话聚合”状态机 | 与规格 Test5 不符 |
| B4 | 邀请“失败继续等待”无明确状态 | 前端邀请页只显示发送成功文本，无 WAITING/ACCEPTED 状态反馈轮询（可接受） | 信息缺失 |

## 7. 修改计划（分阶段，每步运行验证）

1. **P0 多人修复（先做）**
   - 服务端：邀请状态机（invite sessions：1 接受 → 2H+AI 立即；2 个待接受 → 第二个接受后 3H；等待窗超时仍 1 个 → 2H+AI；全拒 → 清理）；匹配超时元数据（`queue.joined` 带 timeoutMs/queueStartAt）；防御：startRoom 时若真人无连接 → 不空转（中止或等待）。
   - 前端：全局 GameLink（登录后连接 WS；任意页面收到 game.start → 自动进入 #/online 对局页；结束返回大厅）；OnlinePage 倒计时（Searching players… 30s/45s/60s）。
   - 测试：WS 集成新增 Test5（两好友接受→3H）、Test2/3 已在、Test4 已有；邀请+自动开局前端路径浏览器验证。
2. **P1 Design System**：CSS 令牌（颜色/字体/圆角/阴影/间距/动效时长）+ 收敛按钮/卡片/输入/徽章组件类；`DesignSystem.md`。
3. **P2 视觉升级**：Landing（Hero 文案/渐变/玻璃卡/截图区/特色/AI ★/BAC 条/排行入口）；Lobby 大型 Feature Cards（4 卡 ≥20-25% 屏宽，icon/desc/状态/按钮，hover 动效）；Auth/Ranking/Friends/Tutorial 统一视觉；Framer Motion 页面过渡 + 卡片 hover + 棋子落下动画（克制）。
4. **P3 验证与报告**：浏览器实跑记录 TEST_REPORT_UI_UPGRADE.md；性能/console/WS/内存检查修复；组件化复查；SRSZQ_UI_UPGRADE_REPORT.md + CODEX_HANDOFF_REPORT.md；git 提交（消息：Upgrade SRSZQ UI system and fix multiplayer matchmaking）。

## 8. 红线（自检）
- 不删除现有页面/路由、不重写引擎/AI/BAC、不更换第二套实现；升级以增量修改 + 复用组件为准。
