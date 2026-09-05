# TEST_REPORT — SRSZQ.com 测试报告（真实执行记录）

> 以下全部为实际运行输出摘要；命令均可重跑（见 docker/README.md「验证命令」）。
> 环境：Node v24.19.0 · Windows 11 · headless Edge。测试基线时间：SRSZQ.com 阶段收尾。

## 1. 单元测试（vitest，node 环境）— 64/64 通过

| 文件 | 覆盖 |
|---|---|
| shared/src/game/__tests__/eligibility.test.ts | 正式规则 v2：R1-5 NONE；R6=C/R7=B/R8=A 循环；firstEligibleRound |
| shared/src/game/__tests__/rules.test.ts | 胜负(4/5/6 连/方向)、禁手（R1/R5/R6 非资格）、R6-C/R7-B/R8-A 资格获胜、forcePass、自动 Pass 链、和棋、撤销、13×13 |
| shared/src/ai/tests/* | 五档 AI 合法性扫掠（13/17 混合 400+ 局面/档）、禁手专项、战术行为（获胜/封堵/Pass/3-Ply 陷阱）、兜底 0 计数 |
| backend/src/unit.test.ts | 密码哈希/校验、输入校验、头像 |

## 2. 后端集成（tsx 独立进程，真实 HTTP/WS/SQLite）

- `npm run test:backend`（API）— **ALL PASS**：注册→me→登出、登录/密码错误、400/409 校验、
  教学标记、排行榜排序、响应不泄露 passwordHash
- `npm run test:ws`（WebSocket）— **ALL PASS**（6 场景）：
  1. 教学门禁（未完成 → tutorial required）
  2. 1H+2AI：60s 超时 AI 补位、AI 座仅 ★ 星级、13×13、终局后排行 games+1
  3. 3H 真人匹配（无 AI 座）
  4. 全员退出 → 房间中止 → 用户可再匹配
  5. 权威落子广播给其余两人、断线自动强制 Pass、resume 续局
  6. 邀请接受 → 2H+1AI 非排位开局、好友建立、games 不增长（仅 Online 计分）

## 3. 浏览器 E2E（headless Edge + CDP）— PLATFORM E2E: ALL PASS（console 0 错误）

Landing（无 CBA/CBACC/11×11/真实 AI 档位名）→ 注册 → 教学门禁（大厅/在线被重定向）→
教学首局人机应手（★ 隐藏）→ 教学完成解锁大厅 → Human vs AI（★ 选择/开局/AI 应手）→
排行榜含新用户 → 好友邀请发送 → Local Match 13×13 落子 → 在线排队界面。

## 4. 本地规则回归（e2e-local.cjs，规则 v2）— ALL PASS
（棋盘 169/289 格、R6 🏆C 禁手、C 凭本手获胜、座位 6 选项/2-AI 上限/星级显示、
THINKING 锁盘、悔棋到上一人类回合、v2 导入导出、17×17 切换、console 0 错误）

## 5. AI 评测（真实运行存档 results/）
- `ai:benchmark`：5 档 × 120 随机局面（13/17）——非法 0、内部兜底 0；
  Random/Tactical <1ms、Selfish ~12ms、3-Ply ~230ms(d3)、MaxN ~440ms(d3)
- `ai:selfplay`：阶梯+轮转 200+ 局 —— 非法 0、中止 0（历史存档与报告见根目录 md）

## 6. 构建与类型
- `npm run build`（frontend）：tsc --noEmit + vite build 通过（含 ai.worker chunk）
- `npx tsc --noEmit`：shared+scripts / frontend / backend 三处均 0 错误

## 7. 已知问题 / 备注
- vitest worker 沙箱禁回环网络 → HTTP/WS 集成测试以 tsx 独立进程运行
- 在线多人 UI 层（多浏览器同局）协议行为已由 test:ws 覆盖；浏览器端单用户排队由 E2E 覆盖
- Docker 形态未在本机执行（无 Docker）：docker compose 文件已提供，需在装有 Docker 的主机验证
- 教学完整 3 局自动流转已实现（UI 逐局推进+终局上报），E2E 覆盖首局交互；全流程可手动完成
