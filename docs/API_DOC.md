# API_DOC — SRSZQ.com HTTP / WebSocket 接口

Base: `http://127.0.0.1:8080`（前端默认直连；生产经 Nginx 反代同域）。
认证：`Authorization: Bearer <token>`。响应统一 `{ ok, ... }`，错误 `{ ok:false, error }`。

## Auth（用户）

| 方法 | 路径 | 请求 | 成功 | 说明 |
|---|---|---|---|---|
| POST | /api/register | {email, username, password} | 201 {user, token} | 邮箱/用户名唯一；密码 ≥6 |
| POST | /api/login | {account, password} | 200 {user, token} | account=邮箱或用户名 |
| POST | /api/logout | — | 200 {} | 撤销 token，状态 offline |
| GET | /api/me | — | 200 {user} | 本人（含 email/tutorialCompleted） |
| POST | /api/tutorial/complete | — | 200 {user} | 教学完成标记 |
| GET | /api/ranking?limit=20 | — | 200 {ranking[]} | 仅 Online Match 计分；按 rating 降序 |

user 对象：`{id, username, avatar, onlineStatus, rating, tutorialCompleted, email?}`（不含密码）。

## Social（好友/邀请）

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| GET | /api/friends | — | 好友列表（含在线状态） |
| GET | /api/invitations | — | 待处理邀请 |
| POST | /api/invite | {toUsername} | 发送邀请 |
| POST | /api/invite/accept | {id} | 接受 → 好友 + 自动开局（2 真人 + 1 AI） |
| POST | /api/invite/reject | {id} | 拒绝 |

## WebSocket — `ws://127.0.0.1:8081/ws?token=<token>`

连接即鉴权；失败 close(4001)。帧为 JSON。

客户端 → 服务端：
| type | 载荷 | 说明 |
|---|---|---|
| queue.join | — | 进入在线匹配（教学未完成 → error）。若已在未结束对局中（掉线宽限期）→ **自动续局**（等价 resume） |
| queue.leave | — | 离开队列 |
| move | {row, col} | 提交落子意图（服务端校验后广播） |
| resume | {gameId} | 断线续局（收到完整当前状态；清除判负宽限定时器） |
| PLAYER_RESIGN | — | **主动离开 Online Match → 立即判负终局**（好友局 → error resign not allowed in this mode） |

服务端 → 客户端：
| type | 载荷 | 说明 |
|---|---|---|
| hello | {user} | 连接就绪 |
| queue.joined | {waiting} | 入队 |
| game.start | {gameId, mode, seats, yourSeat, state, qualification} | 开局/续局；AI 座仅含 stars(★1-5)；qualification 见下 |
| game.state | {state, seats, qualification} | 权威状态广播（每步，含实时资格时间线） |
| game.end | {status, winner, reason, winnerIds/loserIds/winnerSeats/loserSeats, matchId, timestamp} | 终局（status=won/draw/forfeit/aborted） |
| MATCH_ENDED | {matchId, mode, reason, winnerIds, loserIds, winnerSeats, loserSeats, timestamp} | **Player Leave System 结算广播**（reason=NORMAL_WIN/PLAYER_FORFEIT/PLAYER_DISCONNECT/TIMEOUT；胜负数组由服务器推导） |
| player.status | {seat, status, graceMs?} | 座位连接状态：disconnected（进入判负宽限）/ reconnected |
| error | {error} | 错误（含 tutorial required / not your turn / no such game …） |

seats 结构：`{ A/B/C: {kind:'human', username?} | {kind:'ai', stars} }`
—— **客户端永远看不到真实 AI 档位**（内部档位仅在服务端，权重 random100/tactical200/selfish300/3ply400/maxn500）。

### qualification（BAC 资格时间线 · 服务器权威）

`game.start` 与每次 `game.state` 均携带，由服务器用共享引擎（`shared/src/game/qualification.ts`，
规则单一来源 `eligibility.ts`）计算，客户端不自行推导：

```json
{
  "qualification": {
    "currentRound": 8,
    "currentEligible": "A",
    "upcoming": [
      { "round": 9, "player": "C" },
      { "round": 10, "player": "B" },
      { "round": 11, "player": "A" },
      { "round": 12, "player": "C" },
      { "round": 13, "player": "B" },
      { "round": 14, "player": "A" },
      { "round": 15, "player": "C" },
      { "round": 16, "player": "B" }
    ]
  }
}
```

- `currentEligible`：Round 1–5 = `null`（无人拥有胜权）；Round ≥6 = 引擎真实输出
  （R6=C, R7=B, R8=A，按 C→B→A 循环）；
- `upcoming`：当前轮之后的连续 8 轮（lookahead 常量可扩展），`player: null` 表示该轮无胜权；
- Round 与回合换算：`round = floor(turnIndex/3)+1`（共享引擎 roundFromTurn）。

防作弊：服务端为唯一状态源；非法动作（非本人回合/禁手/占位/越界）一律拒绝，
客户端不能决定结果；终局与胜负（含离场判负）由服务端引擎推导并落盘。

## Player Leave System（v3）行为

- **主动 Leave**：前端 Leave Match 按钮 → 确认弹窗 → 发送 `PLAYER_RESIGN` → 服务器立即判负
  （`end_reason=PLAYER_FORFEIT`），该对局**立即终局**（AI 不继续）。
- **掉线（关标签/刷新/断网）**：服务器置座位 `disconnected`（DISCONNECTED_TEMPORARY），
  广播 `player.status`；宽限期（`SRSZQ_FORFEIT_GRACE_MS`，默认 **10s**）内 resume / 重新入队
  自动恢复本局（不判负、不清除进度）；超时 → 判负（`end_reason=PLAYER_DISCONNECT`）。
- **结算**：离场者入 loserIds（败 −10，games+1）；其余在场人类入 winnerIds（胜 +30，games+1/wins+1）；
  1H+2AI 人类离场 → winnerIds 为空（仅记离场者败）；好友/人机/教学/本地局不涉及排行，
  好友局拒绝 PLAYER_RESIGN。
- 结束后房间/会话绑定全部释放 → 玩家可立即再次 Online Match。
