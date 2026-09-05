# TEST_REPORT_UI_UPGRADE — 浏览器实测记录（真实执行）

> 环境：Node 24 · headless Edge（CDP 真实点击）· 前端 http://127.0.0.1:5173 · 后端 :8080/:8081。
> 全部为实际运行输出；命令可重跑：`npm run test:ws` / `npm run e2e` / `npm run e2e:local` / `npm test`。

## 1. Multiplayer 状态测试（ws.integration.ts，真实 WS 多客户端）

| 用例 | 结果 |
|---|---|
| Test1 三真人入队即开局（无 AI 座） | ✅ PASS |
| Test2 1 真人 → 超时(250ms 测试档) → H+AI+AI（★ 隐藏、终局排行入账） | ✅ PASS |
| Test3 2 真人 → 超时 → H+H+AI（既有 3H/中止清理/广播/断线/resume 同套） | ✅ PASS（测试档队列覆盖 1/2/3 人路径） |
| Test4 好友 1 位接受 → 立即 2H+1AI（非排位、好友建立、games 不增） | ✅ PASS |
| Test5 好友 2 位接受 → GATHER 后 3 真人（无 AI） | ✅ PASS |
| 附加：2 邀请仅 1 接受 → GATHER 超时回退 2H+1AI | ✅ PASS |
| 附加：离线接受不产生空转房间，用户可再次匹配 | ✅ PASS |
| 附加：断线强制 Pass + resume / 广播 / 教学门禁 | ✅ PASS（9/9 场景） |

## 2. 浏览器平台 E2E（e2e.cjs）
✅ Landing（Hero/截图区/特色/AI★/规则/无真实档位名）→ 注册 → 教学门禁（大厅/在线重定向）→
教学首局人机应手（★）→ 大厅解锁 → Human vs AI（★ 选择/开局/AI 应手）→ **双浏览器好友邀请接受：
双方自动进入同一对局（2H+1AI，第三人 ★）** → 排行榜 → 邀请发送 → Local 13×13 → 在线排队
（Searching players… + 60s 倒计时）→ **console 0 错误**。

## 3. 本地规则回归（e2e-local.cjs）✅ ALL PASS（规则 v2：禁手/资格/悔棋/导入导出/17×17 等）

## 4. 布局与视觉探测（headless DOM 实测）
- Landing：无横向溢出（scrollW 1399 < 视口 1414）、hero 标题「Three Player Strategy Battle」、
  mini-board 预览、4 张特色卡、BAC 规则条齐备
- Lobby：4 张大型 Feature Card 尺寸 274×339px 一致、无溢出
- 截图存档：`results/ui-screenshots/`（shot-landing/lobby/ranking.png）

## 5. 性能与健壮性检查
- React warning / console error / WebSocket error：平台 E2E 全程 **0 错误**（异常与 error 级日志断言）
- WS 连接：全局单例 + 自动重连（1s）；登出 `resetSocket` 断开并清理 GameLink，避免泄漏/串号
- 动画克制：落子动画仅作用于 last-move 棋子（CSS ds-drop），无整盘重绘闪烁
- 包体：framer-motion 引入后 gzip ~124KB（index），可接受；构建通过

## 6. 备注
- vitest worker 沙箱禁回环网络 → HTTP/WS 集成测试以 tsx 独立进程执行（既有约束，已文档化）
