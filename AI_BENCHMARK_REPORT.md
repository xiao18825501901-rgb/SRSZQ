# AI_BENCHMARK_REPORT — 分档性能基准（真实运行数据）

> 方法：对每档 AI 在 **120 个随机 BAC 中盘局面**（11×13 交替，确定性种子）调用与网页相同的
> `chooseAIMove`，统计决策耗时/深度/节点/TT 命中/候选数，并核验 **100% 合法**。
> 预算：离线配置 OFFLINE_LEVEL_CONFIG（random 5ms / tactical 30ms / selfish 60ms /
> 3ply 500ms·k7·d3 / maxn 1200ms·k9·d3）。

## 1. 运行命令与存档

```bash
npm run ai:benchmark                 # 120 局面/档
npm run ai:benchmark -- --states 40  # 快速冒烟
```

存档：`results/benchmark-2026-09-04T23-09-56-452Z.json`（最终配置，本文表格即其内容）。
同一命令行可重跑复核。

## 2. 结果表（真实输出）

| 档位 | avg | p50 | p95 | max | avgNodes | avgDepth | TT 命中 | avg候选 | pass | ILLEGAL |
|---|---|---|---|---|---|---|---|---|---|---|
| Random | 0.1ms | 0ms | 0ms | 4ms | — | — | 0 | — | 0 | 0 |
| Tactical | 0.2ms | 0ms | 1ms | 1ms | — | — | 0 | — | 0 | 0 |
| Selfish | 11.7ms | 11ms | 24ms | 29ms | — | 1-ply | 0 | — | 0 | 0 |
| 3-Ply | 230.4ms | 218ms | 445ms | 596ms | 764 | 2.99 | 0 | 8 | 0 | 0 |
| MaxN | 439.7ms | 413ms | 695ms | 1021ms | 1367 | 3.00 | 0 | 10 | 0 | 0 |

- 单档样本：120 局面 × 5 档；总墙钟 82.3s。
- 平均深度：3-Ply 2.99 / MaxN 3.00 —— 完整三人循环在预算内可靠完成。

## 3. 合法性与稳定性

- **非法落子总数：0**（120×5=600 决策全数通过引擎合法集校验）
- **chooseAIMove 内部兜底触发数：0**
- 零合法步 Pass 数：0（无终局/满盘样本）
- 自对弈全程同样为 0 非法 / 0 兜底（另见 AI_TUNING_REPORT.md）

## 4. 解读

- Random / Tactical 为即时启发式（<1ms）；Selfish 为 1-ply 全合法点扫描（~12ms）；
- 3-Ply 与 MaxN 共享 MaxN 搜索内核（向量效用、换位表、候选剪枝、时间预算），
  3-Ply 用 k7、MaxN 用 k9（严格超集）且预算更足；
- TT 命中为 0 是「单次决策独立换位表 + 稀疏棋盘换位稀少」的预期现象；
  深层搜索（d5+，未来放开迭代加深后）TT 才显著生效；
- 耗时上界（max 596ms / 1021ms）来自 13×13 密盘局面，仍远低于网页预算
  （3ply 800ms / maxn 1500ms），网页端不会出现超时截断。
