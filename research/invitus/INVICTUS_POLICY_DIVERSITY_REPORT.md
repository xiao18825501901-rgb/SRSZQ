# INVICTUS_POLICY_DIVERSITY_REPORT（5K 诊断）

## 结论：POLICY COLLAPSE 已确认（非风险，是事实）

5K checkpoint（invitus_005000_major.pt）在 120 局 fresh self-play 中：

| 指标 | 值 | 健康参照 |
|---|---|---|
| policy entropy mean | 0.0129 (13) / 0.0204 (17) | 1.0–4.0 |
| MCTS root visit entropy | 0.0 | >0.5 |
| unique 3-ply openings / 120 games | 2 | 数十 |
| unique 6/9-ply openings | 2 / 2 | 数十 |
| top-1 opening frequency | 64.2% | <10% |
| value predicted mean [A,B,C,D] | [0.27, 0.02, 0.71, 0.00] | 接近真实分布 |
| self-play outcome | A43 / B0 / C77 / DRAW0 | 三方均有胜场 |

单局 debug（候选 vs random+random）：每一步先验 P≈0.999 one-hot，走固定脚本（12,1 → 11,6 → 12,0 → 1,9 → 12,8 …），Q 平坦。

## 坍塌机制（根因已修复，见 5K 报告）

1. 根节点 Dirichlet 混入均匀分布（而非网络先验）——根先验与网络脱钩；
2. 内部节点用网络的尖先验 + 无噪声 + PUCT 先验主导 → 访问完全集中 → 目标 one-hot；
3. 无熵正则 → CE 目标把先验推向更尖 → 正反馈。
4. 16 sims 稀疏访问使目标天然 one-hot（加剧因素）。

## 修复与验证

- v1（根 Dirichlet 修正 + λ=0.02）：400 局时开局多样性恢复（14 种/30 局），但 1000 局熵回落至 0.13 —— 不足。
- v2（+ 目标温度 τ=2.0、λ=0.05）：scratch 2000 局验证进行中；通过标准 = 2000 局熵稳定 ≥0.5 且开局多样性健康。
- 验证工具：`eval/diversity_probe.py`（熵/开局/value 分布）+ `eval/debug_match.py`（单局先验检查）；训练波事件新增 `policyEntropy` 字段持续监控。

## 后续纪律

- 每个 500/5000 审计点同时记录 policyEntropy 趋势（1K/2K/3K/4K/5K 对照）。
- 若未来再次出现熵 <0.05 持续 1000 局：立即停训进入 RCA，不得继续烧算力。
