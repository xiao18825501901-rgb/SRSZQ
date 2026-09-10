# INVICTUS_CALIBRATION_5K_REPORT

## 数字（5K 冻结模型，官方 replay 5000 样本，in-sample）

| 组 | Brier | LogLoss | ECE |
|---|---|---|---|
| 13×13 / A | 0.0320 | 0.3228 | 0.0241 |
| 13×13 / B | 0.0331 | 0.2475 | 0.0327 |
| 13×13 / C | 0.0317 | 0.2462 | 0.0267 |
| 17×17 / A | 0.0332 | 0.2653 | 0.0799 |
| 17×17 / B | 0.0493 | 0.3961 | —（组内同口径） |

（其余组别见 `official/evaluations/calibration_5k.json`）

## 判读：数字好看是假象

- 模型预测均值 [A,B,C,DRAW] ≈ [0.27, 0.02, 0.71, 0.00]；自对弈实际结果 A43/B0/C77/DRAW0。
- value head 学成了「C 大概率赢、B 几乎必输」的退化座位偏见——Brier/ECE 低只是因为它在退化分布上自洽，不是可靠价值学习。
- **VALUE_HEAD_STATUS: BIASED**。在修复后的训练中按 1K/2K/3K/4K/5K 持续记录 Brier/LogLoss/ECE 与预测分布，目标：预测分布回到接近真实三方分布。

## 后续

- 20K/50K/100K 每次 major 用同一脚本重测（`eval/calibration.py`，5000 样本口径一致）。
- 最终验收要求：fresh evaluation games（非 replay 内样本）+ Brier/LogLoss/ECE × 13/17 × A/B/C 全表。
