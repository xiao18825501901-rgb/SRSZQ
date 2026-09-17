# Codex 交接 · UI 重构 / Online 30秒时钟

## 先阅读

`START_HERE_UI_REFRESH.md`、`docs/ui-refresh/UPDATE_REPORT.md`、`CHANGED_FILES.json`。
本次为直接修改上传项目的交付，不是重建另一个游戏。未修改 shared 的规则与 AI 源码。

## 当前入口

- 标准源码入口仍是 npm workspaces：frontend / backend / shared。
- 新 UI 只加载 `frontend/src/styles/refresh.css`。
- 统一棋盘：`frontend/src/components/Board.tsx`，交叉点显示，内部 row/col 不变。
- 统一对局信息与复盘按钮：`components/MatchPanel.tsx`。
- 页面壳：`platform/Platform.tsx`；在线/好友：`platform/OnlinePage.tsx`；离线/人机/教学：`App.tsx`。
- 首页实谱：`data/heroGame.ts`，27手白棋终局，来自已有 MaxN。
- 后端时钟：`backend/src/ws/gameServer.ts` 的 ensureTurnClock/clearTurnClock + applyAndBroadcast 绝对截止时间校验。
- 排行榜：`db.ranking(limit,offset)`、GET /api/ranking 的 total/offset/limit、前端分页。
- 后端环境：新增可选 SRSZQ_TURN_TIMEOUT_MS（默认30000），SRSZQ_DATA_DIR（默认仍旧数据路径语义）。

## 不能误改的行为

1. R1–5 NONE；R6白、R7绿、R8红；≥4 的非资格动作非法；不改成研究阶段的 R4 BAC。
2. 内部 A/B/C 编号继续用于状态与存储，只有可见文案/棋子变成红绿白。
3. Online 真人30秒；AI沿用有界搜索；好友/离线/人机无30秒限制。
4. 在线复盘绝不暂停服务器时钟，也不覆写房间；本地/人机复盘只暂停 AI 并使用 moves 切片。
5. 原 Online 计分与断线10秒宽限不改，结束出口复用旧 finalizeRoom，避免重复计分。
6. 原始训练数据、规则、AI权重、SQLite用户数据未改。

## 已完成核查与限制

见 backend-integration.json（14/14）、ui-smoke.json（12/12）、page-render-results.json（50张无JS异常）以及 TYPECHECK_RESULTS.txt。
浏览器沙箱禁止直接本地导航，截图由相同前端构建离线渲染、输入隔离测试数据；真实后端使用 Node WebSocket 客户端验证。不要把这描述成公网部署完成或完整跨浏览器认证。
标准 npm 构建在本轮容器未运行。已经提供 `frontend/dist` + `preview-runtime` 可执行预览；不要把这些本地端口硬编码产物直接部署生产。

## 运行

双击 start-ui-preview.bat，或 `node scripts/start-ui-preview.cjs`。Node22.13+/24，启动在 5173/18080/18081。
该预览启动器不触碰云账户，不绑定公网地址，不结束占用端口的其他程序。

## 下一位维护者在用户电脑上的最小检查

使用用户正常 Windows 依赖环境运行标准 build；真实浏览器依次打开注册/登录、大厅、排行、好友、本地、人机、在线30秒超时与重匹配；核对用户生产环境 API/WS 配置。进行部署前沿用现有部署文档，重新检查认证、Origin白名单、WSS与SQLite持久卷。本次并未授权或实施任何云部署或付费操作。
