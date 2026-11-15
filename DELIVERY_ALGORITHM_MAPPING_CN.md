# SRSZQ 交付算法映射

## 人机档位

| 产品显示 | 内部配置 | 实际引擎 |
|---|---|---|
| Terra | `level=4, strategy='mixed'` | 保留原四星混合策略 |
| Sol | `level=5, strategy='mixed'` | 保留原五星混合策略 |
| Astra | `level=5, strategy='astra'` | 直接调用原 `maxnSearch()`，跳过 `selectTactic`、防守策略改写及 Random/Tactical/Selfish/3-Ply 覆盖 |

Astra 的真实调用证据位于
`evidence/fourmode-chat/ASTRA_ENGINE_EVIDENCE.json`。
该证据证明 13×13 和 17×17 均进入真实 MaxN 实现，两者均记录 depth 2、48 nodes、
合法落点且无 fallback；
不用于宣称胜率、穷举终局树或必胜能力。

## 聊天与模型

- 聊天、表情、贴纸、举报、限速、持久化和补历史均由真实认证、SQLite 与 WebSocket 路径执行。
- 趣味改写的接口是 `POST /api/match-chat/rewrite`，只允许服务端读取环境变量中的模型配置。
- 模型输入仅包含当前一句话与所选风格；迟到响应在继续编辑、切换风格、座位或房间时失效。
- 模型不可用时返回原文，不影响聊天和棋局。
- 当前本地验收未配置 DeepSeek 服务端凭据，证据为
  `results/fourmode-20261115/DEEPSEEK_STATUS.json`，
  状态是 `NOT_CONFIGURED_SERVER_SIDE`。
- 网站 DeepSeek 可用性不能作为 Reddit 外部 AI 可用性证据；Reddit 协作仍按 OpenAI/Gemini 白名单单独处理。

## 权威边界

- 服务端从认证会话绑定 sender、seat 和 AI 身份，客户端字段不能覆盖。
- 在线消息先持久化，再按顺序游标广播；房间成员关系和跨房访问由服务端校验。
- 本地对局可切换当前发言席位，但该选择仅用于本地 UI，不构成联网账号身份。
- 联网随机 AI 补位当前仍沿用原服务端兼容路径，尚不支持 Astra strategy。
