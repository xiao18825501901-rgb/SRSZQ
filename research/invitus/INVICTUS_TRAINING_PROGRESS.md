# INVICTUS_TRAINING_PROGRESS

> 实时进度（由训练进程与 verify_training_ledger.py 维护）。formal 计数规则：completed + formal + 唯一 game_id + samples>0。

| 项 | 值 |
|---|---|
| Formal Episodes（unique completed） | **正在增长**（见 ledger；smoke 阶段 24，正式训练后台持续累加） |
| 13×13 / 17×17 | 60% / 40% 采样（ledger 已见 13:14 / 17:10） |
| A/B/C seat counts | 三座均为 Invitus self-play（v1 league 简版：invitus×3 + 预留 tactics 桥接） |
| Latest checkpoint | checkpoints/invitus_000020.pt（及运行中每 500 局落盘） |
| Current champion | 无（尚无 trained champion） |
| Loss | policy≈5.0、value≈1.0–1.3（初期，随训练下降） |
| games/hour | ≈140（sims=8, 2w）；sims=16 ≈70–90（实测中） |
| ETA to 100k | CPU ≈ 30–52 天（见 INVICTUS_COMPUTE_SCALING_REPORT.md）→ 需 GPU |
| Disk / Memory | replay 轮转 ≤64 片；checkpoint ~1MB/500 局；空闲阈值 8GB 保护 |

## Resume 命令

```
cd research/invitus
python training/train.py --episodes 100000 --sims 16 --workers 2 --games-per-wave 8 --steps-per-wave 8 --batch 128 --cp-every 500 --resume latest
python training/verify_training_ledger.py logs/INVICTUS_TRAINING_LEDGER.jsonl
```

## 状态

- 神经训练：**PASS**（loss 有限、无 NaN、checkpoint/resume 验证通过）
- 正式训练：**RUNNING（后台，counter 真实增长）**；完成度 << 100k
- **INVICTUS IS NOT TRAINED YET.**
