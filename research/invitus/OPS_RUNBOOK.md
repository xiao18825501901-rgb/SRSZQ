# INVICTUS OPS RUNBOOK（AutoDL GPU · research/invitus）

> 操作手册：从磁盘扩容到 100k 正式训练再到最终验收的每一步真实命令。
> 铁律：formal 只来自 official 命名空间；benchmark/smoke/评估局永不计 formal；
> READY 在通过全部冻结验收前永远是 NO；不动 main、不部署、不触碰生产。

## 0. 前置：磁盘门禁

```
df -h /root/autodl-tmp   # 必须 ≥100GB 可用（推荐 150–200GB）
```
未达标 = `BLOCKED_BY_STORAGE`，禁止启动长跑（launcher 会自行拒绝）。

## 1. 启动 0–5k 段（formal=0 起）

```
cd /root/SRSZQ/research/invitus
screen -L -Logfile /root/autodl-tmp/invitus/official.log -dmS invitus_official \
  bash -lc 'training/official_launcher.sh /root/autodl-tmp/invitus/official 5000 \
    --sims 16 --workers 20 --games-per-wave 8 --steps-per-wave 8 --batch 128 \
    --compile-model --history-dir /root/autodl-tmp/invitus/backup_staging/history/checkpoints'
```
- launcher：段内崩溃自动 `--resume latest` 重试 ≤5 次（60s 退避）；磁盘 <100G 拒绝；STOP 文件则优雅停止。
- 监控：`screen -r invitus_official`；`tail -f /root/autodl-tmp/invitus/official.log`；`tail -f /root/autodl-tmp/invitus/official/logs/launcher.log`。

## 2. 每个 500 局（训练循环自动执行）

```
cd /root/SRSZQ/research/invitus
python3 -m training.audit_training_state --root /root/autodl-tmp/invitus/official
# 要求 FORMAL_LEDGER_COUNT == CHECKPOINT_EPISODE_COUNT == 500 的倍数，STATE_CONSISTENT=true
```
不一致时训练循环自身会熔断退出。

## 3. 每个 5000 局（major，循环自动存盘+备份；人工执行评估）

```
# champion gate（座位平衡，60+ 局/对阵起，正式用数百局）
python3 -m eval.champion_gate \
  --candidate /root/autodl-tmp/invitus/official/checkpoints/invitus_005000_major.pt \
  --champion /root/autodl-tmp/invitus/official/checkpoints/<champion>.pt \
  --data-root /root/autodl-tmp/invitus/official \
  --games-per-matchup 120 --sims 16 --threads 8 --promote

# exact 一致性探针（>=2000 位置，最终验收用 5000）
python3 -m eval.exact_oracle --replay-dir /root/autodl-tmp/invitus/official/replay \
  --out /root/autodl-tmp/invitus/official/evaluations/oracle.jsonl --max-positions 2000
python3 -m eval.exact_agree --oracle .../oracle.jsonl \
  --checkpoint .../invitus_005000_major.pt --out .../agree_005000.json --sims 16
```
晋升规则：vs champion 对 seat-adjusted 胜率 CI95 下界 >1/3 或 p<0.05（内部闸门；冻结验收另有标准）。

## 4. sims curriculum（5k/20k/50k 节点，按实测强度决定）

```
# 每档先用 champion gate + exact_agree 比较 16/24/32 sims 的强度与质量，再决定是否升级
python3 -m eval.search_scaling --checkpoint .../invitus_XXXXX_major.pt \
  --data-root /root/autodl-tmp/invitus/official --sims-levels 16,24,32 \
  --games-per-matchup 60 --out .../scaling_XXXXX.json
```
下一段（示例 5k→20k 升 24 sims）：

```
screen -dmS invitus_official2 bash -lc 'training/official_launcher.sh \
  /root/autodl-tmp/invitus/official 20000 --sims 24 --workers 20 ...'
```

## 5. 100k 达成后

1. 停训（`touch /root/autodl-tmp/invitus/official/logs/STOP`），保存 100K snapshot。
2. Champion selection：对 80k/85k/90k/95k/100k majors 逐个跑 champion gate（每对 ≥3000 局，关键对阵建议 3000+）。
3. Final tournament（champion 对 5★+5★、maxn+maxn、5★+maxn、historical champion；A/B/C 平衡；数千局）→ 冻结验收：vs 5★+5★ seat-adjusted CI95 下界 >1/3 且 vs strongest baseline p<0.05。
4. Exact oracle ≥2000（最好 5000）+ calibration（Brier/LogLoss/ECE × 13/17 × A/B/C）+ search scaling（100–3200 sims）。
5. 原项目回归门禁：`npm run typecheck` / `test` / `test:backend` / `test:ws` / `build` / `e2e:local` / `e2e`（Windows 下用 node+tsx 直跑）。
6. 全部通过后才允许写 READY=YES（此前固定 `READY NO`）。

## 6. 备份与成本

- 每 5000：major 已自动 staging 到 `official/backups/major/`（sha256 manifest）；外部持久备份：**EXTERNAL_BACKUP=NOT_CONFIGURED**，需要时另行配置（AutoDL 盘不是备份）。
- 成本：~¥7.35/h；100k ETA 三档 150/200/260h（见 INVICTUS_GPU_MIGRATION_REPORT.md）。

## 7. 异常处理

| 症状 | 处理 |
|---|---|
| launcher 输出 BLOCKED_BY_STORAGE | 扩容数据盘 ≥100GB |
| SEGMENT_FAILED | 看 launcher.log 最后 rc 与 official.log 堆栈，修复后重跑 launcher（resume 保证计数不丢） |
| STATE_CONSISTENT=false | 停训；用 audit 输出定位（ledger/replay/checkpoint 断层），修复前不得 resume |
| GPU 掉线/容器重启 | AutoDL 实例重启后重跑 launcher；screen 会话需重建 |
| STOP 优雅停 | 保存 final.pt 与 summary 后退出；继续时直接再跑 launcher |
