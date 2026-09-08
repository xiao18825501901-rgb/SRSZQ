# INVICTUS_TRAINING_PROGRESS

> 实时进度（Phase 3B，GPU 迁移后）。formal 计数规则：official 命名空间 ledger 中 completed + formal + 唯一 game_id + samples>0。
> CPU 历史 118 局、pilot 2 局、benchmark/smoke 全部**不计入** official 100k。

| 项 | 值 |
|---|---|
| OFFICIAL FORMAL | **0 / 100000**（干净官方命名空间尚未启动） |
| CPU 历史证据 | 118 局 formal（已封存为 historical evidence，仅作历史对手/研究证据） |
| 500-game GPU benchmark | 500/500，GPH **2507.1**，COMPUTE_GATE=GREEN（formal=false） |
| 13×13 / 17×17 | 官方采样 60% / 40%（benchmark 实测 294/206） |
| 冻结官方配置 | Small 64×6 · 20 进程 · batch 128 · 16 sims · FP32 · torch.compile |
| Latest checkpoint | 无 official checkpoint（formal=0） |
| Current champion | 无（champion gate 工具就绪，5k 起启用） |
| League | 50% self / 20% historical / 20% strong / 10% diverse（persistent Node worker，benchmark 0 fallback） |
| games/hour（GPU） | 16 sims ≈ 2507；32 sims ≈ 996；64 sims ≈ 407（实测） |
| ETA to 100k | BEST ~150h / EXPECTED ~200h / CONSERVATIVE ~260h（动态 curriculum，见 GPU_MIGRATION_REPORT） |
| Disk | /root/autodl-tmp 50G → **DISK_GATE FAIL**（需 ≥100G，推荐 150–200G） |
| 健康监控 | 每波 loss/gn/磁盘/inference/bridge 异常熔断；每 500 审计；每 5000 major+备份 |

## 官方训练启动命令（扩容完成后）

```
cd /root/SRSZQ/research/invitus
screen -L -Logfile /root/autodl-tmp/invitus/official.log -dmS invitus_official bash -lc 'cd /root/SRSZQ/research/invitus && PYTHONUNBUFFERED=1 python3 -m training.official --episodes 5000 --sims 16 --workers 20 --games-per-wave 8 --steps-per-wave 8 --batch 128 --compile-model --data-root /root/autodl-tmp/invitus/official --history-dir /root/autodl-tmp/invitus/backup_staging/history/checkpoints --min-free-gib 100 --run-id invitus-small-v1'
```

Resume（每段后续）：

```
python3 -m training.official --episodes 100000 --sims 24 ... --data-root /root/autodl-tmp/invitus/official --resume latest
```

验证（每 500 由训练循环自动执行，可手动复核）：

```
cd /root/SRSZQ/research/invitus && python3 -m training.audit_training_state --root /root/autodl-tmp/invitus/official
```

## 状态

- GPU 迁移：**PASS**（500 局 benchmark GREEN、checkpoint resume PASS、0 错误）
- 官方训练入口：**PASS**（GPU 冒烟 4/4 formal、STATE_CONSISTENT=true；resume 链 4→6 验证通过）
- 评估链（champion gate / exact oracle / exact agreement / calibration / search scaling）：**PASS**（GPU 冒烟通过）
- 原项目回归基线（Windows）：**PASS 5/5**（typecheck · 149/149 tests · backend · ws · build；e2e 留最终验收）
- 正式训练：**NOT STARTED — BLOCKED_BY_STORAGE**（数据盘 50G < 100G 冻结门槛；扩容中/待确认实例状态）
- **INVICTUS IS NOT TRAINED YET.**
