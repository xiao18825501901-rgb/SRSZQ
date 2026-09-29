# DEPLOYMENT RECORD — 2026-09-30（P0A + P0B 上线）

## 结论

**已上线生产。** 前端与后端同版本部署完成，公网端到端验收全部通过。

| 项 | 值 |
|---|---|
| releaseId | `p0b-20260930` |
| 生产提交 | `d9dddd32fa755c9a7d475ab893f79ac6a44db3d4` |
| 回滚点 | `cf5bff8eeb3ceec5b854a031af0b3aceb6ca8444` |
| 前端 | Netlify 站点 srszq (`8ba9ce96-b7ec-409a-965c-10d6e2335bf2`)，deploy `6abc06de7ea30700088c6ee4` state=ready，bundle `index-DbNJIK_F.js` |
| 后端 | `api.srszq.com` @ `8.210.58.22`，PM2 `srszq-backend`，`/var/www/SRSZQ` |
| 回滚依赖备份 | `/var/backups/srszq/release-20260929T185034Z-gWDTEY` |
| 上线前独立数据库备份 | `/home/admin/srszq-predeploy-backups/p0b-20260929T184544Z.sqlite`（integrity_check=ok，172 用户 / 42 局） |

## 上线时段的真实状态

- 生产库与 WAL 最后写入为 9/26–9/27，PM2 日志无近期输出 → **无进行中对局**，满足“不要在活跃对局中发布”。
- PM2 进程此前已运行 11 天。

## 公网验收（真实域名，非本机）

```
GET https://api.srszq.com/api/version
 -> {"protocolVersion":2,"rulesetVersion":"formal-rules-v2","releaseId":"p0b-20260930"}
GET https://api.srszq.com/api/config/features
 -> {"flags":{"ratingBeta":false,"invitusShadow":false}, "evidence":[... isDefault:true ...]}
wss://api.srszq.com/ws?protocol=2&ruleset=formal-rules-v2
 -> 连接成功；hello.protocol.protocolVersion=2
 -> 真实匹配 game.start（1H+2AI，revision=0）
 -> 真实 move(commandId, expectedRevision=2) -> ack{revision:3, seq:3}
 -> 重发同一 commandId -> ack 回放，revision/seq 不推进（幂等）
 -> expectedRevision=999 -> command.rejected{code:STALE_REVISION}
```

## 本次修复的两个环境/脚本缺陷（否则无法发布）

1. **`scripts/deploy-production.sh` 的发布门禁会拒绝任何 release。**
   它用通用 `data/` 名字做黑名单，而 `frontend/src/data/heroGame.ts` 是第一方源码
   （`.gitignore` 明确写了 `!frontend/src/data/`，见提交 `25fc09e`）。
   结果是 `previous` 与 `target` 两个 revision 都命中门禁，脚本直接 exit 1 ——
   连它上一次成功部署的 `cf5bff8` 也会被拒。
   修复：先排除 `frontend/src/data/`，再套用运行期/密钥规则。

2. **`/var/backups/srszq` 属主是 root:root 755，部署用户 admin 无法写入。**
   脚本在 `mktemp -d /var/backups/srszq/release-...` 处以
   `Permission denied` 失败（发生在 `pm2 stop` **之前**，所以生产未被触碰）。
   修复：`sudo chown admin:admin /var/backups/srszq`。

## 发布顺序（为什么前端先、后端后）

先让 Netlify 构建并上线新前端，再切换后端。理由：

- 新前端 + 旧后端：旧后端忽略 `protocol`/`commandId`/`expectedRevision`，前端有
  `myOutcome` 为空时的回退分支 → **可用**（降级但不报错）。
- 旧前端 + 新后端：旧前端不带信封 → `BAD_ENVELOPE` → **用户被锁死**。

因此必须前端先就绪。

## DEMO 账号

公网验收创建了明确标注的合成账号（用户名前缀 `dshp0b`）。项目原有做法是保留 QA 账号作为证据
（见 `PRODUCTION_OPERATIONS.md`："The QA account remains in the database for evidence"）。
未删除，也未用于任何真人统计。

---

## 第二次发布：P0C（B2）— 2026-09-30

| 项 | 值 |
|---|---|
| releaseId | `p0c-20260930` |
| 生产提交 | `ef175ed81a165209b9fd7fb78f804edcb5e68b90`（含 `7d349d9` P0C + `ef175ed` smoke 修复） |
| 回滚点 | `d9dddd32fa755c9a7d475ab893f79ac6a44db3d4` |
| 回滚依赖 | `/var/backups/srszq/release-20260929T191047Z-yYShfh` |
| 上线前独立备份 | `/home/admin/srszq-predeploy-backups/p0c-20260929T190536Z.sqlite`（integrity ok，175 用户 / 44 局） |
| 前端 | 无改动（B2 纯后端），Netlify 重建结果相同 |

### 第一次尝试失败并自动回滚（值得记录）

`scripts/deploy-production.sh` 的 smoke 门禁连 `ws://127.0.0.1:8081/ws`（无 token），
期望「先握手成功、再收到 error=unauthorized」。P0C 把未认证拒绝提前到 **HTTP 层 401**
（更安全：不给未授权来源分配任何连接资源），`ws` 客户端于是抛 `abortHandshake`，
**未捕获异常让 smoke 退出非零 -> 触发部署回滚**。

生产未受损：回滚把源码与依赖都还原，数据库从未被恢复或改写。

修复方式：改 smoke 而不是改回产品行为 —— 两种拒绝形态都算通过（业务断言不变：
「未认证客户端拿不到可用连接」），401 分支额外断言状态码确为 401。
修复后先在**旧后端**上验证兼容分支通过，才重新部署。

### 上线后观测

- `ai_pool_warmed: 1/1` —— AI worker 线程在 PM2 下正常启动（这是 P0C 的关键前提）。
- 公网 21 项端到端全部通过，含未认证 401、伪造 Origin 403、命令信封、ACK、幂等重放、STALE_REVISION。
- 实测改善：主线程事件循环阻塞从 125–195ms 降到 15.1ms（仅调度噪声）。

---

## 第三次发布：P1（B3）— 2026-09-30

| 项 | 值 |
|---|---|
| releaseId | `p1-20260930` |
| 生产提交 | `b93413962d6b08144657973e4f40f53f4e6b3ae6` |
| 回滚点 | `ef175ed81a165209b9fd7fb78f804edcb5e68b90`（首次）/ `40f2a1a`（releaseId 升级前） |
| 回滚依赖 | `/var/backups/srszq/release-20260929T201737Z-VJRA6l` |
| 上线前独立备份 | `/home/admin/srszq-predeploy-backups/p1-20260929T201245Z.sqlite`（integrity ok，177 用户 / 46 局） |
| 前端 | 无源码改动 |

### 行为变更（规格强制，且影响真实用户）

**AI 补位的在线局不再改真人竞技分。**

规格 01 第 4.1 节「快速人机/好友/教学/本地不改真人竞技分」、第 55 行「快速对局标
不计真人排位」、第 142 行「新赛季 beta 仅 3 真人 eligible」。此前实现是
`isRanked = (mode === 'online')`，所以 1H+2AI 会给真人 +30/-10 —— 既违反规格，
也允许对着 AI 刷分。

上线后公网实测（`scripts/dev/public-rating-check.mjs`）：
```
注册 DEMO -> 读 /api/me = 1200
打一局 1H+2AI 并退出 -> 终局 reason=PLAYER_FORFEIT
再读 /api/me = 1200          <- 分数未变
广播 participants 分差 = [0,0,0]
```

注意：这会让排行榜在低并发时段基本不动（大多数局是 AI 补位）。这是规格设计
（第 56 行：新排位按观测数据开放固定测试时段），不是故障。快速对局仍可玩，
只是不再产生竞技分后果。

### 同时修掉的 P0C 遗留缺陷

1. `warmup()` 被自己的 `hardTimeoutMs` 约束 -> 冷启动必然超时，预热等于没有。
   改为独立 `warmupTimeoutMs`（默认 15s）。
2. 硬超时杀线程后新 worker 是冷的，立刻接业务流量会再次超时 -> 活锁。
   改为「冷槽位只跑预热探针，热了才接业务」。
   （修第 2 条时我自己又引入过一次**无限预热循环**：`slot.warm` 未置位导致每次
   `pump()` 重派探针、真实任务永远排队。用隔离脚本定位并修复。）

### 上线后观测

- 五个 smoke 门禁全过：API / WS(401 before upgrade) / PM2 / DB quick_check / NGINX。
- `releaseId: p1-20260930`，生产可自证版本。
- `/api/version` 与 `game.start` 报告的 releaseId 一致。

## 未做的事

- 未改 DNS、未改域名、未改仓库可见性。
- 未开启评分 Beta、未晋级 Invitus、未开 shadow（实测均为 OFF 且为默认值）。
- 未迁移/覆盖生产数据库；只做了在线备份。
- 未删除任何生产数据。

---

## P2 上线（B4 第一批：历史 / 全谱重放 / 关键三手 / 跨轮防守 / 分享）

| 项 | 值 |
|---|---|
| releaseId | `p2-20260930` |
| 生产提交 | `84db1fcbe62699fe1b6730dfb6eb5060ef397ee0` |
| 回滚点（上一提交） | `b934139` |
| 回滚依赖 + 上线前库备份 | `/var/backups/srszq/release-20260929T204444Z-mG0hqF`（含切换前的 node_modules 与 `srszq-daily-2026-09-29T20-44-44-130Z-…sqlite`） |
| 服务端校验树（独立重跑 npm ci + 全部测试 + build + audit） | `/var/tmp/srszq-release-zFWGUd` |
| 前端 | 源码未变（Netlify 从 main 重建，页面行为不变） |

### 本次上线的能力

R01 历史与分页、R02 全谱重放与分支隔离、R03 关键三手解释、R04 跨轮防守窗口、
R05 多个已证明答案、R06 去标识分享与撤销（7 天 TTL）。分析只在终局后允许，且只给精确一步事实。

新增数据表：`share_links`（撤销写 `revoked_at` 保留审计行，不删行）、
`live_games`（进行中对局的座位归属，终局即删 —— 没有它，API 无法区分“不是你的”和“还没结束”）。

新增接口：`GET /api/history`、`GET /api/games/:id/replay`、
`POST|GET /api/games/:id/share`、`DELETE /api/share/:token`、`GET /api/shared/:token`。
公开视图未认证却要跑一遍重放，因此按来源限流（超限 429 RATE_LIMITED）。

### 公网验收（真实域名，`scripts/dev/public-replay-check.mjs`，40 项断言全过）

```
release=p2-20260930
3 真人 online 20 手脚本对局
  -> keyMoves IMMEDIATE_WIN@20/B(6,4) · MISSED_WIN@18/C(2,2) · PREEMPTIVE_BLOCK@16/A(0,0)
  -> finalHash=be6f08fd0d1950c1c6dfab4c9a0c199a（与本机同一脚本对局算出的摘要完全一致）
  -> hashMatches=true replayOk=true errors=[]
  -> 公开分享不含 gameId / 用户 id / 用户名 / 邮箱；撤销后 410 revoked
  -> ratingDeltas=[30,-10,-10]（beta 关闭时按 legacy 结算）
PUBLIC REPLAY CHECK: ALL PASS 0
```

原始日志：`SRSZQ_Productization_Deliveries/P2_20260930/evidence/public-replay-check.log`（退出码 0）。

### 上线后生产库实况（只读核对，未做任何迁移）

```
users=185 games=50 matches=50 match_results=8 rating_ledger=10 game_events=50 share_links=2 live_games=0
pragma integrity_check -> ok
/api/config/features -> ratingBeta=false(isDefault) invitusShadow=false(isDefault)
```

### 本批次仍然没碰的东西

- 未改 DNS、未改域名、未改仓库可见性。
- 未开启评分 Beta、未晋级 Invitus、未开 shadow（实测都是默认关闭）。
- 未迁移/覆盖生产库；上线前由发布脚本自动做了一次库备份。
- 未删除任何生产数据。`match_results` 只统计 P0A 建表之后结算的局，早期对局完整保存在 `games`/`matches`（50 局）里。
- R07 题库、R08 每日题/错题、R09 前端界面、R10 真实浏览器截图仍未完成，见交付包 `NEXT_ACTION.md`。

### 补充发布 `020e60f`（测试运行器修复；运行时行为不变）

| 项 | 值 |
|---|---|
| 生产提交 | `020e60f972a43d04814e684f9ce1c591bea2a2b5` |
| 回滚点（上一提交） | `84db1fcbe62699fe1b6730dfb6eb5060ef397ee0` |
| 发布脚本结论 | `RELEASE PASS: 020e60f972a43d04814e684f9ce1c591bea2a2b5` |
| 回滚依赖 + 上线前库备份 | `/var/backups/srszq/release-20260929T205847Z-AY5Jmw` |
| 服务端校验树 | `/var/tmp/srszq-release-LllUZ9` |

为什么为一个“测试脚本的修复”再发一次：`scripts/product/run-tests.mjs` 曾把可执行套件的键写死成四个，
新增的 `replay` 套件既不进 tsx 分支也不进 baseline 分支 —— 一步没跑却被记成 PASS，`--all` 的 overall 也跟着变成 PASS。
它不影响运行时行为，但会让**之后每一批次的回归证据失真**，因此先修掉、并把生产与 main 对齐，再继续 B4 第二批。
修复内容：执行方式改为按 `runner`/`entry` 数据驱动；未知执行方式直接 FAIL；`steps.length === 0` 拒绝判 PASS。

补充发布后重跑公网验收（同一脚本、新的 DEMO 账号与新的对局，与上一次完全独立）：

```
PUBLIC REPLAY CHECK: ALL PASS 0（退出码 0）
finalHash=be6f08fd0d1950c1c6dfab4c9a0c199a   <- 与上一次公网验收、以及本机同一脚本对局逐位一致
keyMoves=IMMEDIATE_WIN@20 · MISSED_WIN@18 · PREEMPTIVE_BLOCK@16
ratingDeltas=[-10,30,-10]
```

---

## P2b 上线（B4 第二批：题库 V1 / 每日题 / 错题本）

| 项 | 值 |
|---|---|
| releaseId | `p2b-20260930` |
| 生产提交 | `13a6b478ab17c3220f87c4e783e9e61c57d9ceee` |
| 回滚点（上一提交） | `2c66ad2b8b59806abf40a873509ddd99e1fad911` |
| 发布脚本结论 | `RELEASE PASS: 13a6b478ab17c3220f87c4e783e9e61c57d9ceee` |
| 回滚依赖 + 上线前库备份 | `/var/backups/srszq/release-20260929T211436Z-zLbB0R` |
| 服务端校验树 | `/var/tmp/srszq-release-9E7XVx`（npm ci + typecheck + 单测 + API + WS + build + npm audit） |
| 上线后的测试修正 | `415ec4bc`（只改测试与开发脚本，运行时行为不变；生产仍运行 13a6b47） |

### 本次上线的能力

R07 题库 V1：60 道已发布题，四类各 15 道（当前胜点 / 跨轮唯一威胁 / 跨轮多威胁 / 禁手防守冲突，
其中 12 道是真冲突）。题目全部来自**合法完整轨迹**：生产库只读导出的 3 局 3 真人 20 手真实对局，
加上 22 条固定种子自对弈轨迹；每条轨迹都能用真实 `applyMove` 完整重放。
即时胜利题枚举全部合法致胜点（15 道里 13 道有多个答案）。

R08 每日题与错题：`puzzle_attempts`（`(user_id, attempt_id)` 唯一）与 `puzzle_progress` 两张新表；
`GET /api/puzzles/daily|progress`、`GET /api/puzzles/:id`、`POST /api/puzzles/:id/attempt`。
attemptId 幂等（重发回放同一结论且不重复计数，换答案 409 且不改动历史）；答对或第 3 次尝试后
才下发完整答案集与解析；只有 `status=PUBLISHED` 的题进入索引。

### 公网验收（真实域名，两个脚本都对生产跑）

```
release=p2b-20260930

A) 题库（scripts/dev/public-puzzle-check.mts）PUBLIC PUZZLE CHECK: ALL PASS 0
   线上今日题目 == 本仓库确定性算出的同一题（selfplay-13-forbidden-s163:ply45:preempt-B）
   线上起始局面 44 手逐手与本地一致；线上题库总数 60 与本地一致
   合法非答案 -> INCORRECT；同一 attemptId 重发 -> duplicate 且次数不变
   同一 attemptId 换答案 -> 409，且冲突后再重发结论与次数均未变
   答案点 -> CORRECT，下发完整答案集（8 个）与解析 PUZZLE_PREEMPT_ONE_OF
   进度：solved=1 failed=0 totalAttempts=2 firstSolvedAt 已落库

B) P2 功能回归（scripts/dev/public-replay-check.mjs）PUBLIC REPLAY CHECK: ALL PASS 0
   3 真人 20 手脚本对局；finalHash=be6f08fd0d1950c1c6dfab4c9a0c199a（与 P2 上线时逐位一致）
   keyMoves=IMMEDIATE_WIN@20 · MISSED_WIN@18 · PREEMPTIVE_BLOCK@16；ratingDeltas=[-10,-10,30]
```

原始日志：`SRSZQ_Productization_Deliveries/P2B_20260930/public-puzzle-check.log`（退出码 0）与
`public-replay-check.log`（退出码 0）。

### 上线后生产库只读核对（未做任何迁移）

```
users=193 games=52 matches=52 match_results=10 rating_ledger=16 game_events=90
share_links=4 live_games=0 puzzle_attempts=4 puzzle_progress=2
pragma integrity_check -> ok
/api/config/features -> ratingBeta=false(isDefault) invitusShadow=false(isDefault)
```

### 本轮自己修掉的缺陷（写在这里，因为其中两条是产品缺陷）

1. `isLegalMove(state,row,col)` 是三参数，抽题代码按对象调用（`isLegalMove(before, c)`）导致所有
   需要合法性判断的分支恒为假：产生 294 个假的“无合法防守点”，规格要求的三类里少了两类。
   根因是写完模块没先跑 typecheck 就生成产物。
2. 选取用 `slice(0,target)` 会静默丢弃合法题目，且排序按类型名导致“跨轮提前防守”整类落选；
   改为按类型轮转 + 未收录明确标 PENDING 并计数。
3. “禁手防守冲突”不是自对弈随机能走出的形态（首轮真冲突题 0 道）；新增 forbidden-builder
   定向策略后才产出 12 道 —— 换的是生成策略，不是判定标准。
4. 测试用例自身的偶发误判：断言冲突时写死坐标 (0,0)，与首次尝试重复，于是把正确的重发处理
   判成失败（公网验收 24/25 就是它）。已修，并补“冲突不得改动历史”的断言。

### 本批次仍然没碰的东西

- 未改 DNS、未改域名、未改仓库可见性。
- 未开启评分 Beta、未晋级 Invitus、未开 shadow（实测都是默认关闭）。
- 未迁移/覆盖生产库；发布脚本自动做了一次在线库备份。
- 未删除任何生产数据。
- R09 前端界面、R10 真实浏览器截图（仍是 0 张）、B7 容量与备份恢复演练仍未完成。

---

## P2c 上线（B4 第三批：前端界面 + 真实浏览器截图）

| 项 | 值 |
|---|---|
| releaseId | `p2b-20260930`（本批未改协议常量，前端与修复提交随同一 releaseId 上线） |
| 前端提交 | `3bcd56a`（Netlify 从 main 重建，bundle `index-CCBH3sJn.js`，站点自证可见新路由） |
| 后端提交 | `3cfd801d3fc800c885bf0358bba353f674e4a20f` |
| 发布脚本结论 | `RELEASE PASS: 3cfd801d3fc800c885bf0358bba353f674e4a20f` |
| 回滚点 | `547dd1cdcd5af130071a85c324d30f8132ea0d6e` |
| 回滚依赖 + 上线前库备份 | `/var/backups/srszq/release-20260929T214007Z-isCHML` |
| 服务端校验树 | `/var/tmp/srszq-release-JjnFSI` |

### 本次上线的能力

R09：历史列表与复盘详情（棋盘按同一份 shared 引擎逐手重建、时间线可拖动并标出关键手、
关键片段与跨轮威胁窗口、生成/撤销分享链接）、每日一题（点空点落子、服务端判题、答对或第 3 次给完整答案）、
错题重练与进度、`#/s/<token>` 去标识只读分享页；手机端「时间线在上、棋盘居中、操作在下」。

R10：真实浏览器（Edge/Chromium 无头 + CDP）访问生产域名的截图，桌面 1440×900 与手机 390×844 共 6 张，
尺寸由 PNG IHDR 读出校验。

### 公网验收（真实浏览器，34 项断言全过）

```
BROWSER UI CHECK: ALL PASS 0（退出码 0）
手机端几何：时间线 top=279 < 棋盘 top=584 < 操作区 top=1042；棋盘中心 195 = 视口中心 195；scrollWidth=390
渲染密度：169 个交叉点、44 个棋子、2 个面板、347 字符文本（防空白页也算通过）
白棋：填充 radial-gradient 含 rgb(255,255,255)、描边 rgb(183,172,153)，与红/绿填充不同
分享页：3 个座位、不泄露邮箱与 token、DEMO 徽标已亮、撤销后显示"链接已不可用"且接口 410
release=p2b-20260930（/api/version 与页面一致）
```

原始日志与截图：`SRSZQ_Productization_Deliveries/P2C_20260930/`。

### 生产库变更（本轮唯一一次写操作，已如实记录）

把此前为验证而注册的 30 个 `dsh*` 账号标记为 `source='TEST'`（它们本就不是真人）。
随后新增注册期规则，使这类账号**自动**归为 TEST，不再依赖谁记得改库：
`example.invalid` 等 RFC 2606 保留域或命中 `SRSZQ_TEST_ACCOUNT_PATTERN`（默认 `^dsh`）的账号 → TEST，其余 → HUMAN。
没有删除任何数据；`pragma integrity_check` 仍为 ok。

### 本轮修掉的缺陷

1. security 套件 G6 假失败：测试假设 AI 会自己走第一步，但真人拿 A 座时服务器本来就该等真人落子；
   空闲机器上连跑三次得到 0/0/2 步。修后连跑 4 次全过，g6_mySeat 覆盖 A/B/C。
2. 账号来源规则缺失（真实缺口）：DEMO 徽标该亮却没亮，因为自动注册的账号默认 HUMAN。
3. 浏览器脚本四处时序/顺序缺陷（含"等空态"这一次）。

### 说明：截图未经肉眼检查

当前模型不支持图片输入，因此我没有看过这些截图。已做的是程序化校验（PNG 结构与尺寸、渲染密度、
真实几何、配色差异、控制台无异常）。人工目视复核仍需由人完成。

---

## P3A 上线（B5：训练许可 / 数据集 / 事件表 / 导出删除 / 举报屏蔽审计）

| 项 | 值 |
|---|---|
| releaseId | `p3a-20260930` |
| 生产提交 | `780502d1370243c96958b0efa7ea0bcb31faccdc` |
| 发布脚本结论 | `RELEASE PASS: 780502d1370243c96958b0efa7ea0bcb31faccdc` |
| 回滚点 | `3d6db90fdc23f01f8fa9401fe7f74c857ee0af0e` |
| 回滚依赖 + 上线前库备份 | `/var/backups/srszq/release-20260929T215840Z-VNIzBe` |
| 服务端校验树 | `/var/tmp/srszq-release-RKuuG3` |
| 后续测试修正提交 | `881cf2cc`（只改公网验收脚本，运行时行为不变） |

### 本次上线的能力

新增表：`user_consents`、`product_events`、`dataset_runs`、`data_tasks`、`reports`、`blocks`、`admin_audit`；
新增列：`users.role`（受控授予）、`users.deleted_at`。

- **训练许可**：默认不纳入；无记录/版本不符/已撤回都判定为不允许；一局里只要有一位参与者未授权整局不纳入；
  撤回只阻止新纳入并保留原版本以便审计；接口文案明确写“无法要求已训练模型遗忘”。
- **数据集**：先按整盘（gameId）分 train/dev/test；空间 8 对称取最小 stateDigest 作规范键；
  互为镜像的轨迹只留一份；对称 state 聚类防泄漏；`test` 显式标记不用于选权重；**绝不置换红绿白**。
- **运行登记（D04）**：相同 seed 区间 + 配置 + 轨迹哈希的阶段重跑不算新增独立样本。
- **事件表**：eventId 去重；`source/is_bot/is_sample` 标签；真人口径默认排除 bot 与合成；
  对局事实只由服务器写（`match_start`/`match_finish`），客户端只能上报白名单内 UI 事件。
- **导出与删除**：导出为任务形态（`data_tasks`），不含密码哈希/盐/令牌；
  删除需显式确认，执行后名次行去标识、分享全部撤销、会话清理，**不删除对局本身**（他人合法记录保留）。
- **举报/屏蔽/审计**：举报只登记进人工队列并明确不做自动封禁；屏蔽为用户主动操作；全部写 `admin_audit`；
  管理端要求 `ADMIN` 角色（普通账号 403）。

### 公网验收（真实域名，36 项断言全过）

```
release=p3a-20260930
PUBLIC PRIVACY CHECK: ALL PASS 0（退出码 0）

许可：新账号无记录 -> 默认不允许；授予后允许；撤回后 REVOKED 且仍保留原版本；
      撤回后果说明含“无法要求已训练模型遗忘”
事件：白名单 UI 事件可写；同一 eventId 重发 duplicate=true；客户端伪造 match_finish 400；未登录 401
门禁：普通账号访问数据集/审计接口 403
举报：登记为 PENDING 且返回“不会依据举报自动封禁”；举报自己 400
屏蔽：屏蔽生效、解除生效
导出：任务 DONE；导出物是本人数据（1 局）；不含 password_hash/salt/token
删除：缺确认 400；执行后名次行去标识 1 行、撤销分享 1 条、旧 token 401、公开分享 410；
      **同一局对其他参与者仍可读（200）**，其历史记录不受影响
```

原始日志：`SRSZQ_Productization_Deliveries/P3A_20260930/public-privacy-check.log`。

### 生产库写操作说明

本次删除流程针对的是验证用的 DEMO 账号（`dshpv*`，注册即自动归为 TEST）：它按产品流程真的执行了
“删除账号”，即在生产库上把该账号的名次行去标识、撤销其分享、清理其会话。
这不是清理用户数据，而是**验证删除流程本身**；对局与其参与者记录均未删除。

### 本轮修掉的缺陷

1. 公网验收脚本用 `users[0]` 当“他人”，而它往往就是获胜者本人：举报自己得 400、删除后用已删账号 token 读得 401，
   5 项失败全部来自这一处假设（产品行为本身正确）。修复后 36 项全过。

### 仍然没碰的东西

- 未改 DNS / 域名 / 仓库可见性；未开启评分 Beta / Invitus；未删除任何用户数据（DEMO 账号的删除是流程验证）。
- 未做：D07/D08 续训声明与模型卡、O02 留存口径、O05 备份恢复演练、O07 容量实测（B6/B7）。

---

## P3B 上线（B6：provider 接口 / 续训声明校验 / CPU 评测矩阵与模型卡）

| 项 | 值 |
|---|---|
| releaseId | `p3b-20260930` |
| 生产提交 | `69ed609d08360ceb2fad3cf2462fc303cca9f8fb` |
| 发布脚本结论 | `RELEASE PASS: 69ed609d08360ceb2fad3cf2462fc303cca9f8fb` |
| 回滚点 | `95d87c660b5bf21603adbfe501e1dd6a061fe56d` |
| 回滚依赖 + 上线前库备份 | `/var/backups/srszq/release-20260929T222017Z-f4KXGu` |
| 服务端校验树 | `/var/tmp/srszq-release-nLffdY` |

### research/invitus：只读检查结论

远端存在 `refs/heads/research/invitus`（`696c5d9`，比 main 多 78 个提交，含 `research/invitus/` 下
5K 评测、校准、架构、GPU 迁移等报告，以及冻结的 `INVICTUS_ACCEPTANCE_CRITERIA.md`）。
本次只 `fetch` 到 remote-tracking 引用做只读查看：**未合并、未改写、未检出**，其文件不在工作区里，
其验收标准被用作本批次的评测门槛口径（100k 训练量、17 路 ≥ 30%、三座覆盖、无 illegal move、
校准 ECE/Brier、搜索 scaling、原项目回归）。

### 本次上线的能力

- 统一 `DecisionProvider` / `AnalysisProvider`：五档现有 AI 是默认且唯一落子的生产 provider；
  shadow 适配器（Invitus 形态）在权重/元数据不全时**拒绝运行**并列出缺失项；
  `resolveProvider`/`resolveMove` 让“shadow 不得影响对局”成为类型约束（落子只可能来自 mover）。
- `validateResumeClaim`：EXACT_RESUME 需 12 个字段齐全（权重/RNG/优化器/步数/局数/seed 区间/
  引擎与规则版本/configHash/trajectoryHash/budget），缺一即拒绝；WEIGHTS_ONLY_LOAD 通过但必须列出
  “没有恢复什么”；不存在静默升级。
- 研究协议门槛判定（READY/PARTIAL/BLOCKED）与评测矩阵聚合（按棋盘 × 对手族 × 档位 × 座位分层，
  含延迟分位、合法性、崩溃、拒绝；校准如实标 NOT_AVAILABLE）。
- `scripts/product/ai-eval-matrix.mts` + `docs/MODEL_CARD_20260930.md`。

### 一个实测出来的可复现性结论（写进代码，不是写进注释）

现有引擎用**墙钟时间预算**控制搜索，没有节点预算旋钮。实测：预算一旦成为约束，同一 seed 会因为
运行时冷热/JIT 走出**不同的棋**（同样 20ms，重负载后能搜更深）；预算给足时同种子逐手完全一致。
因此评测用 `DETERMINISTIC_SEARCH_BUDGET = { timeBudgetMs: 3000, maxDepth: 3 }`，
并把“单次决策耗时 / 预算”的**预算压力**记录下来；超过 50% 即声明可复现性不成立。
这是相对规格 6.3“固定节点预算”的已知差距，已写入模型卡。

实测矩阵（30 局 / 906 次决策）：`illegal=0 crashes=0 legalityRate=1`，同种子重跑 IDENTICAL，
预算压力 17%；门禁判定 `PARTIAL`（训练量 0、未报告校准）——如实反映没有训练。

### 公网验收（真实域名，三个脚本全过）

```
release=p3b-20260930
A) scripts/dev/public-provider-check.mts   -> PUBLIC PROVIDER CHECK: ALL PASS 0
   invitusShadow=false 且 isDefault=true、rawValue=null（可外部复核：从未被打开过）
   线上 1H+2AI 局：AI 座位 A,B 真的走出 2 手，广播坐标全部合法
   /api/ranking 200 · srszq.com 200
B) scripts/dev/public-replay-check.mjs     -> PUBLIC REPLAY CHECK: ALL PASS 0（重放/关键三手/分享未受影响）
C) scripts/dev/public-puzzle-check.mts     -> PUBLIC PUZZLE CHECK: ALL PASS 0（题库/每日题未受影响）
```

原始日志：`SRSZQ_Productization_Deliveries/P3B_20260930/`。

### 本批次仍然没碰的东西

- 未合并、未检出、未改写 `research/invitus`；未训练任何模型；未开启评分 Beta 或 shadow。
- 未做：O05 备份恢复演练、O07 容量实测、`/ready` 探针、管理界面、68 项封版（B7）。

---

## P4 上线（B7：就绪探针 / 备份恢复演练 / 容量实测 / 管理台 / 封版）

P4 分两批发布，两批都走完整的 `scripts/deploy-production.sh`（validate → 备份 → pm2 stop → ff-merge →
node_modules 提升 → pm2 reload → 5 项冒烟 → 失败自动回滚）。

| 批次 | 生产提交 | 发布脚本结论 | 回滚点 |
|---|---|---|---|
| P4a（就绪/备份/容量） | `d30db7fdac0e24c7d7209ae79d60408e6128b69f` | `RELEASE PASS: d30db7fd…` | `/var/backups/srszq/release-20260929T222017Z-f4KXGu` 之后的一次 |
| P4b（管理台） | `1a53a9d854e3af26b5c6e5d8386e08353ae06bd3` | `RELEASE PASS: 1a53a9d8…` | `/var/backups/srszq/release-20260929T225449Z-DcN06L` |
| P4b.2（发布标识 + 前端构建提交） | `c45c5ef45aede15b23e72109c3ad153ffffd5777` | `RELEASE PASS: c45c5ef4…` | `/var/backups/srszq/release-20260929T230006Z-LjHJGM` |

当前生产：`releaseId=p4b-20260930`，`/api/version.source.backendSourceSha=c45c5ef45aede15b23e72109c3ad153ffffd5777`。
5 项冒烟全部 PASS：API / WS（未认证在升级前被 401 拒绝）/ PM2 / DB（quick_check）/ NGINX。

### 三层同提交（这次能机器对账，不靠比对文件名）

前端在构建期把源码提交烘焙进 bundle（`vite define __SRSZQ_SOURCE_SHA__`，取 Netlify 的 `COMMIT_REF`），
管理台把“前端产物构建提交”和“后端自报提交”并排显示并给出判定。实测：

```
node scripts/dev/frontend-commit-probe.mjs --expect c45c5ef45aede15b23e72109c3ad153ffffd5777
  bundle index-DryVRTlb.js（289,300 bytes）内嵌 sha = c45c5ef45aede15b23e72109c3ad153ffffd5777  -> FRONTEND COMMIT MATCH
管理台「构建对账」面板：前端产物由 c45c5ef4… 构建 · 判定 与后端同提交
```

### 管理台（O03/O10 收口）

- 服务端：9 个管理端点统一走 `adminUser()`，普通账号一律 403（不是隐藏按钮）；`role` 打通
  `models -> db 映射 -> PublicUser -> 前端`。
- 前端：`AdminPage`（健康/队列/活跃房间/版本/举报队列/数据请求/数据集/审计），导航入口只对 ADMIN 显示。
- 授予管理员只走受控 CLI：`npx tsx scripts/ops/grant-admin.mts <user> [--revoke]`，写 `admin_audit`，不创建账号。

真实浏览器验收（CDP 驱动本机 Edge 无头实例，打 `https://srszq.com`）：`PUBLIC ADMIN CHECK: ALL PASS 0`（25 项）。
关键几条：

```
GET /api/admin/{live,reports,audit,data-tasks,dataset/runs,metrics/events} => 匿名 401 / 普通 403 / 管理员 200
POST /api/admin/reports/<id>                                  => 匿名 401 / 普通 403 / 管理员 404（按业务拒绝）
管理台 /ready：就绪（MIGRATIONS=ok · DB_WRITABLE=ok · AI_WORKER=ok）
审计面板 14 条（含刚才 CLI 授权的记录）· 举报队列 1 行 3 个按钮 · 导航“管理”入口 1 个
普通账号访问 /admin：出现“非管理员”，管理面板 0 个、导航入口 0 个
管理台桌面 1440x900 / 手机 390x844 截图由浏览器渲染（PNG 尺寸校验，非 HTML 拼图），手机无横向溢出
```

**测试账号披露（可撤销）**：为完成上述验收，在生产注册了一个明确标记为测试的账号
`dshadmin090310`（用户名以 `dsh` 开头 => `source=TEST`，页面按 DEMO 处理，随机 24 位密码），
并用受控 CLI 授予 ADMIN（`admin_audit` 有记录）。**没有改动任何真实用户角色**。
不需要时可执行：`ssh srszq-hk` 后 `cd /var/www/SRSZQ && SRSZQ_DB=/var/www/SRSZQ/data/srszq.sqlite npx tsx scripts/ops/grant-admin.mts dshadmin090310 --revoke`。
站主自己的账号要成为管理员同样用这条 CLI（把用户名换掉即可）。

### 本次发布修掉的两个**验收脚本自身**缺陷（否则会给出假证据）

1. `Page.addScriptToEvaluateOnNewDocument` 注册的脚本会在**每个新文档**重放：换账号时它把令牌改回管理员，
   于是“普通账号应被挡住”这条永远拿到管理员页面。必须先 `Page.removeScriptToEvaluateOnNewDocument`。
2. 数据是异步取的：只等容器出现就断言，会读到空面板（症状是审计 0 条）。改为等待真实数据（后端 sha 落到面板）落位。
   同一类教训在 R09 浏览器验收里出现过一次（等空态），这次是第二次，已写进脚本注释。

另外两条：改分入口检查最初扫全页 `innerText`，被页面自己的说明文字“不做改分”误判，改为只扫交互控件；
浏览器调试端口固定会让上一次没清掉的实例被当成本次实例，已改为随机端口 + `taskkill /T` 清进程树。
