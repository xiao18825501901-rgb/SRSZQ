# INVICTUS COLLAPSE RECOVERY — V2 REPLICATION

> 新 GPU 服务器（weste:45082）双 seed 干净复现，2026-09-11。

## SERVER

```
GPU:       NVIDIA RTX 6000D, 85,651 MiB, driver 595.71.05
CPU:       208 cores（共享宿主）
RAM:       ~1 TB
DATA DISK: /root/autodl-tmp = 50G（scratch 实验；official_v2 前需 ≥100G 扩容）
PyTorch:   2.12.1+cu130（cuda available, sm_120）
Git SHA:   0139eaf（origin/research/invitus；含全部修复与测试）
Repo:      git bundle 恢复（SHA 校验一致），node/tsx 自装，tactic worker 冒烟 PASS
```

## V2 REPLICA A（seed 20260908，2000 局）

```
Entropy: @200→1.953 @400→1.582 @600→1.504 @800→1.052 @1000→0.960
         @1200→0.772 @1400→0.665 @1600→0.698 @1800→0.624 @2000→0.507
Slope 200: -0.00058/game    Slope 400: -0.00048    Slope 800: -0.00033（减速，无二次坍塌）
Target/Visit entropy（eval 模式）: 0.364/0.270 (13) · 0.588/0.374 (17)
Top1 prior: 未接近 0.999（eval 熵 0.36–0.59）
Opening diversity: 3ply 8 unique / 6ply 18 / 9ply 25（top-1 10%）vs 坍塌版 2/120
Value 预测: [A 0.006, B 0.069, C 0.925] vs 训练实际 C 46.3%（末段 55.6%）→ C 过锐化 ~1.7×
30 局自对弈 outcome: A11 / B10 / C9（平衡）
Strength: vs random 56.7% (CI 0.39–0.73) · vs 3★ 0/30 · vs maxn 0/30
Collapse sentinel: NOT TRIGGERED（熵全程 >0.5@2000；无 NaN/illegal）
```

## V2 REPLICA B（seed 20260909，2000 局）

```
Entropy: @200→1.997 @400→1.649 @600→1.184 @800→1.012 @1000→0.836
         @1200→0.965 @1400→0.620 @1600→0.763 @1800→0.530 @2000→0.689
Target/Visit entropy: 0.599/0.518 (13) · 0.691/0.440 (17)
Opening diversity: 3ply 8 / 6ply 14 / 9ply 20 unique（top-1 13%）
Value 预测: [A 0.746, B 0.226, C 0.028] vs 训练实际 A 40.4%（末段 48%）→ A 过锐化 ~1.6×
30 局自对弈 outcome: A25 / B5 / C0（自对弈均衡向 A 倾斜）
Strength: vs random 56.7% · vs 3★ 0/30 · vs maxn 0/30（与 A 完全一致——复现性好）
Collapse sentinel: NOT TRIGGERED
```

## REPLICATION VERDICT

```
V2:                 PASS（政策防坍塌修复，双 seed 可复现）
REPRODUCIBLE:       YES（熵曲线形状一致：早期高熵→缓降→2K 收敛于 0.5–0.7）
POLICY_COLLAPSE:    NO（对比 broken v1 的 0.013 熵 / 2 种开局 / 900 局 0 胜）
SEARCH_HEALTH:      待 exact agreement 三档（oracle 生成中，159/200）
VALUE_SEAT_BIAS:    MEDIUM（两复现均出现 majority-class 过锐化 ~1.5–1.7×，方向随 seed 不同）
EXACT_PIPELINE:     合成 oracle 管线已建（max-branch 8 + 200k 节点预算），数据生成中
RECOMMEND:          RUN_V3（value label smoothing 0.1，已启动 v3-a）→ 通过后 OFFICIAL_RESTART
READY:              NO
```

## 判据明细（用户 §20 标准）

| 判据 | A | B |
|---|---|---|
| A. entropy@2000 ≥0.5 | PASS 0.507（压线） | PASS 0.689 |
| B. 无快速二次下降 | PASS（slope 递减） | PASS |
| C. visit entropy >0 | PASS | PASS |
| D. opening diversity 明显高于 broken v1 | PASS（25 vs 2） | PASS（20 vs 2） |
| E. top1 prior 不接近 0.999 | PASS | PASS |
| F/G. no NaN / illegal | PASS | PASS |
| H. value 非固定座位预测器 | **FAIL**（0.925C vs 0.46） | **BORDERLINE**（0.746A vs 0.40，方向对但过锐） |
| I. 非 0 胜率 | PASS（random 56.7%） | PASS |

## 下一步（已在执行）

1. **v3-a**：v2 配置 + `--value-smooth 0.1`（value 标签平滑，防多数类坍缩），2000 局进行中（seed 20260910）。
2. oracle 200 位置补齐 → 对 A/B/v3 的 500/1000/1500/2000 checkpoint 跑 exact agreement 三档（NN top1/top5、MCTS16/24/32）。
3. v3 通过（entropy 复现 + value 校准改善）→ Recovery-vs-Restart 实验 → 冻结 repaired 配置 → 新 official v2（formal=0）。
