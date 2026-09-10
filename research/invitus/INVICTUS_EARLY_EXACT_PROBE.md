# INVICTUS_EARLY_EXACT_PROBE（5K 诊断）

## 结果：oracle 为空（0/200 位置）

- Attempted: 0 有效候选（从官方 replay 尾部每局取 4 个样本，要求 legal≤10）
- Solved: 0；agree 三档因此未执行（RuntimeError: oracle empty）
- 根因：坍塌模型的对局过早结束（强对手 5★/maxn 对固定脚本速胜），replay 里几乎没有 legal≤10 的深尾局。

## 对诊断的贡献

「无深局可采」本身就是政策坍塌的独立证据（健康训练应有大量接近终局的对局）。

## 后续改进（已计划）

1. **合成残局生成器**（`eval/exact_oracle.py` 新增 `--synthetic` 模式）：用贪心无四连填充把 13×13/17×17 填到只剩 k∈[4,10] 个空位，随机采样位置 → exact 求解。不依赖对局深度，保证 200+ 独立位置。
2. 10K（修复后训练）重建 oracle：目标 ≥200，记录 attempted/solved/timeout/invalid、13/17 分布、actor 分布、remaining 分布。
3. exact agreement 三档（NN top1/top5、MCTS16/24/32）在健康模型上重做；这是「搜索是否真正帮助决策」的直接证据。
