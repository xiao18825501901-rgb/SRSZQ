# INVICTUS_FINAL_REPORT（Phase 2 更新）

# 1 STATUS

**PARTIAL / BLOCKED_BY_COMPUTE**（formal <100,000；本机 CPU ETA 30–52 天；神经网络与训练管线已真实运行、计数在增长，但未达 READY 门槛。）

# 2 Training Count

- Completed **formal** Training Episodes：**smoke 24 + 后台持续增长**（每次提交时用 verify_training_ledger.py 复算；唯一 game_id、completed、samples>0 才计）
- Pilot（不计入）：2
- **FORMAL TRAINING: xxxxx / 100000+**（实时见 INVICTUS_TRAINING_PROGRESS.md 与 logs/INVICTUS_TRAINING_LEDGER.jsonl）

# 3 Champion Checkpoint

无（未到 champion 阶段）。

# 4 Model Architecture

`model/network.py` InvitusNet：16 通道统一 17×17 输入（A/B/C 石、actor、胜权 A/B/C/无、forbidden mask、active mask、棋盘尺寸 flag、turn phase）→ Tiny(32ch/4blk，默认)/Small/Medium 可选 → policy 289 logits（合法 mask 后 softmax）+ value 4-way softmax [A,B,C,DRAW]。**无 [-1,+1] scalar**。device=cuda/cpu 自适应。

# 5 MCTS Architecture

`mcts/nn_mcts.py`：actor-aware PUCT + 向量 backup；叶值=网络 value（exact region → 精确向量）；训练 root Dirichlet + 早局 temperature；评估 noise 关、temperature=0。policy 永不含非法步（mask 后再 softmax）。

# 6 Multi-player Value Design

[A,B,C,DRAW] 4 元；value loss 用 4 元 CE；MCTS W_ABCD 向量。

# 7 Exact Solver

上轮实现（D4 canonical + TT + 无启发穷举）；本轮接入 NNMCTS 叶（in_exact_region → exact）。max_branch 6/8/10/12 性能与 oracle dataset（2000–5000 残局）待 GPU/后续批次生成。

# 8 Hardware

CPU-only（见 INVICTUS_HARDWARE_REPORT.md / INVICTUS_COMPUTE_SCALING_REPORT.md）。

# 9 Training Time

已运行：smoke 20+resume 4=24 局；正式训练后台持续运行中；games/hour ≈ 70–140（sims 8–16）。

# 10 Training Curves

见训练进程日志（每 wave 打印 pl/vl/loss/gn）；初期 pl≈5.0、vl≈1.0–1.3 有限无 NaN。

# 11 Baseline Results

见 INVICTUS_BASELINE_REPORT.md：maxn 暂为 strongest baseline；13×13 小样本完成、17×17 完成中；seat C 优势明显。

# 12 13×13 Results / # 13 17×17 Results

训练中（60/40 采样；已出现 17×17 样本）。

# 14 Seat Analysis

self-play 三座全 Invitus；座位影响将在最终大样本赛评估。

# 15 Value Calibration / # 16 Search Scaling / # 17 Exact Oracle Accuracy

待训练达标后（100k 后必做）。

# 18 Final Win Rates

无。

# 19 Known Weaknesses

- CPU 吞吐不足：sims=16 时 ~70–90 局/时 → 100k 需 30–52 天（GPU 迁移计划见 COMPUTE_SCALING）。
- league 当前为 invitus×3 简化版（TS tactics 桥接未接，避免每步子进程开销）；后续按 50/20/20/10 采样扩展。
- 训练早期价值学习慢（vl≈ln4 附近），属正常冷启动。

# 20 Files Changed（本阶段新增）

model/network.py · model/encode.py · mcts/nn_mcts.py · training/replay.py · training/train.py · training/verify_training_ledger.py（升级硬约束）· INVICTUS_{BASELINE_REPORT,TRAINING_PROGRESS,COMPUTE_SCALING_REPORT}.md · 更新本文件。

# 21 Git SHAs

research/invitus（基于 87e6c58）；本阶段提交见 git log。未 merge main、未部署。

# 22 Reproduction Commands

见 INVICTUS_TRAINING_PROGRESS.md「Resume 命令」。

# 23 Integration Plan

不变：READY 后 ONNX→后端/Node；此前不合并不部署。

# 24 Rollback Plan

研究分支独立；删除分支即回滚；生产零影响。

# 25 重要声明

- **INVICTUS IS NOT TRAINED YET.**
- 不满足：formal≥100000、17×17≥30%、大样本统计显著、exact oracle、calibration、search scaling → 按冻结的 ACCEPTANCE_CRITERIA 判 PARTIAL/BLOCKED，绝不写 READY。
