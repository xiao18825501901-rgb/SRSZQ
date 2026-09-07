# INVICTUS_FINAL_REPORT（阶段报告 · 进行中）

# 1 STATUS

**PARTIAL**（研究前中期完成；未达 100,000 formal training episodes；未做最终基准；不 READY。）

# 2 Training Count

- Completed **formal** Training Episodes: **0**
- Pilot（rollout-MCTS，不计入 formal 100k）: **2**（ledger 已验证：unique 2 / duplicates 0）
- 说明：正式训练 = 数据进入 neural replay/training pipeline 的完整对局；当前 neural 训练循环尚未启动，因此正式计数为 0。

# 3 Champion Checkpoint

无（尚无 trained checkpoint）。

# 4 Model Architecture

设计见 INVICTUS_ARCHITECTURE.md（Residual CNN + 4-way value + policy mask；未训练）。

# 5 MCTS Architecture

已实现 Python 多玩家 PUCT（actor-aware Q+U、向量 W_ABCD backup、root Dirichlet 可选、temperature、exact 叶集成）——单测覆盖合法/稳定/seed 可复现。bug 修复记录：visits 方向、扩展时机、rollout 不污染叶状态。

# 6 Multi-player Value Design

[A,B,C,DRAW] 4 元向量；exact solver 输出 MaxN 精确向量（和=1 已测）。

# 7 Exact Solver

已实现（D4 canonical key + TT + 无启发穷举 + best_move 最优性自检）；单测：立即胜/小残局精确求解 PASS。max_branch 性能实验（6/8/10/12）与 oracle dataset 批量生成待跑。

# 8 Hardware

见 INVICTUS_HARDWARE_REPORT.md：i7-13620H 10C/16T · 15.7GB RAM · **无 CUDA（torch CPU）** · 磁盘 15.3GB → CPU fallback，小网络/小 batch/≤2 worker。

# 9 Training Time

尚未开始 formal 训练；pilot 2 局（13×13、sims=4）完成，速度受 CPU 限制（每局数十秒级）。

# 10 Training Curves

无（0 正式局）。

# 11 Baseline Results

待跑（scripts/ai:selfplay、ai:benchmark 或新评估脚本；13/17、全座位、win/draw/时长/延迟/座位优势）。

# 12 13×13 Results / # 13 17×17 Results

待训练后。

# 14 Seat Analysis

pilot 2 局均为 A_WIN（样本量 2，无统计意义；座位优势需大样本）。

# 15 Value Calibration / # 16 Search Scaling / # 17 Exact Oracle Accuracy

待 NN 训练后；exact solver 正确性已由单测 + 100k differential 间接覆盖。

# 18 Final Win Rates

无。

# 19 Known Weaknesses

- 纯 Python MCTS/rollout 慢（CPU-only）：需 numpy 向量化/限制 rollout 深度/batch。
- exact solver 的 pass 链在极端残局可能触发多次 O(n²) 扫描（已按生产语义加 boardSize² 保护）。
- 尚无神经网络与训练循环（下一步）。

# 20 Files Changed（本分支）

- research/invitus/INVICTUS_{EXISTING_AI_AUDIT,HARDWARE_REPORT,ARCHITECTURE,ACCEPTANCE_CRITERIA,FINAL_REPORT}.md
- research/invitus/engine/srszq.py（Python 引擎；**100,000/100,000 differential 与生产引擎一致**）
- research/invitus/tools/gen_diff_cases.ts · diff_check.py
- research/invitus/exact/solver.py · mcts/mcts.py · selfplay/selfplay.py · training/verify_training_ledger.py · tests/run_all.py（6/6 PASS）· logs/

# 21 Git SHAs

分支 research/invitus（基于 main 2752d29）；提交见 git log（未 merge、未部署）。

# 22 Reproduction Commands

```
npx tsx research/invitus/tools/gen_diff_cases.ts 100000 research/invitus/logs/diff_100k.jsonl
python research/invitus/tools/diff_check.py research/invitus/logs/diff_100k.jsonl   # TOTAL 100000 MISMATCH 0
python research/invitus/tests/run_all.py                                            # 6/6
python research/invitus/selfplay/selfplay.py <games> <sims>
python research/invitus/training/verify_training_ledger.py <ledger>
```

# 23 Integration Plan

READY 后：ONNX 导出 → 后端/Node 推理 → HvAI/Online 可选接入 → 与 5 tactics 并存；此前不合并、不部署。

# 24 Rollback Plan

研究分支独立：放弃=删除分支；主仓库不受影响（未改 main、未动生产/DB/Caddy）。
