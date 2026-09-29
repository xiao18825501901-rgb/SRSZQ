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
