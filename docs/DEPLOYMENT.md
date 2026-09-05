# DEPLOYMENT — SRSZQ.com 部署指南与云调研

> 目标形态：**前端 SPA + Node/WebSocket 后端 + SQLite（可换 PostgreSQL）**。
> 由于对局是长连接实时（WebSocket 房间 + 服务器权威状态），**部署选型的第一约束是
> “可靠的长连接 WebSocket 支持”**，其次才是成本/延迟/国内访问。

## 1. 平台调研矩阵（按 本任务评估维度）

| 平台 | WebSocket | 成本（起步） | 延迟/区域 | 国内访问 | 部署复杂度 | 适合 SRSZQ？ |
|---|---|---|---|---|---|---|
| **阿里云 / 腾讯云 轻量服务器**（自管 Docker Compose） | ✅ 原生（自管） | ~¥60-120/月（2C2G-4G） | 低（可选国内/香港地域） | ✅ 优（大陆地域需 ICP 备案；香港免备案但延迟略高） | 中（服务器+域名+Docker） | **★ 首选（国内目标）** |
| **Fly.io** | ✅ 原生（支持 TCP/WS，多地 Anycast） | 按用量计费，起步 ~$5/月量级 | 低-中（全球边缘） | 一般（境外回源） | 低（flyctl 部署） | 海外快速起步首选 |
| **Render**（Web Service） | ✅（免费层睡眠限制；付费稳定） | $7/月起 | 中（美东/俄勒冈等） | 一般 | 低 | 原型/海外可 |
| **Vercel / Netlify** | ⚠️ 无持久 WS（Serverless） | 前端免费 | — | 国内直连不稳定 | 低 | **仅托管前端 SPA**；后端仍需常驻 WS 服务 |
| **Cloudflare** | ⚠️ Workers 无长连接 WS；可用 DNS/CDN/Tunnel 前置 | 前端/代理免费 | 低（全球 CDN） | 中（境内节点有限） | 中 | **建议用作 DNS+CDN+HTTPS/WS 反代**，回源到自管服务器 |

参考：[Node/Python 自部署服务器选型](https://blog.zestp.com/archives/126702)、
[2026 PaaS 对比](https://seenode.com/blog/best-paas-providers-for-web-apps-2026)、
[Cloudflare 代理/DNS 配置](https://www.wvn.cn/3781.html)、
[实时应用 WS vs SSE 讨论](https://eastondev.com/blog/fr/posts/dev/20260107-nextjs-realtime-chat/)。

### 结论
1. **目标用户在国内 → 首选：国内轻量云（阿里云/腾讯云）+ Docker Compose 一键部署**；
   大陆地域域名需 ICP 备案（备案周期约 1-3 周，属上线前提）；不想备案可先放香港地域。
2. **海外/快速原型 → Fly.io 或 Render**（原生 WebSocket、部署简单、按量计费）。
3. **前端静态资源**可再叠加 Cloudflare/Vercel CDN 加速（哈希路由 SPA 无服务端渲染依赖）。
4. 本仓库已提供 `docker-compose.yml` + Nginx（含 `/ws` Upgrade 反代），
   **服务器上 `docker compose up -d --build` 即可**；数据落在 SQLite 卷（`srszq-data`），
   需要 PostgreSQL 时启用 compose 注释段并替换 `backend/src/db.ts` 仓储实现（接口不变）。

## 2. 生产部署步骤（以国内轻量云 + Docker 为例）

```bash
# 1) 服务器：安装 Docker + docker compose 插件
curl -fsSL https://get.docker.com | sh

# 2) 拉取代码（GitHub 仓库见 README）
git clone <repo> srszq && cd srszq

# 3) 配置
cp .env.example .env            # 修改端口/超时
# 域名与反代：把 docker/nginx.conf 的 server_name 与证书配置接入系统 Nginx/Caddy，
# 或直接用本 compose 的 frontend 容器 + 外层负载均衡（HTTP/WS 均反代到 8080/8081）

# 4) 启动
docker compose up -d --build
docker compose ps               # backend(8080/8081) + frontend(8088)
```

## 3. 上线检查清单
- [ ] 域名备案/解析（国内地域）
- [ ] HTTPS（含 WSS：前端 WS_URL 改为 wss://…）
- [ ] 数据库定期备份（`docker compose exec backend` 内 data/srszq.sqlite 备份或启用 Postgres）
- [ ] 环境变量注入（VITE_API_URL/VITE_WS_URL 在构建期指向正式域名）
- [ ] 监控：进程常驻（restart: unless-stopped）、日志（docker logs）
- [ ] 压测：匹配/对局并发（队列+房间均为内存态，单实例目标 200-500 并发；横向扩展需 Redis pub/sub，已留接口说明）

## 4. 架构与可扩展性备注
- 单实例：房间在内存（Map），SQLite 落盘 —— 适合起步与中低并发。
- 多实例：匹配/房间需共享（如 Redis pub/sub 广播房间事件），
  `backend/src/ws/gameServer.ts` 已把“房间/广播”隔离，可替换为集群实现；数据库切换见上。
