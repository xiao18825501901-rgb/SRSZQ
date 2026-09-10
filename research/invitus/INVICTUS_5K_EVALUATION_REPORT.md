# INVICTUS 5K MILESTONE

```
FORMAL:            5000 / 100000
CHECKPOINT:        invitus_005000_major.pt（官方命名空间 checkpoints/）
CHECKPOINT SHA256: 1ea31fcfdf8f5e214e71a445b55220779d04db938c337b682f9883efb18e3afb
GIT SHA:           96c985a（评估时代码；含评估实现）
STATE_CONSISTENT:  PASS（FORMAL=5000 == CHECKPOINT=5000，审计全绿）
```

## TRAINING

| 指标 | 值 |
|---|---|
| POLICY LOSS | ~0.10–0.40（末期低至 ~0.005） |
| VALUE LOSS | ~0.02–0.40 |
| TOTAL LOSS | ~0.2–1.0 |
| GRAD NORM | 0.2–1.5（有限） |
| POLICY ENTROPY | **0.013 (13×13) / 0.020 (17×17)** ← 坍塌 |
| MCTS VISIT ENTROPY | **0.0** ← 坍塌 |
| A/B/C outcome（self-play 120 局） | A 43 / B 0 / C 77 / DRAW 0（退化分布） |

## CHAMPION GATE（900 局，座位平衡 100/seat/matchup）

| Matchup | A-seat | B-seat | C-seat | seat-adjusted | 95% CI |
|---|---|---|---|---|---|
| VS 5★+5★ | 0/100 | 0/100 | 0/100 | 0.0 | [0.0, 0.0126] |
| VS MaxN+MaxN | 0/100 | 0/100 | 0/100 | 0.0 | [0.0, 0.0126] |
| VS 5★+MaxN | 0/100 | 0/100 | 0/100 | 0.0 | [0.0, 0.0126] |

**CHAMPION DECISION: 不加冕。CURRENT_CHAMPION = none。**

## SEARCH SCALING（16/24/32 sims，同一冻结 checkpoint）

- 16 sims: seat-adjusted WR 0.0（vs 5★+5★ 与 vs MaxN+MaxN 各 300 局）
- 24 sims: 0.0（同）
- 32 sims: 0.0（同）
- PAIRED EVALUATION: NO（独立 seed）
- **STRENGTH TREND: 无效数据**——坍塌模型的胜率不携带搜索预算信息；搜索预算对比推迟到健康模型（20K）重做。

## EXACT ORACLE

- Attempted: 0 有效候选（replay 尾局全部 legal>10 —— 坍塌棋局过早结束）
- Solved: 0 → **oracle 空**（这是坍塌的又一证据：没有深局）
- 结论：5K 无法做 exact agreement；改为在修复后的训练（10K+）上重建 oracle，并计划加入合成残局生成器（不依赖对局深度）。

## DIVERSITY（120 局）

- Policy entropy: 0.013 / 0.020（13/17）· Visit entropy: 0.0
- First-3 / 6 / 9 plies unique: 2 / 2 / 2（120 局！）
- Top opening frequency: 64.2%
- **POLICY_COLLAPSE_RISK: HIGH → 确认为 POLICY COLLAPSE**

## CALIBRATION（5K，replay 5000 样本）

- Brier ~0.032 · LogLoss ~0.25–0.40 · ECE 0.02–0.08（13×13 与 17×17 各座位）
- 警示：这些数字「看起来好」只是因为 value head 学会了退化结果分布（P(C)≈0.71，P(B)≈0.02，P(DRAW)≈0），并非可靠价值学习。
- **VALUE_HEAD_STATUS: BIASED**（座位偏见，B 座几乎被判 0）

## 5K VERDICT

```
MODEL_IS_LEARNING:     NO（政策坍塌，900 局 0 胜）
MODEL_STRENGTH:        BELOW_BASELINE
SEARCH_SCALING:        INCONCLUSIVE（无效数据）
READY_TO_CONTINUE_20K: NO（先完成 ROOT_CAUSE_ANALYSIS + 修复验证）
READY:                 NO
INVICTUS IS NOT TRAINED YET.
```

## ROOT CAUSE（已定位，代码级）

1. **Dirichlet 混用错误**（`mcts/nn_mcts.py`）：训练时根节点先验 = ε·Dirichlet + (1−ε)·**均匀分布**，而非 AlphaZero 的「网络先验混噪声」→ 根节点脱离网络策略，内部节点却用网络的尖先验且无噪声 → 尖先验→访问集中→one-hot 目标→更尖先验的正反馈坍塌。
2. **无策略熵正则**：loss 无法抵抗 one-hot 目标。
3. **稀疏访问目标**：16 sims 下访问分布天然稀疏，目标近乎 one-hot。

## 修复与验证状态

- v1 修复：根先验改为 (1−ε)·网络先验+ε·Dirichlet(0.3)；熵正则 λ=0.02；补 NaN 熔断。→ 验证显示只「延缓」坍塌（1000 局熵 0.13），不够。
- v2 修复（当前）：目标温度 τ=2.0（visits^(1/τ) 软化）+ λ=0.05 + 根 Dirichlet 修复。→ scratch 2000 局验证进行中（16 sims）；400 局版已显示开局多样性恢复（30 局 14 种 9 手开局 vs 坍塌版 120 局 2 种）。
- 验证通过标准：2000 局时 policy entropy 稳定 ≥0.5 且开局 diversity 健康 → 用修复代码继续官方 run；否则继续加大 τ/λ 迭代。

## 成本（截至 5K）

- 训练 GPU 时长 ≈ 3.4h（0–5000，含中断恢复）· 评估 ≈ 1.1h（900+1800+120 局 + 探针）· 合计 ≈ 4.5h ≈ **¥33**（¥7.35/h）
- 结论：5K 的诊断价值已兑现（发现并定位坍塌），该成本是必要的科学成本。
