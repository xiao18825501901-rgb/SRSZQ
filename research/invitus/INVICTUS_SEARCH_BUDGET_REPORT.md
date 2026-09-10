# INVICTUS_SEARCH_BUDGET_REPORT（5K，16/24/32 sims）

## 实验设置

- 冻结模型：invitus_005000_major.pt（sha256 1ea31fcf…）
- 对手：vs 5★+5★、vs MaxN+MaxN，每 matchup 300 局（A/B/C 各 100，座位平衡）
- 三档：16 / 24 / 32 sims（同一 checkpoint，evaluation mode：Dirichlet OFF、temperature=0）
- PAIRED EVALUATION: NO（独立 seed family；20K 起改为 paired）

## 结果

| sims | vs 5★+5★ WR | vs MaxN+MaxN WR | 95% CI | 用时 |
|---|---|---|---|---|
| 16 | 0.000 | 0.000 | [0, 0.013] | ~590s / 600 局 |
| 24 | 0.000 | 0.000 | [0, 0.013] | ~660s |
| 32 | 0.000 | 0.000 | [0, 0.013] | ~?（链日志同口径） |

## 判定

**数据无效**：5K 模型已政策坍塌（0 胜与搜索预算无关），这些数字不能回答 Q1–Q5（24 是否强于 16 等）。依据 Phase 4B §36 不据此做 NEXT_STAGE_SIMS 决策。

## NEXT_STAGE_SIMS 决策（推迟）

- 决策条件改为：修复后的健康模型在 **20K** 用同一协议（加 paired 设计）重做 16/24/32 对比。
- 现阶段训练 sims 维持 16（修复验证同 16 sims，保证可比）；若修复后 20K 证据显示 24 显著更强且吞吐可接受，5K→20K 段内允许切换并记录 config transition。

## 吞吐参照（同一冻结模型，评估模式）

- 16 sims ≈ 600 局/590s ≈ 3660 GPH（评估，无训练步）
- 24 sims ≈ 3270 GPH
- 训练吞吐（含 8 训练步/波，20 进程）：16 sims ≈ 1400–1650 GPH（官方 run 实测）

## 后续

- 20K：paired search-scaling（同 seed/对手/座位下跑三档）+ exact agreement 三档 + GPH/latency/nodes-per-sec 全量记录（`eval/search_scaling.py` 已支持）。
