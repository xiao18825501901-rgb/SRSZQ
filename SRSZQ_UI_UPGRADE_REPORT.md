# SRSZQ_UI_UPGRADE_REPORT

> UI/UX 商业级升级 + Multiplayer 修复交付报告（对应提交消息：
> `Upgrade SRSZQ UI system and fix multiplayer matchmaking`）。

## 1 项目状态

### 修改前（问题）
- Landing 空旷、无截图/特色/排行入口；Hero 文案平淡（Demo 感）
- Lobby 四入口为窄按钮卡（占屏 <15%），大面积空白、视觉失衡
- 无统一设计系统：按钮/卡片/圆角/阴影/间距各页自定（.btn/.panel/.mode-card/.auth-card…）
- 无动效体系；棋子落下无反馈；导航为普通按钮行
- Multiplayer：好友接受邀请后页面不跳转、房间空转且用户被困“playing”；
  两个好友接受时应 3 真人却各开 2H+AI；在线排队无倒计时/阶段提示

### 修改后（效果）
- Landing = 游戏平台质感首页：Hero「Three Player Strategy Battle / Think. Predict. Dominate.」+
  渐变大字 + 轨道光晕 + 迷你棋盘“实况预览”+ 4 张特色卡（在线/AI★五档/好友/排行）+
  BAC 规则条 + 排行榜入口；无横向溢出
- Lobby = 4 张大型 Feature Card（实测 274×339px，占屏 ≥20-25%），icon + 描述 + meta + CTA +
  framer hover 抬升；消除空白失衡
- Design System：CSS 令牌（色彩/圆角/阴影/动效）+ ui.tsx 原语（Btn/Card/StatusBadge/Stars/PageMotion），
  全站登录注册/大厅/排行/好友/在线页统一（DesignSystem.md）
- 动效克制：页面淡入、卡片 hover glow、落子仅末手播放下落动画、排队倒计时进度条
- Multiplayer：邀请状态机（WAITING→INVITED→ACCEPTED→GATHER→AI_FILL/ROOM_READY→STARTED）——
  1 接受 → 2H+AI；2 接受 → 3H；GATHER 超时回退 2H+AI；离线接受不空转；在线 60s 自动 AI 补位
  （1→H+AI+AI，2→H+H+AI）；客户端 Searching players… 倒计时；任意页面收到 game.start 自动进入对局页

## 2 UI 升级明细
- 首页：hero2/orbs/mini-board/features/rules-strip/排行入口（含 AI 隐藏复查：仅 ★，无档位名）
- 大厅：lobby2 + fcard 大型卡片（图标/描述/状态/CTA，motion 入场 + hover）
- 用户页：AuthCard2 + 字段组件化（.field），登录注册保持旧文案兼容自动化
- 好友页/排行榜：ds-panel + ds-title + 状态徽章体系（在线/对局中/匹配中/离线）
- 在线页：匹配中卡片（🔍 Searching players… + 秒数 + 进度条 + AI 补位说明）、结算徽章化
- 游戏内：落子动画（仅最后一步 ds-drop）；平台返回条与顶部统一为玻璃导航
- 页面过渡：PageMotion（framer-motion 280ms）

## 3 Bug 修复详情
1. **Online Match AI fallback**：服务端在队列首人入队时记录 queueStartAt，超时 flush 时 1/2 人
   分别补 2/1 个 AI（原有逻辑保留并加元数据）；前端倒计时展示（30/45/60s），不再“卡在等待页”。
2. **Friend Invitation AI filling（核心）**：新增邀请会话状态机（GameServer.inviteSessions）：
   - 邀请登记（onInviteCreated）→ 接受（handleInviteAccept）/拒绝（onInviteRejected）
   - 单邀请接受 → 立即 2H+1AI（非排位）
   - 双邀请：第一位接受进入 GATHER（默认 30s，可配 inviteGatherMs）；
     第二位接受 → 3 真人开局；GATHER 超时仍 1 人 → 2H+1AI；其余被拒只剩 1 接受 → 立即 2H+1AI
   - 防御：在线真人 <2 不开房（避免空转占用用户）
3. **State machine / 前端跳转**：全局 GameLink（ws.ts）登录即连，接收 game.start/state/end；
   Platform 在任意页面（大厅/好友）收到开局自动跳 #/online；教学门禁对邀请局放行、对匹配保持拦截；
   登出 resetSocket 清理。
4. 测试补齐：WS 集成 9 场景（含 Test5 双接受 3H、GATHER 超时回退、离线接受）；双浏览器 E2E 实测
   接受邀请后双方自动进局。

## 4 修改文件列表
- frontend/src/styles/global.css（tokens + ds-* + hero/lobby/mm/落子动画）
- frontend/src/ui.tsx（新增原语组件）
- frontend/src/platform/Platform.tsx（nav/Landing/Lobby/Auth/Ranking/Friends 重设计 + GameLink 接线 + 门禁调整）
- frontend/src/platform/OnlinePage.tsx（倒计时匹配卡、GameLink 化）
- frontend/src/ws.ts（GameLink/resetSocket）
- backend/src/ws/gameServer.ts（邀请状态机、队列元数据、startInvite 防空转）
- backend/src/api.ts、backend/src/server.ts（invite hooks 三件套）
- backend/tests/ws.integration.ts（+3 场景）、e2e.cjs（双浏览器邀请局）、e2e-local.cjs（不变）
- docs/DesignSystem.md、UI_UPGRADE_AUDIT.md、TEST_REPORT_UI_UPGRADE.md、本报告
- results/ui-screenshots/*.png（浏览器截图存档）

## 5 测试结果
| 项目 | 结果 |
|---|---|
| vitest 单测 | 64/64 ✅ |
| API 集成（真实 HTTP） | ALL PASS ✅ |
| WS 集成（9 场景，含 Test1-5 及附加） | ALL PASS ✅ |
| 平台浏览器 E2E（含双浏览器邀请局） | ALL PASS ✅（console 0 错误） |
| 本地规则回归 E2E | ALL PASS ✅ |
| 布局/溢出探测（Landing/Lobby） | 无溢出 ✅（截图存档） |
| 构建（tsc + vite） | 通过 ✅ |

## 6 已知问题（不隐藏）
- Docker 形态未在本机实跑（本机无 Docker）；compose 已就绪，需在有 Docker 主机验证
- 邀请“多人邀请聚合”以发送者会话窗口（inviteGatherMs）实现；若被邀者长期不处理，
  房间在窗口超时后按 1 人接受回退 2H+AI 或不开房（在线 <2 时）
- 游戏中对局页通过导航离开不会立即弃权（服务端断线检测在 socket close 后按 disconnectSkipMs 跳过）；
  正常出口为「离开」按钮
- 教学完整 3 局自动流转逻辑已实现并经首局交互验证；全流程自动化建议后续补充（非本次范围）
