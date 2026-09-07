# INVICTUS_ARCHITECTURE

> 分支 research/invitus。本文冻结 Invitus 设计（不承诺 perfect/solved）。

## 1. 状态空间与可行性

- 13×13=169 格：状态上界 ≈ 4^169 ≈ 1.0×10^102；17×17=289 格 ≈ 4^289 ≈ 10^174 → **不可能穷举**。
- 结论（不夸大）：一般局面用 Neural Policy/Value + MCTS 近似最优；可穷举残局（合法步 ≤ N）用 Exact Solver 给真值。绝不写 SOLVED/PERFECT。

## 2. 多人价值设计

- Value head：4 元分布 **[P(A), P(B), P(C), P(DRAW)]**，sum≈1（softmax），非二人 scalar。
- 终局标签：A 胜=(1,0,0,0)，B=(0,1,0,0)，C=(0,0,1,0)，DRAW=(0,0,0,1)。
- MCTS 节点：N, W_ABCD, Q_ABCD, P(s,a)；selection 用 **actor-aware** Q_actor+U（默认 MaxN-style 向量 backup；训练中可实验 paranoid/scalar-root 对比）。

## 3. Network

- Residual CNN（AlphaZero 式）：输入 planes（A/B/C stones、turn phase、victory-right A/B/C/None、last move、forbidden mask、board 尺寸无关的统一 17×17 零填充或双头），policy head=每格 logit（非法严格 mask），value head=4-way softmax。
- 双尺寸：先做 unified FC model（17×17 输入、13×13 居中等价嵌入），与 13/17 双专模 bench 对比后定。
- 规模：Small/Medium/Large 三档，CPU-only 下先 Small。

## 4. MCTS

- PUCT：Q_actor + c_puct·P·√N_parent/(1+N_child)；root Dirichlet noise（训练）；推理关闭；temperature 早高晚 0；Strong 模式 temperature=0 选 visit/期望最优。
- 大分支：full expansion 起步；bench progressive widening/batch inference/virtual loss（后续阶段）。
- Leaf 进入 exact region → 直接回精确向量。

## 5. Exact Endgame Solver

- research/invitus/exact/solver.py：D4 对称 canonical key（含完整 turn/status/winner）TT、MaxN 精确 backup、terminal 检测；仅 legal ≤ N（实验定 6/8/10/12）；**无启发剪枝**。

## 6. 训练

- Self-play Invitus×3 + Opponent League（5 tactics、1–5★、历史 checkpoint）；座位每局随机 A/B/C；D4 几何对称增强（不做玩家身份置换——BAC 无该对称性）。
- Replay：state/legal mask/visit dist/outcome/actor/boardSize/round/checkpoint id；防只学战术态。
- Loss = policy CE(MCTS visits) + value CE(终局分布) + L2。
- 课程：PHASE0-5，13×13 60% / 17×17 40% 起步（按 bench 调）；模拟预算 64-128 → 400-800+；checkpoint 每 2500-5000 局（含 optimizer/rng/计数，支持 resume）。
- Ledger：INVICTUS_TRAINING_LEDGER.jsonl + verify_training_ledger.py（唯一 game_id；evaluation/benchmark/pilot 不计入 formal 100k）。

## 7. 性能（CPU-only）

- 本机无 CUDA：torch CPU；self-play ≤2 worker；batch 小；exact 与训练分时；13/17 分别测 latency/nodes/s、memory。

## 8. 集成（未来，READY 后）

- 导出 ONNX → Node/后端推理；浏览器 Web Worker 可选；Strong/Standard 两档 sims；不部署直到 FINAL BENCHMARK 达标。
