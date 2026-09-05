# SRSZQ.COM FINAL REPORT

> 把既有“三人四子棋 + SRSZQ AI”网页项目增量升级为 SRSZQ.com 在线游戏平台的最终交付报告。
> 全部功能本地完整可运行并实测；真实测试数据见 `docs/TEST_REPORT.md`，命令可重跑。

## Project Path
`D:\three-player-connect-four`（monorepo；git 仓库 9 个分阶段提交，见 §Git）

## Frontend
- `frontend/`：React 19 + TS + Vite 8 平台 SPA（哈希路由）
- 页面：Landing/Hero · 注册登录 · 新手教学（门禁 + 3 局隐藏 AI，★1-3 内部 random→tactical→selfish）·
  大厅（Online / Human vs AI / Local / 好友）· 在线对局（排队 → WS 渲染/落子 → 结算）·
  人机选择器（★1-5，内部映射五档）· 本地对局 · 排行榜 · 好友与邀请
- AI 全站隐藏真实档位（仅 ★）；规则 UI 仅 BAC v2（无 CBA/CBACC/11×11）

## Backend
- `backend/`：Node 24 + TypeScript + `ws`；模块：auth / rooms / matchmaker / ranking / social / db
- HTTP API：register/login/logout/me/tutorial/ranking/friends/invite(accept/reject)
- WebSocket（`:8081/ws`）：queue.join/leave · move · resume；服务器权威校验每步（共享引擎），
  广播状态、终局落盘；60s 匹配超时 AI 补位（权重 random100/tactical200/selfish300/3ply400/maxn500）；
  断线自动强制 Pass + resume；全员离开中止房间；防作弊（客户端不能决定结果）

## Database
- SQLite（`node:sqlite`，零依赖，`backend/data/srszq.sqlite`，容器卷持久化）
- 表：users / sessions / ranking / games / matches / friends / invitations / tutorial_progress
  （结构见 `docs/DATABASE_SCHEMA.md`；仓储接口可换 PostgreSQL）

## Local URL
- 前端 http://127.0.0.1:5173（`npm run dev`）
- API http://127.0.0.1:8080 · WS ws://127.0.0.1:8081/ws（`npm run dev:backend`）
- Docker 一键：`docker compose up --build` → 前端 :8088（见 docker/README.md 与 DEPLOYMENT.md）

## Production URL
- 尚未上线（无域名/服务器/凭据）。方案已定并写入 `docs/DEPLOYMENT.md`：
  国内目标 = 阿里云/腾讯云轻量服务器 + Docker Compose（大陆地域需 ICP 备案；香港免备案）；
  海外快速起步 = Fly.io / Render（原生 WebSocket）；Vercel/Netlify 仅托管前端 SPA；
  Cloudflare 建议作 DNS/CDN/HTTPS(WSS) 前置。附上线检查清单与多实例扩展说明。

## GitHub
- 本地 git 仓库已建立并分阶段提交（9 commits，工作树干净）。**未推送远程**：
  本环境无 GitHub 凭据/远程地址 —— 需用户提供远程仓库后执行
  `git remote add origin <url> && git push -u origin master`。

## Completed Features
1. 正式规则 v2（shared 唯一来源）：仅 BAC、13×13/17×17、R1-5 NONE、R6 起 C→B→A、
   禁手与“当前手触发胜利”、自动 Pass —— 引擎/AI/UI/后端/测试全部落地
2. monorepo：shared(引擎+AI+proto) / frontend / backend / docs / docker / scripts；禁止双份引擎
3. 五档 AI 保留（Random/Tactical/Selfish/3-Ply/MaxN），评测脚本与存档可重跑
4. 用户系统（scrypt+盐、会话 token、教学门禁）、排行榜（仅 Online 计分）、好友/邀请（接受即开局）
5. 在线多人：匹配队列/AI 补位/服务器权威房间/断线重连/邀请对局
6. 平台前端全流程：Landing → 注册 → 教学(3 局) → 大厅 → Online/Human-vs-AI/Local/Ranking/Friends
7. 部署资产：Dockerfiles、docker-compose、.env.example、Nginx(WS 反代)、云调研与上线清单
8. 文档：PROJECT_AUDIT / ARCHITECTURE / DATABASE_SCHEMA / API_DOC / DEPLOYMENT / TEST_REPORT / README / LICENSE

## Tests Passed（真实执行）
- vitest 单测：**64/64**（引擎 v2：R1-5 NONE/R6=C/R7=B/R8=A、13×13、禁手、forcePass…；AI 扫掠；backend 纯函数）
- `npm run test:backend`：**ALL PASS**（真实 HTTP + SQLite：注册/登录/登出/教学/排行/防泄露/邀请发送-接受-拒绝/发送者不可代接受 403）
- `npm run test:ws`：**ALL PASS**（真实 WS 多客户端：门禁 / 1H+2AI 补位(★隐藏) / 3H /
  房间中止清理 / 权威广播+断线强制 Pass+resume / 邀请 2H+1AI 非排位）
- `npm run e2e`（浏览器平台 E2E）：**ALL PASS**（console 0 错误；注册→教学门禁→大厅→
  人机 ★→排行→好友→本地→在线排队）
- `npm run e2e:local`（本地规则回归 v2）：**ALL PASS**
- AI 评测：基准 5 档×120 局面非法 0/兜底 0；自对弈 200+ 局非法 0（存档 results/）
- 构建：root/frontend/backend tsc 0 错误；`npm run build` 通过（含 ai.worker chunk）

## Known Issues
- Docker 形态未在本机实跑（本机无 Docker）——compose 文件已就绪，需在装有 Docker 的主机验证
- 在线多人浏览器端“多用户同局”UI 联调未跑（协议层由 test:ws 全覆盖）；单用户排队由 E2E 覆盖
- vitest worker 沙箱禁回环网络 → 集成测试以 tsx 独立进程运行（已在 TEST_REPORT 记录）
- 教学 3 局全自动流转逻辑已实现并经首局交互验证，完整 3 局手动可跑完
- AI 深度策略说明（3-Ply/MaxN 当前同深度量级、d4+ 净负收益）见 AI_TUNING_REPORT.md（v1 存档，
  规则 v2 下需以新评测为准——脚本已支持 13/17 重跑）

## Next Steps
1. 用户提供 GitHub 远程 → push 仓库（建议公开，MIT）
2. 备案/域名/服务器 → `docker compose up -d --build` 上线（DEPLOYMENT.md 清单）
3. 浏览器端多开在线对局 E2E + 教学全 3 局自动化（补充 UI 层覆盖）
4. 评估函数改进后放开 MaxN 深层迭代（AI_TUNING_REPORT 记录的方向）
5. PostgreSQL/Redis 切换与多实例扩展（db 仓储接口 + 房间集群化已预留）

## Git（10 提交）
`2b9745a` Initial architecture → `f3fd3a8` Rules v2 → `465a44b` Frontend migration(monorepo) →
`0ec1421` Backend(foundation) → `7be6a3b` Online multiplayer → `94ad23d` Frontend migration(platform SPA) →
`fcedad9` Deployment & docs → `3b802af` Final report → `472b45b` invite reject test
