# SRSZQ Deployment Audit

审计日期：2026-09-06。结论：本地安装、前端构建和 80 项单元测试通过；完整类型检查失败；部署条件不齐，尚未发布。

## Architecture

- npm workspaces：frontend、backend、shared。
- frontend：React + Vite，前端 build 含 tsc --noEmit，产物 frontend/dist。
- backend：Node HTTP + ws，使用 tsx 启动；API 8080、WS 8081，均绑定 loopback；WS 路径 /ws，API 路由包含 /api 前缀。
- shared：通过包 exports 暴露 TypeScript 规则和 AI 实现。
- SQLite：node:sqlite DatabaseSync，WAL；路径固定为 process.cwd()/data/srszq.sqlite。
- 现有目录包含 docs、docker、LICENSE，已有提交历史；无需重新初始化或大规模移动文件。

## Dependencies

下列为 package.json 声明范围，并非全部解析版本：

| 部分 | 主要依赖 |
| --- | --- |
| Root | tsx ^4.23.13、TypeScript ^7.0.2、Vitest ^5.0.0 |
| Frontend | React/React DOM ^19.2.8、framer-motion ^13.2.0、Vite ^8.2.2 |
| Backend | ws ^8.18.0、tsx ^4.23.13、Node 内置 sqlite |

实测运行环境：Node v24.19.0、npm 11.17.0；构建日志：Vite v8.2.2；测试日志：Vitest v5.0.0。npm install 报告审计 64 个包、0 漏洞。

## Environment Variables

| 变量 | 当前实现 |
| --- | --- |
| PORT | 已读取，默认 8080 |
| SRSZQ_WS_PORT | 已读取，默认 8081 |
| SRSZQ_QUEUE_TIMEOUT_MS | 已读取，默认 60000 |
| SRSZQ_AI_DELAY_MS | 已读取，默认 350 |
| SRSZQ_DISCONNECT_SKIP_MS | 已读取，默认 30000 |
| SRSZQ_INVITE_GATHER_MS | 已读取，默认 30000 |
| SRSZQ_FORFEIT_GRACE_MS | 已读取，默认 10000 |
| VITE_API_URL | 已读取；默认 http://127.0.0.1:8080，生产必须配置 HTTPS 端点 |
| VITE_WS_URL | 已读取；默认 ws://127.0.0.1:8081/ws，生产必须配置 WSS 端点 |
| DATABASE_PATH | 未在当前后端源码中发现读取，不能仅设置变量就视为有效 |
| SESSION_SECRET | 未在当前后端源码中发现读取；API 使用数据库会话令牌，需核实实际会话设计再决定如何实现 |

未创建 .env.production；未写入生产密钥。

## Verification Evidence

| 检查 | 结果 |
| --- | --- |
| git status，初始及 npm install 后 | 干净，master |
| npm install | PASS，0 vulnerabilities |
| npm run build | PASS，458 modules，frontend/dist |
| npm test | PASS，7 files / 80 tests |
| npm run typecheck | FAIL，qualification.test.ts:9 未使用 Player 类型 |
| 后端独立类型检查、API/WS 集成测试 | 未执行，已进入阻塞交接 |
| 三浏览器与公网端到端测试 | 未执行 |
| GitHub 账号 | 连接器认证成功 |
| Netlify 账号 | CLI 认证成功，项目未关联 |
| ECS、DNS、TLS | 未部署/未验证 |

## Deployment Risks

1. 完整类型检查未通过，不能认定质量门禁全部通过。
2. 缺少已知可用 ECS 管理或 SSH 入口；依照任务第 13 节暂停后续发布。
3. API 回应与 OPTIONS 使用 Access-Control-Allow-Origin: *；应按实际生产域名配置并验证。
4. .gitignore 当前排除 .env 和 .env.local，但未覆盖 .env.production、SQLite 的 WAL/SHM 配套文件或私钥；创建生产文件前须补齐忽略规则并检查暂存区。
5. SQLite 路径随进程工作目录变化；PM2 必须固定 cwd 或补充 DATABASE_PATH 支持、持久化目录和备份恢复验证。
6. backend 无 build 脚本，start 使用 tsx；直接省略 devDependencies 会影响当前运行方式，需要在生产安装策略中处理。
7. 前端默认使用本机 HTTP/WS；当前构建仅证明可编译，不是可发布的生产连接配置。
8. 同域 /api 与 /ws 的代理路线尚未验证，不能把普通 HTTP 代理配置视为 WebSocket 验证通过。
9. 尚无本次验证过的 PM2 开机自启、Nginx Upgrade、证书续期、日志、回滚或公网负载结果。

## Sources Inspected

package.json、frontend/package.json、backend/package.json、shared/package.json、.gitignore、.env.example、vitest.config.ts、backend/src/server.ts、backend/src/api.ts、backend/src/db.ts、frontend/src/api.ts、shared/src/game/__tests__/qualification.test.ts，以及本次命令输出。

本审计范围有限，未声称已经完成全面安全审计。后续行动与精确错误见 CODEX_DEPLOYMENT_HANDOFF_REPORT.md。
