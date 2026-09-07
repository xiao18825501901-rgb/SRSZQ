# SRSZQ W9 Mobile Matchmaking Fix Report

## 1. STATUS

**READY**

W9 的移动端 Online Match、WebSocket 排队恢复、AI 超时补位、完整回归与浏览器验收均已通过。

## 2. FINAL SHA

W9 功能提交：`652b4ef0827081ab33082e2a55e350c21bc19583`

## 3. Root Cause

### Mobile layout root cause

Online Match 在手机竖屏仍复用了桌面状态栏和完整 `BacTimelinePanel`。W8 只把桌面 BAC 卡片移动到棋盘上方，并把内部行改成横向排列；卡片本身的标题、当前胜权详情、未来八轮和说明文字仍全部存在。棋盘又同时受页面内边距、双栏布局回退和通用高度约束影响，因此视觉上偏小，且出现得太晚。

### Matchmaking timeout root cause

服务端的 60 秒 timer、AI 补位、房间创建和 `game.start` 广播逻辑本身可正常工作。故障位于前端 WebSocket 生命周期：

- 首次进入 Online 页面时，如果 `queue.join` 在 WebSocket 进入 `OPEN` 前发送，旧实现会静默丢弃消息。
- 已收到 `queue.joined` 后，如果 WebSocket 短暂断开，服务端会正确将旧连接移出队列；前端会自动重连，但不会重新发送 `queue.join`。
- 前端仍保留旧的 `queueStartAt`，倒计时继续走到 0，并永久显示“即将匹配完成”，因为服务器此时已没有该用户的有效排队记录。

失败回归测试先稳定复现了首次连接与排队重连后没有重新入队的问题；修复后同一测试转为 PASS。客户端现在记录排队意图，在连接打开或重连时重新发送 `queue.join`；已有对局重连时发送 `resume`。只有服务器返回 `game.start` 才会进入棋局。

## 4. Files Changed

- `frontend/src/components/MobileVictoryTimelineStrip.tsx`
- `frontend/src/components/bacTimelineModel.ts`
- `frontend/src/components/__tests__/bacTimelineModel.test.ts`
- `frontend/src/platform/OnlinePage.tsx`
- `frontend/src/styles/tabletop.css`
- `frontend/src/ws.ts`
- `frontend/src/__tests__/wsReconnect.test.ts`
- `backend/tests/ws.integration.ts`
- `e2e-w9.cjs`
- `package.json`
- `results/w9/online-360x800.png`
- `results/w9/online-390x844.png`
- `results/w9/online-1440x900.png`

未修改 `HowToPlay.tsx`、Tutorial、Auth、Ranking、Friend UI、Local 规则、BAC 游戏规则、AI 权重、Caddy、DNS、Netlify 配置、ICP、数据库或生产密钥。

## 5. Mobile UI Changes

- 新增手机专用 `MobileVictoryTimelineStrip`，桌面继续使用完整 BAC 右侧面板。
- 时间线数据只来自服务器 `qualification` 或共享引擎 fallback，没有复制或硬编码胜权规则。
- 手机条同时显示当前 Round、当前 TURN、当前胜权、下一 Round 胜权、六节点时间线和真人自己的下一次胜权。
- 当前节点、下一节点、无胜权节点和 A/B/C 节点都有文字与颜色双重编码，不依赖 hover。
- 玩家 A/B/C 改为紧凑三列；真人显示用户名与 `YOU`，AI 只显示星级。
- 手机竖屏断点为 `max-width: 700px`。棋盘直接占满页面安全内容宽度，实测为视口宽度的 92.8%–94.7%，保持正方形且无水平滚动。
- 390×844 的 17×17 共享棋盘实测 289 格、宽度 93.8vw、正方形、无水平溢出。

## 6. Matchmaking Fix

`GameLink` 新增服务器连接恢复行为：

- `joinQueue()` 先保存排队意图，即使 socket 尚未打开也不会丢失。
- socket `OPEN` 时，排队态重新发送 `queue.join`。
- 对局态重连发送 `resume`，由服务器恢复房间状态。
- 收到服务器 `game.start` 后清除排队意图。
- 取消排队、重置和换号时清除排队意图并解绑旧 socket handler。

服务端仍是唯一 Source of Truth。生产默认 `queueTimeoutMs` 保持 60,000ms；自动化测试只通过构造参数或本地环境注入 250ms/400ms。

服务端回归验证：

- 1H timeout → 2AI → 同一房间 → `game.start` → 13×13 + BAC payload。
- 2H timeout → 1AI → 两端收到相同 room、seats 与 qualification。
- 3H 在 AI 补位 timeout 前立即开局，无 AI，A/B/C 座位互异。
- W8 的 1H/2H AI 独立难度权重测试继续通过；客户端 payload 不暴露内部 AI 档位名。

## 7. Regression Tests

| Gate | Result |
| --- | --- |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd test` | PASS — 13 files / 133 tests |
| `npm.cmd run test:backend` | PASS — 12 API scenarios |
| `npm.cmd run test:ws` | PASS — 18 WS scenarios |
| `npm.cmd run build` | PASS — 466 modules transformed |
| `npm.cmd run e2e:local` | PASS |
| `npm.cmd run e2e` | PASS |
| `npm.cmd run e2e:w9` | PASS |

`e2e:w9` 自动断言了 1H 400ms AI 补位进入真实棋盘、移动端宽度/顺序/间距/无横向溢出、合法格 hitbox、服务器状态推动时间线从 R1 更新到 R2、17×17 响应式，以及三个桌面尺寸的 BAC 侧栏。

## 8. Screenshot / Visual QA

| Viewport | Evidence |
| --- | --- |
| 360×800 | Board 94.4vw；timeline → 6px gap → board；完整棋盘可见；无横向溢出。截图：`results/w9/online-360x800.png` |
| 390×844 | Board 92.8vw；timeline 和紧凑三座位条可读；完整棋盘可见；无横向溢出。截图：`results/w9/online-390x844.png` |
| 1440×900 | Board 570px；完整 BAC Victory Timeline 保持右侧布局；无横向溢出。截图：`results/w9/online-1440x900.png` |

额外自动验收：375×812、393×873、412×915、430×932、1366×768、1920×1080。全部 PASS，浏览器 JavaScript 异常数为 0。

## 9. Risks

- 线上反向代理和网络抖动未被修改；客户端现在会在底层 WebSocket 重连后重新向服务器声明排队或恢复房间，降低这类外部断线造成的状态漂移。
- 手机专用信息层只作用于 700px 以下竖屏；桌面和大屏平板继续使用现有完整 BAC 展示。
- 自动化用户与数据库均位于本地受控环境，没有修改生产数据。

## 10. Production Deployment

**AUTO DEPLOY OBSERVED**

Codex 未触发 Netlify Deploy、PM2 restart、Caddy、DNS 或数据库操作。`652b4ef` 推送后，现有 Netlify Git 自动发布已完成：`https://srszq.com/` 返回 HTTP 200，生产 HTML 引用的 CSS 含 `.mobile-victory-strip`，生产 JavaScript 含 `Mobile Victory Timeline` 与重连恢复逻辑。未额外触发第二次部署。

## 11. Rollback SHA

W9 修改前 `main`：`3ef080fa1b744f642f2a52cffb36dd81fe681945`

如需回滚 W9 功能提交，可对 `652b4ef0827081ab33082e2a55e350c21bc19583` 执行标准 revert；无需回滚或迁移数据库。
