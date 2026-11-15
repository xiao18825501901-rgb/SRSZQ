# SRSZQ 四模式统一布局与局内趣味聊天交付报告

## 交付结论

- 工作区：`E:\SRSZQ\01_CurrentProject\srszq-fourmode-matchchat-20261114-2236\srszq-bilingual-product-20261030`
- 功能分支：`feature/four-mode-match-chat-20261114`
- 原始基线：`fa6a15c5baca8472fd2f096049c9829a32fc3251`
- 首次实现提交：`5cc0c17ab447a1e842cff1029e2c10cd5381dd75`
- 本轮最终自动化验证的已提交基线：`5a2f5e852296f5e517d2062beabbc85cd14f2bae`
- 最终交付提交：以交付包根目录 `COMMIT.txt` 和 Git 分支 HEAD 为准
- WebSocket 协议版本：`2`
- 共享比赛布局：`SharedMatchLayout v1`，四种模式均通过同一个组件接入原 Board
- 最终状态：代码、自动化测试、生产构建、真实本地全栈浏览器联调均已通过

本轮没有发布生产、没有修改生产数据库、没有更换棋规、没有覆盖旧交付包。

## 已实现

### 四模式统一布局

`SharedMatchLayout` 统一承载以下四个产品入口：

- 人机对战：`vsai`
- 本地对局：`local`
- 在线匹配：`online`
- 好友邀请：`invite`

组件只负责布局，不接管棋规。四个入口继续使用原真实 Board、计时、悔棋、设置、日志、重连、结算与复盘流程。

桌面布局为左侧胜权轮次、中间原棋盘、右侧局内聊天。手机布局为胜权横条、棋盘、聊天卡纵排；聊天卡顶部固定三席，历史独立滚动，输入区固定在卡片底部。

胜权规则保持原实现：第 1–5 回合无人拥有胜权，第 6 回合白/C，第 7 回合绿/B，第 8 回合红/A，之后循环。落子席位与胜权是独立字段。

### 局内聊天

- 真人与 AI 共用同一个聊天组件，只通过身份标记区分。
- 12 个 emoji、8 个原创贴纸。
- 支持 AI 台词开关和静音。
- 默认消息上限 280 字符，服务端复用真实限速逻辑。
- 消息先持久化再广播。
- `(roomId, actorId, clientMessageId)` 支持幂等；相同 ID 不同内容返回冲突。
- 顺序游标与 `chat.sync` 支持断线补历史。
- 发言者、座位和 AI 身份绑定认证连接；客户端伪造值不会覆盖权威身份。
- 跨房间同步和举报被拒绝。
- 人工举报进入真实举报队列，可提交，不在客户端自动处罚。
- AI 台词按房间 20 秒冷却、每个 AI 每局最多 6 条，并优先不重复；由权威端消费。
- 本地对局允许选择当前发言席位，但该选择只属于本地 UI，不作为联网身份认证。

### 趣味改写

- 改写仅由服务端调用模型。
- 只发送当前一句话和所选风格，不读取无关目录，不向前端、Vite、日志、截图或 Git 写入密钥。
- 用户先看到预览，可确认、发送原文或取消。
- 继续编辑、切换风格、座位或房间会使迟到结果失效。
- 模型不可用或超时始终回原文，正常聊天和棋局不依赖模型。
- 已在本机 DSH 受控凭据文件 `C:\Users\Hp\.dsh\.credentials.yaml` 的
  `refs.DEEPSEEK_API_KEY` 中找到合法服务端凭据；密钥未写入前端、Vite、Git、
  日志、截图或本报告。
- DeepSeek 模型列表接口返回 HTTP 200，可用模型为 `deepseek-flash` 和
  `deepseek-v4-pro`。最终通过真实本地后端 `POST /api/match-chat/rewrite`
  使用 `deepseek-flash` 完成成功改写：原文“这一手我要认真应对，放马过来！”
  返回“这一招我可得凝神接住，朋友尽管出招吧！”，模式为 `MODEL_REWRITE`。
- 首次探针遇到供应商有效响应但 `message.content` 不可用，后端正确回退原文并记录
  `ORIGINAL_INVALID_OUTPUT`；失败证据单独保留，未伪造成功。
- 网站 DeepSeek 的可用性与 Reddit 外部 AI 规则无关；Reddit 协作仍只按 OpenAI/Gemini 白名单处理。

### Astra

- 网站保留旧五档历史兼容：4★、5★仍可回放和加载。
- 4★显示品牌名 Terra，使用原混合策略。
- 5★显示品牌名 Sol，使用原混合策略。
- Astra 是单独入口：`level=5, strategy='astra'`。
- Astra 直接调用原 `maxnSearch`，绕过 `selectTactic`、Tactical、Random、Selfish 和 3-Ply 覆盖，并跳过防守策略改写。
- AI controller、worker、主线程回退、座位序列化、座位相等比较均保留 `strategy`。
- MaxN 不等同于穷举完整终局树，也不承诺必胜。Astra 最终证据记录 depth 2、48 nodes；13×13 与 17×17 都走到真实引擎，且无 fallback。

## 真实验收

最终浏览器重跑时间：`2026-11-15T10:44:17.043Z`（Asia/Shanghai 为 `2026-11-15 18:44:17`）

最终完整结果：
`results/fourmode-astra-reacceptance-20261115-184416/BROWSER_ACCEPTANCE.json`

最终截图与执行日志：`results/fourmode-astra-reacceptance-20261115-184416/`

更早的浏览器与测试记录继续保留，用于追踪失败和修复过程；本报告以
`results/fourmode-astra-reacceptance-20261115-184416/BROWSER_ACCEPTANCE.json`
为最终浏览器证据索引。

### 四模式 × 布局

| 模式 | 桌面 1440 | 390×844 | 360×800 |
|---|---|---|---|
| 本地对局 | PASS | PASS | PASS |
| 人机 Astra | PASS | PASS | PASS |
| 在线匹配 | PASS | PASS | PASS |
| 好友邀请 | PASS | PASS | PASS |

所有移动端检查同时确认：

- 使用同一个 `four-mode-shell`
- 三席为三列横排
- 棋盘区域位于聊天区域之前
- 棋盘下方包含局内聊天

### 手机键盘安全视口

`390×420` 短视口专项检查通过：

- textarea 成功聚焦
- composer top `233.15625`
- composer bottom `279.15625`
- composer 完整位于 `390×420` 模拟安全视口内

该结果证明响应式布局和软键盘压缩后的可用高度处理正确，但仍是 Chromium 设备指标模拟，不冒充实体手机上的物理软键盘实机验证。

### 两账号聊天

使用两个独立注册账号、两个独立 Edge 用户配置和真实 HTTP/WebSocket/SQLite 服务：

- Alice 与 Bob 进入同一真实在线房间
- Alice 发送文本，双方均收到
- 12/12 emoji 与 8/8 sticker 目录可见
- emoji 插入输入框成功
- 原创贴纸“放马过来”双方均收到
- 趣味改写请求进入预览；无 DeepSeek 凭据时显示原文回退
- Alice 点击“发送原文”后，双方均收到
- 限速路径在测试中真实触发，等待限制窗口后重试成功

## 自动化验证

本次最终自动化日志位于 `results/fourmode-astra-reacceptance-20261115-184416/`；
产品套件汇总位于 `evidence/product/2026-11-15T10-47-55-069Z/product-report.json`。
更早的完整验收记录继续保留，用于追踪调试过程。

| 检查 | 结果 |
|---|---|
| 根/前端/后端 TypeScript | PASS |
| Vitest | 25 files / 205 tests PASS |
| WebSocket 集成 | ALL PASS |
| Backend API integration | ALL PASS |
| Results settlement | ALL PASS |
| Commands protocol | ALL PASS |
| Security worker | ALL PASS |
| Rating policy | ALL PASS |
| History replay | ALL PASS |
| Puzzle bank | ALL PASS |
| Privacy dataset | ALL PASS |
| AI provider | ALL PASS |
| Ops readiness | ALL PASS |
| Product aggregate | PASS |
| Production frontend build | PASS |

生产构建产物：

- `dist/index.html`
- `dist/assets/ai.worker-BZWtTXR5.js`
- `dist/assets/index-k3QKLgjz.css`
- `dist/assets/index-YayvDy4E.js`

## Astra 真实轨迹

证据：`evidence/fourmode-chat/ASTRA_ENGINE_EVIDENCE.json`

| 棋盘 | 选择 | 落点 | 深度 | 节点 | 引擎耗时 |
|---|---|---|---:|---:|---:|
| 13×13 | Astra pure MaxN | (6,6) | 2 | 48 | 16.01 ms |
| 17×17 | Astra pure MaxN | (8,8) | 2 | 48 | 10.45 ms |

分类为 `REAL_ENGINE_CALL_NOT_A_STRENGTH_RESULT`，不构成棋力或胜率结论。

## 关键源码与指纹

| 文件 | SHA-256 |
|---|---|
| `frontend/src/matchChat/SharedMatchLayout.tsx` | `c68b2ccf1a737a2e35c92b5a84791aec25ae2dbeb66a43a70e1d748f8106ecd8` |
| `frontend/src/matchChat/ChatCard.tsx` | `55e8b1950b165bfb78aa4e39c914050410bc047fa5d69c22c8e3d4a10e480d1c` |
| `frontend/src/styles/matchChat.css` | `81ce6c97770862c5c1a1cf4d9e702b46f236e46fe41aa55d46e83aabad8c6782` |
| `shared/src/product/protocol.ts` | `f82376c488c2aad2f03ae84044cea5735269f4e4d4d4ea39308f5ae11511b1b6` |
| `shared/src/ai/chooseAIMove.ts` | `5ffce87942719aa6ddb81583bfdcbb60a6ee97ae0afa174752e25c491d35b78b` |
| `shared/src/ai/seats.ts` | `6c899b0cdd10355bc21f1d74c1d5af9b0b562fe42c9dd017d90515f0af94dc4d` |
| `shared/src/ai/tests/brandProfiles.test.ts` | `80da8954e047b1cf62bfd83ba5d5f52321cbb8736e5055175cff7cb904e80975` |
| `backend/src/chat.ts` | `20c89c8444a32f2fef9ee345cc962f28fbf4730da3ef53e80693d2221e81a7f6` |
| `backend/src/ws/gameServer.ts` | `2adab04c38f17d0cb316f8cd8cd1c7417cb2e92a8c4f8c49e1bf010012441895` |
| `backend/tests/ws.integration.ts` | `d0040549fbe533e5021efb8737d7415bb23dec4a1b4f7896a4ee8eceedfa5e05` |
| `results/fourmode-astra-reacceptance-20261115-184416/BROWSER_ACCEPTANCE.json` | `4f29495e8b66e7e2be4d8a215ad8872ee671b0e05ce0dd1260eb082e7226c760` |
| `evidence/fourmode-chat/ASTRA_ENGINE_EVIDENCE.json` | `993ed4a9c6dfb48e38754b397c1c47835a65551b095224489250713dd6706bd2` |
| `evidence/product/2026-11-15T10-47-55-069Z/product-report.json` | `9ee411166b3fefd7c71e824e8fb6c014ca26fde439c6b3905be114b1d36974ec` |
| `evidence/fourmode-chat/DEEPSEEK_REAL_CALL.json` | `f642585768e4795c60636c14341ef9ff0ad04a5a42df40ce82b2cc4aeb380afc` |
| `evidence/fourmode-chat/DEEPSEEK_REAL_CALL_ATTEMPT1.json` | `47e0995c09c923fba7d498c7725fc2c5e01c70a0d2bd67012e213d9b16f52c99` |

## 截图

最终目录：`results/fourmode-astra-reacceptance-20261115-184416/`

- 桌面：`01`, `02`, `06`, `07`, `10`, `11`
- 390px 全高：`03`, `12`, `14`, `16`
- 360px 全高：`05`, `13`, `15`, `17`
- 手机压缩视口：`04`
- 表情与贴纸：`18`
- 改写预览回退：`19`
- 两账号聊天：`08`, `09`

移动端全高截图包含胜权、真实棋盘、工具栏和下方聊天卡。

## 迁移与回退

本轮没有新增或清空生产数据库。发布前必须走既有迁移流程，并使用独立测试域验证。

回退顺序：

1. 停止新功能版本的前后端实例。
2. 回退应用部署到上一已验证版本。
3. 聊天消息、举报和 AI 台词均为隔离表数据；应用回退后即使表保留也不会影响旧规则、计时、结算和复盘。
4. 不执行 schema drop，不清空生产库，不重写既有棋局或评分。
5. 如需恢复旧入口，仅切换部署版本；本功能分支不覆盖旧 main。

生产发布不在本次交付自动执行范围。

## 已知限制与未完成项

- DeepSeek 已使用本机受控服务端凭据和 `deepseek-flash` 完成真实改写调用；尚未把该凭据部署到生产服务器。
- 手机键盘是 Chromium 设备指标和短视口模拟，需要发布前在目标手机浏览器再做一次实体软键盘验收。
- Astra 已做真实引擎调用轨迹，但没有新的独立棋力评估，不能据此宣称达到某星级或战胜强基线。
- 在线 Astra 服务端补位仍沿用现有联网 AI 兼容路径；本轮 Astra 产品入口主要覆盖人机对战。
- 新增的独立 Edge CDP 诊断脚本在本机隔离用户配置启动时未稳定建立调试端口；该失败未用于验收。最终四模式验收使用项目既有真实全栈 Chromium/Edge 验收器完成。
- 未发布生产、未改 DNS/云平台、未替用户 Submit。
