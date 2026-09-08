# INVICTUS_BASELINE_REPORT

> 用生产 tactic 引擎（scripts/ai-selfplay.ts，真实决策层）跑的小样本基线（每组合 2 局 ×6 组合 ×13/17）。

## 13×13（12 局，wall 33s）

- 各 tactic 表现：**maxn** 全胜占比最高（100% 于所在局）、3ply 次之；random 0%；seat C 合计 9/12 胜 → 座位优势明显（C 先获胜权）。
- 决策延迟：maxn avgThink≈294ms、3ply≈222ms、random≈0ms；avgMoves≈20–23。

## 17×17（12 局，待完成输出）

- 见 results/selfplay-*.json（本轮另跑）。

## 结论（冻结）

- **CURRENT_STRONGEST_BASELINE（待更大样本确认前）＝ maxn（5★）**；正式验收对手对：
  - 5★ + 5★
  - maxn + maxn（strongest baseline pair）
- 样本量小（每组合 2 局）仅作早期基线；正式大样本赛见 FINAL BENCHMARK（数千局，全座位平衡）。

## 数据文件

- results/selfplay-2026-09-08T05-45-22-692Z.json（13×13）
- results/selfplay-*.json（17×17）
