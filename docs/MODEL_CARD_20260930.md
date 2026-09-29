# 模型卡（2026-09-30，P3B/B6 批次生成）

## 一句话结论

**本项目没有训练任何模型。** 本卡记录的是现有五档 AI 在 CPU 上的评测矩阵，以及研究协议 100k 门槛的当前状态。
任何“训练完成 / 续训完成”的说法都不成立。

## 评测对象与环境

- 对象：production-five-levels（现有五档 AI），即线上实际使用的决策实现。
- 环境：CPU；30 局真实引擎对局（13 路与 17 路各半），906 次决策，耗时 146160ms。
- 座位：每局 A/B/C 各坐一个配置并轮转；每局三个座位各坐一个配置并轮转；座位胜场差 6（理想为 0）。样本量 30 局不足以做统计显著性判断，因此不给置信区间结论。

## 真实训练量 vs 目标量（分开写，不混为一谈）

- 真实训练量：**0 局**（本仓库没有训练管线产出，也没有 checkpoint）。
- 目标量（研究协议冻结值，未改动）：正式训练 >= 100,000 局，17 路占比 >= 30%，A/B/C 三座覆盖。
- 门禁判定：**PARTIAL**

- [FAIL] EPISODES_100K：0 / 100000
- [FAIL] B17_SHARE_30PCT：0.0%
- [OK] SEATS_ABC：C,B,A
- [OK] NO_ILLEGAL_MOVE：0
- [OK] NO_CRASH：0
- [OK] NO_NAN：ok
- [FAIL] CALIBRATION_REPORTED：未报告 ECE/Brier/log-loss

## 失败指标（必须写，不能只报好看的数字）

- 非法落子尝试：0 次（合法率 1）。
- 崩溃：0 次。
- shadow 拒绝：906 次（元数据不全时按设计拒绝，不影响对局）。
- 同种子可复现：是（检查 6 局，逐手序列哈希比对）。

## 校准

NOT_AVAILABLE：现有五档 AI 不输出胜率估计：AIDecision.score 是启发式分数而非概率，无法计算 ECE/Brier/log-loss。

## 分层结果（不只有 pooled 数字）

| 棋盘 | 对手族 | 档位 | 局数 | 胜-负-和 | 胜率 | p95 延迟 | 非法 |
|---|---|---|---|---|---|---|---|
| 13 | SAME_LEVEL | L1 | 1 | 1-0-0 | 1 | 97.6ms | 0 |
| 13 | SAME_LEVEL | L2 | 1 | 1-0-0 | 1 | 105.54ms | 0 |
| 13 | SAME_LEVEL | L3 | 1 | 1-0-0 | 1 | 137.37ms | 0 |
| 13 | SAME_LEVEL | L4 | 1 | 1-0-0 | 1 | 501.51ms | 0 |
| 13 | SAME_LEVEL | L5 | 1 | 1-0-0 | 1 | 421.98ms | 0 |
| 13 | MIXED_LEVEL | L1 | 1 | 0-1-0 | 0 | 195.78ms | 0 |
| 13 | MIXED_LEVEL | L2 | 1 | 0-1-0 | 0 | 442.45ms | 0 |
| 13 | MIXED_LEVEL | L3 | 1 | 0-1-0 | 0 | 300.21ms | 0 |
| 13 | MIXED_LEVEL | L4 | 1 | 0-1-0 | 0 | 659.75ms | 0 |
| 13 | MIXED_LEVEL | L5 | 1 | 0-1-0 | 0 | 426.88ms | 0 |
| 13 | CHALLENGER_VS_5 | L1 | 1 | 0-1-0 | 0 | 464.91ms | 0 |
| 13 | CHALLENGER_VS_5 | L2 | 1 | 0-1-0 | 0 | 409.83ms | 0 |
| 13 | CHALLENGER_VS_5 | L3 | 1 | 0-1-0 | 0 | 317.44ms | 0 |
| 13 | CHALLENGER_VS_5 | L4 | 1 | 0-1-0 | 0 | 352.05ms | 0 |
| 13 | CHALLENGER_VS_5 | L5 | 1 | 1-0-0 | 1 | 452.54ms | 0 |
| 17 | SAME_LEVEL | L1 | 1 | 1-0-0 | 1 | 521.07ms | 0 |
| 17 | SAME_LEVEL | L2 | 1 | 1-0-0 | 1 | 508.19ms | 0 |
| 17 | SAME_LEVEL | L3 | 1 | 1-0-0 | 1 | 478.8ms | 0 |
| 17 | SAME_LEVEL | L4 | 1 | 1-0-0 | 1 | 585.84ms | 0 |
| 17 | SAME_LEVEL | L5 | 1 | 1-0-0 | 1 | 734.61ms | 0 |
| 17 | MIXED_LEVEL | L1 | 1 | 0-1-0 | 0 | 209.6ms | 0 |
| 17 | MIXED_LEVEL | L2 | 1 | 0-1-0 | 0 | 192.86ms | 0 |
| 17 | MIXED_LEVEL | L3 | 1 | 0-1-0 | 0 | 353.6ms | 0 |
| 17 | MIXED_LEVEL | L4 | 1 | 1-0-0 | 1 | 608.05ms | 0 |
| 17 | MIXED_LEVEL | L5 | 1 | 1-0-0 | 1 | 998.93ms | 0 |
| 17 | CHALLENGER_VS_5 | L1 | 1 | 0-1-0 | 0 | 543.95ms | 0 |
| 17 | CHALLENGER_VS_5 | L2 | 1 | 0-1-0 | 0 | 433.46ms | 0 |
| 17 | CHALLENGER_VS_5 | L3 | 1 | 0-1-0 | 0 | 872.84ms | 0 |
| 17 | CHALLENGER_VS_5 | L4 | 1 | 0-1-0 | 0 | 783.46ms | 0 |
| 17 | CHALLENGER_VS_5 | L5 | 1 | 1-0-0 | 1 | 795.52ms | 0 |

按座位：A 胜 8/30，B 胜 14/30，C 胜 8/30

## 未做的事情（不要误读）

- 未接入 Invitus：shadow flag 默认关闭；即使打开也只观察，其决策在类型上无法成为落子。
- 未做 GPU 训练、未产出 checkpoint、未做搜索 scaling（1600/3200 sims）与 exact oracle 残局评测。
- 因此研究协议里的强度门槛（seat-adjusted win rate 95% CI 下界 > 1/3 等）**没有结论**。

## 与 research/invitus 分支的关系

该研究分支独立存在于远端（refs/heads/research/invitus），本批次只做只读检查：未合并、未改写、未检出。
其 INVICTUS_ACCEPTANCE_CRITERIA.md 被本卡作为门槛口径引用，而不是复制它的实现。

## 复现方式

```
npx tsx scripts/product/ai-eval-matrix.mts --games 2
```

产物：evidence/ai-eval-matrix.json（含逐格分层统计与 matrixHash 89a5336746f5c9bf42ac0ba1d0ab0853）。
