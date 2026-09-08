# INVICTUS_COMPUTE_SCALING_REPORT

> 依据 §29：先实测 games/hour，估算 100k ETA；若数量级不可接受则如实报告并给 GPU 迁移方案。

## 实测（本机 CPU-only）

- 硬件：i7-13620H 10C/16T · 15.7GB RAM（空闲 ~2GB）· torch 2.12.1 **CPU** · 磁盘空闲 ~15GB。
- Smoke（Tiny 网络 32ch/4blocks，13/17 混合 60/40）：
  - sims=8、workers=2：**≈140 games/hour**
  - sims=16（正式配置，workers=2，与基线脚本竞争时更慢）：预估 **≈70–90 games/hour**
- 每局样本：~40–160 个（随局长变化）；replay 分片 64 片 ×512 样本，磁盘占用可控。

## 100k ETA

- 按 80 games/hour：100,000 / 80 ≈ **1,250 小时 ≈ 52 天**（单机连续跑）。
- 即使 sims=8 全速（140/h）：≈ 30 天。
- **结论：本机 CPU 无法在本轮会话内完成 100k；按 §29 判定为 BLOCKED_BY_COMPUTE（不伪造计数）。**

## GPU 迁移方案（保持可复现）

- 代码已 `device = cuda if available else cpu`；checkpoint 仅 state_dict + 元数据，CPU/GPU 互读。
- 推荐：单卡 RTX 4090 / A100（或云：AutoDL/Vast/阿里云 ECS GPU）。
  - 预期 speedup：MCTS 推理从 CPU 单线程 ~3–6ms/leaf → GPU batch 后 <0.2ms/leaf；总体 **30–80×**。
  - 4090（24GB）可跑 Medium（96ch/8blk），batch 256–512；games/hour 预计 **2,000–6,000** → 100k ETA **17–50 小时**。
  - VRAM 最低需求（Tiny b=128）：<4GB；Medium b=512：<12GB。
- 迁移步骤：`pip install torch --index-url https://download.pytorch.org/whl/cu121` → 直接 `python training/train.py --resume latest`（checkpoint 自动落到 GPU；路径用相对路径，未写死 Windows）。
- 云端运行清单：git clone 分支 → 安装依赖 → 拷贝 `checkpoints/` 与 `logs/INVICTUS_TRAINING_LEDGER.jsonl`（或从空继续，但计数不得重复/伪造）→ 后台跑 → 每 5000 局校验 `verify_training_ledger.py`。

## 磁盘保护

- replay 轮转（64 片上限）、checkpoint 每 500 局（Tiny ~1MB/个）；空闲 <8GB 时停止新增 checkpoint（当前 15GB，短期安全）。

## 现状

- formal training 已实际启动并持续运行（后台），counter 真实增长；本报告随 INVICTUS_TRAINING_PROGRESS.md 持续更新 gph/ETA。
- **100k 完整训练需 GPU 或数周级 CPU 挂机；此前 STATUS 不能高于 PARTIAL/BLOCKED_BY_COMPUTE。**
