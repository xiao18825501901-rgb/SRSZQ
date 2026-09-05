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
| queue.join | — | 进入在线匹配（教学未完成 → error） |
| queue.leave | — | 离开队列 |
| move | {row, col} | 提交落子意图（服务端校验后广播） |
| resume | {gameId} | 断线续局（收到完整当前状态） |

服务端 → 客户端：
| type | 载荷 | 说明 |
|---|---|---|
| hello | {user} | 连接就绪 |
| queue.joined | {waiting} | 入队 |
| game.start | {gameId, mode, seats, yourSeat, state} | 开局；AI 座仅含 stars(★1-5) |
| game.state | {state, seats} | 权威状态广播（每步） |
| game.end | {status, winner} | 终局（status=won/draw/aborted） |
| error | {error} | 错误（含 tutorial required / not your turn …） |

seats 结构：`{ A/B/C: {kind:'human', username?} | {kind:'ai', stars} }`
—— **客户端永远看不到真实 AI 档位**（内部档位仅在服务端，权重 random100/tactical200/selfish300/3ply400/maxn500）。

防作弊：服务端为唯一状态源；非法动作（非本人回合/禁手/占位/越界）一律拒绝，
客户端不能决定结果；终局由服务端引擎判定并落盘。
