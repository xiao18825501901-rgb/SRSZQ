# INVICTUS_HARDWARE_REPORT

生成时间：本会话（Asia/Shanghai）。分支：research/invitus。

## 机器

| 项 | 实测 |
|---|---|
| CPU | 13th Gen Intel Core i7-13620H · 10 物理核 / 16 线程 |
| RAM | 15.7 GB 总量（采样时仅 ~2.0 GB 空闲） |
| GPU | Intel UHD Graphics（核显 ~2GB，无 CUDA）；SuperDisplay 虚拟适配器 |
| Disk | C: 空闲 15.3 GB |
| OS | Windows（PowerShell 环境） |

## 软件

| 项 | 状态 |
|---|---|
| Python | 3.11.0（C:\Python311） |
| PyTorch | 2.12.1 **+cpu（CUDA=False）** |
| numpy | 2.2.1 |
| pip | 26.0.1 |
| Node | v24（生产 shared engine / tsx） |

## 结论与配置决策

- **无 CUDA**：Invitus 全部训练/推理走 **CPU fallback**。
- 内存紧张（2GB 空闲）：不能同时开大 replay buffer + 大 batch 训练 + 多 worker；采用**小网络 + 小 batch + 单/双 worker** 起步，逐 2500 局落盘 checkpoint 并释放内存。
- 核数 16T：self-play worker ≤ 2（每 worker MCTS 64–128 sims 起步）；exact solver 与训练进程分时。
- 磁盘 15.3GB：checkpoint/日志压缩存储；ledger 为追加 JSONL。
- 100k 训练局在 CPU-only 上为多日级任务：按 §17 分阶段渐进；本机以正确性优先，先验证 pipeline 再滚动训练；**训练局数以 ledger 唯一 game_id 实计，不夸大**。
