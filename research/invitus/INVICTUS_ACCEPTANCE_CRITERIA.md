# INVICTUS_ACCEPTANCE_CRITERIA

> 冻结于正式大训练之前（防止事后挪动 goalpost）。STATUS=READY 必须全部满足。

## 训练门槛（NON-NEGOTIABLE）

1. formal training episodes ≥ **100,000**（合法初始 state → A/B/C/DRAW 终局且数据入 replay；唯一 game_id；evaluation/pilot/benchmark/测试不计入）。
2. 13×13 与 17×17 均充分训练（计数分别记录，17×17 ≥ 30%）。
3. A/B/C 三座充分覆盖；每局座位随机。

## 强度门槛（统计）

4. Invitus vs 5★ vs 5★（全座位平衡）：seat-adjusted win rate **95% CI 下界 > 1/3**。
5. 对实测最强 baseline pair：统计显著优势（双尾检验 α=0.05）。
6. 大样本赛 ≥ 数千场（不计入 100k）。

## 质量门槛

7. 100,000/100,000 differential test 与生产引擎一致。
8. exact oracle dataset（几千残局）策略/价值精度达标；value calibration：ECE/Brier/log-loss 报告，无严重过度自信。
9. search scaling：1600/3200 sims ≥ 800 sims 强度（总体单调；异常必须解释）。
10. 无 illegal move、无 crash、无 NaN、无 policy collapse；tactical suite 全过。

## 原项目回归

11. typecheck/test/test:backend/test:ws/build/e2e:local/e2e 全 PASS；Tutorial/Online/Local/BAC/Ranking/Friends 不受影响。

## 判定

- 不满足任一项 → STATUS 只能 PARTIAL/BLOCKED。
- 100k 是最低训练量而非质量证明；达到后按 §35 若仍不达强度标准 → 继续训练或 PARTIAL。
