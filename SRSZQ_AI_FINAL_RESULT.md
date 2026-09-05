# SRSZQ_AI_FINAL_RESULT — 交付总结（真实数据）

> 任务：三人四子棋 BAC 专用人机对弈 AI（增量开发，未新增页面、未改动任何规则）。
> 项目：`D:\three-player-connect-four` · 本地服务：**http://localhost:5173**（`start.bat` / `npm run dev`）

## 1. 完成状态：✅ 全部交付并验证

| 交付项 | 状态 | 证据 |
|---|---|---|
| 五档 AI（Random/Tactical/Selfish/3-Ply/MaxN）× 每座位 6 选 1 | ✅ | E2E「每座位 6 个选项」通过 |
| 0–2 AI / ≥1 人类约束（禁三 AI） | ✅ | E2E「2 AI 上限禁用 / 强选 3 AI 被拒」通过 |
| 与人类共享引擎规则（getLegalMoves/applyMove/资格/禁手） | ✅ | 80 单测 + 合法性扫掠 + E2E 禁手场景；600 决策基准 **非法 0 / 兜底 0** |
| BAC-aware（R4=B R5=A R6=C 轮转、roundsUntilEligible、禁手成四感知） | ✅ | 资格单测 + AI 禁手专项 + E2E R4=🏆B |
| 自对弈/基准 harness（npm run ai:selfplay / ai:benchmark） | ✅ | 真实运行见 §3 |
| 换位表 + 迭代加深 + 候选剪枝 + 时间预算（MaxN 内核） | ✅ | search.ts；基准 avgDepth 3ply 2.99 / maxn 3.00 |
| Web Worker 搜索 + 取消/竞态保护 | ✅ | E2E「思考中锁盘」+ console 0 错误 |
| useAIController 异步链（串行 AI、THINKING、锁盘、自动 Pass、undoN） | ✅ | E2E 串行 AI / THINKING / 悔棋到人类回合通过 |
| PlayerCard HUMAN / 🤖AI·档位·星级；日志 AI 标记 + debug 统计 | ✅ | E2E 玩家卡与日志断言通过 |
| 导出含 players + 每步 ai 统计；旧格式仍可导入（默认全人类） | ✅ | E2E 新/旧格式往返通过 |
| 报告三件套 + 本总结 | ✅ | SRSZQ_AI_REPORT / AI_TUNING_REPORT / AI_BENCHMARK_REPORT |
| CBA / CBACC 回归无损 | ✅ | E2E 原场景全数通过 |
| console 0 错误 / 构建通过 / 页面可用 | ✅ | E2E errors=0；`npm run build` 成功 |

## 2. 测试结果汇总（真实输出）

- **单元测试：80/80 通过**（引擎 66 回归 + AI 14：随机局面合法性扫掠、禁手专项、战术行为）
- **浏览器 E2E：66/66 通过**（headless Edge 真实点击；含 CBA/CBACC 回归与全部 AI 场景）
- **基准（npm run ai:benchmark）**：5 档 × 120 随机 BAC 局面 ——
  Random 0.1ms / Tactical 0.2ms / Selfish 11.7ms / 3-Ply 230ms(d3)/ MaxN 440ms(d3)；
  **非法 0、内部兜底 0**（存档 results/benchmark-2026-09-04T23-09-56-452Z.json）
- **自对弈（npm run ai:selfplay）**：累计 200+ 局（阶梯 + 座位轮转），
  **非法 0、兜底 0、中止 0**（存档 results/selfplay-*.json ×5）
  - 轮转验证座次均衡；BAC 下 B 座（R4 首获权）优势显著（A=6 B=53 C=12 于 72 局阶梯）

## 3. 关键实测结论（如实说明，无虚报）

1. 评估函数经 sigmoid 锚定后，终局/活局数值可比（修复了早期偏好“输棋 0”的问题）；
2. **自对弈实测：在当前静态评估下 MaxN 的 d4+ 深层迭代为净负收益**（多轮轮转 3ply 39–44 胜 vs
   maxn 8–16 胜；受控同深度实验 k10 vs k7 为 19:21 均势）。原因定位为评估函数对长线/资格时序的
   判断失真被深搜放大，**非算法缺陷**；
3. 因此最终网页配置：MaxN = k9 宽候选 d3 + 叶节点必胜稳定化（同深度严格超集于 3ply 的 k7），
   3ply 与 maxn 实测同强度量级；「更深更强」需先改进评估（后续工作，报告已注明）；
4. 网页对用户保持 0–2 AI / ≥1 人类（三 AI 仅供内部评测）。

## 4. 运行方式

```bash
npm run dev            # 启动（http://localhost:5173）—— 设置 → 选 BAC → 每座位选 人类/AI 档位
npm test               # 80 项单测
npm run ai:benchmark   # 分档基准（真实数据写入 results/）
npm run ai:selfplay    # 三 AI 自对弈（--rotate 轮转；--combo L1/L2/L3 指定阵容）
node e2e.cjs           # 66 项浏览器 E2E（需 dev server 运行中）
npm run build          # 生产构建
```

## 5. 主要改动文件

- 新增：`src/ai/**`（types/seats/rng/threatAnalysis/evaluation/moveOrdering/search/searchAgents/
  randomAgent/tacticalAgent/selfishAgent/chooseAIMove/config/worker、tests）、
  `src/hooks/useAIController.ts`、`src/components/SeatSetup.tsx`、`scripts/ai-selfplay.ts`、
  `scripts/ai-benchmark.ts`、`SRSZQ_AI_REPORT.md`、`AI_TUNING_REPORT.md`、`AI_BENCHMARK_REPORT.md`、`本文件`
- 修改：`src/App.tsx`（座位状态/控制器/悔棋语义/导出导入/状态栏）、`src/game/rules.ts`（+undoN）、
  `src/hooks/useGame.ts`（+undoN）、`src/components/PlayerCard.tsx`、`MoveHistory.tsx`、
  `GameControls.tsx`、`styles/global.css`、`package.json`（ai:* 脚本 + tsx）、`e2e.cjs`（+AI 场景）、`README.md`

*交付时间：本会话（SRSZQ-AI-v1）。所有数字可经上述命令重跑复核。*
