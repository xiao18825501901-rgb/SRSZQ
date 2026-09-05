# DATABASE_SCHEMA — SRSZQ.com 数据库结构

默认实现：**SQLite（node:sqlite，零依赖）**，位于 `backend/data/srszq.sqlite`
（容器形态为 volume `srszq-data`）。`backend/src/db.ts` 以仓储接口封装，可替换为 PostgreSQL。

## users — 用户

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| email | TEXT UNIQUE | 登录邮箱（小写存储） |
| username | TEXT UNIQUE | 用户名（登录校验大小写不敏感） |
| avatar | TEXT | SVG data-URI 头像 |
| password_hash / salt | TEXT | scrypt(salt, password) hex |
| created_at | INTEGER | epoch ms |
| tutorial_completed | INTEGER 0/1 | 教学门禁 |
| online_status | TEXT | online/offline/playing/matching |
| rating | INTEGER | 默认 1200（仅 Online Match 变动） |

## sessions — 会话令牌

token TEXT PK · user_id FK · expires_at INTEGER（7 天）

## ranking — 排行（仅 Online Match 计分）

user_id TEXT PK FK · wins/games INTEGER · score INTEGER
> rating 变更同时写回 users.rating；胜 +30 / 负 −10；邀请/人机/教学局不写此表。

## games — 对局存档

id PK（= 房间 id）· board_size INTEGER(13|17) · mode TEXT(online/invite) ·
winner TEXT|null · created_at · moves_json TEXT（完整 MoveRecord 序列）

## matches — 比赛关系（三人座位）

id PK · game_id FK · player_a/b/c（可为 null，AI 座空）· result TEXT|null（胜者座位）·
**end_reason TEXT（NORMAL_WIN / PLAYER_FORFEIT / PLAYER_DISCONNECT / TIMEOUT）** ·
**winner_ids TEXT(JSON userId[]) · loser_ids TEXT(JSON userId[])** · is_ranked 0/1 · created_at

> Player Leave System（v3）：
> - 主动 Leave（PLAYER_RESIGN）→ `end_reason=PLAYER_FORFEIT`，离开者入 loser_ids；
> - 掉线超过宽限期（SRSZQ_FORFEIT_GRACE_MS，默认 10s）→ `end_reason=PLAYER_DISCONNECT`；
> - 其余在场人类入 winner_ids（1H+2AI 人类离场时 winner_ids 为空，仅记离场者败）；
> - winner_ids/loser_ids 只含真人 userId（AI 不入表），JSON 数组存储。
> - 旧库升级：openDb 启动时对已有 matches 表自动 `ALTER TABLE ADD COLUMN`（幂等迁移）。

## friends — 好友（双向两行）

(user_id, friend_id) PK · status（accepted）

## invitations — 邀请

id PK · sender/receiver FK · status(pending/accepted/rejected) · created_at
> 接受后自动：状态置 accepted、addFriends、触发 2 真人 + 1 AI 对局（非排位）。

## tutorial_progress — 教学进度

user_id PK · step · updated_at（当前用 users.tutorial_completed 做门禁主标志）

## 迁移策略
- SQLite：`CREATE TABLE IF NOT EXISTS …` 幂等建表（openDb）。
- PostgreSQL：保留同名字段即可；SQL 方言差异集中在 `db.ts`（COLLATE NOCASE、
  INSERT OR IGNORE 等），替换实现时注意。
