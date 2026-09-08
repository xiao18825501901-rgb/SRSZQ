# INVICTUS_FINAL_REPORT（Phase 3B 更新）

# 1 STATUS

**TRAINING IN PROGRESS**（official formal 正在增长：2026-09-08T16:19Z 启动；数据盘已扩至 110G，DISK_GATE=PASS。距离 READY 尚远，READY 保持 NO。）

# 2 Training Count

- **OFFICIAL FORMAL TRAINING: RUNNING，从 0 增长（目标 100000）**，实时数见 ledger 与 TRAINING_PROGRESS。
- CPU 历史 118 局（含 pilot 2 局）已封存为 historical evidence，**不计数**。
- GPU benchmark/smoke（12/20/100/500 局）全部 formal=false，**不计数**。
- 官方命名空间 `/root/autodl-tmp/invitus/official`；每 500 局 audit 复算（唯一 game_id、completed、samples>0 才计）。

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

AutoDL NVIDIA RTX 6000D（85,651 MiB VRAM，driver 595.71.05 / CUDA 13.2，torch 2.12.1+cu130）；~22 核 / ~1TB RAM；数据盘 /root/autodl-tmp 50G（待扩容 ≥100G）。详见 INVICTUS_GPU_MIGRATION_REPORT.md。

# 9 Training Time

未启动 official 训练（formal=0）。实测吞吐：16 sims ≈ 2507 局/时（500 局 benchmark 全量）；ETA 三档见 GPU_MIGRATION_REPORT（BEST ~150h / EXPECTED ~200h / CONSERVATIVE ~260h，¥7.35/h）。

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

# 19 Known Weaknesses / Blockers

- **BLOCKED_BY_STORAGE**：/root/autodl-tmp 50G < 100G 冻结门槛；等待扩容后启动官方长跑。
- GPU 利用率仅 ~5.7%（瓶颈在 Python/MCTS/IPC，非 GPU 算力）；已记录为后续优化项，不因此升级更贵 GPU。
- 训练早期价值学习慢（vl≈ln4 附近）属正常冷启动；champion gate 将用实测强度判定 sims curriculum。

# 20 Files Changed（Phase 3B 新增）

training/official.py · training/benchmark.py · training/process_selfplay.py · training/league.py · training/audit_training_state.py · inference/process_service.py · eval/{match,champion_gate,exact_oracle,exact_agree}.py · tools/tactic_worker.ts · INVICTUS_GPU_MIGRATION_{PLAN,SPEC,REPORT}.md · 更新 TRAINING_PROGRESS 与本文件。

# 21 Git SHAs

research/invitus：6a80263（500 局报告）、1cefcb5（官方入口）、0c6fcc3（champion gate）、fe65014（exact 探针）。未 merge main、未部署、未触碰生产。

# 22 Reproduction Commands

见 INVICTUS_TRAINING_PROGRESS.md「官方训练启动命令」（GPU，training/official.py；评估用 eval/champion_gate.py、eval/exact_oracle.py、eval/exact_agree.py）。

# 23 Integration Plan

不变：READY 后 ONNX→后端/Node；此前不合并不部署。

# 24 Rollback Plan

研究分支独立；删除分支即回滚；生产零影响。

# 25 重要声明

```
FORMAL 0/100000
13x13: N/A（官方未启动；benchmark 58.8%）
17x17: N/A（官方未启动；benchmark 41.2%）
LATEST CHECKPOINT: 无 official checkpoint
CURRENT CHAMPION: 无
LEAGUE: COMPLETE（50/20/20/10，benchmark 0 fallback）
GAMES/HOUR: 2507（16 sims，benchmark 实测）
ETA: 扩容后 ~150–260h
TRAINING HEALTH: 未启动
FINAL EVAL: 未执行
READY NO
INVICTUS IS NOT TRAINED YET.
```

- formal<100000 → **READY=NO**。
- 不满足：formal≥100000、17×17≥30%、大样本统计显著、exact oracle、calibration、search scaling → 按冻结的 ACCEPTANCE_CRITERIA 判 PARTIAL/BLOCKED，绝不写 READY。
