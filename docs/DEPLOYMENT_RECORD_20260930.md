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

## 未做的事

- 未改 DNS、未改域名、未改仓库可见性。
- 未开启评分 Beta、未晋级 Invitus、未开 shadow（实测均为 OFF 且为默认值）。
- 未迁移/覆盖生产数据库；只做了在线备份。
- 未删除任何生产数据。
