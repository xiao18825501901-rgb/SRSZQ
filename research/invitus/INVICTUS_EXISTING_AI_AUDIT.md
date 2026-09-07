# INVICTUS_EXISTING_AI_AUDIT

> 分支：research/invitus（不触碰 main/生产）。审计对象：shared/src/ai + backend 调用路径。规则以 shared engine 代码为准。

## 1. Current AI architecture

- 五档 **tactics**（非 agent）：`random`（1★）/ `tactical`（2★）/ `selfish`（3★）/ `3ply`（4★）/ `maxn`（5★）。
- 统一入口 `chooseAIMove(state, player, level, options) -> AIDecision`：读引擎 `getLegalMoves` → 分派到各 tactic → 二次合法性校验（非法→fallback legal[0]）。
- W8 新增内部策略后处理器 `applyDefensePolicy`（Online 1H+2AI 3/4/5★ 保护偏好；HvAI 1H+2AI fastest-threat），由 `MatchPolicyContext` 传入（difficulty 与 policy 分离，NOT PLAYER-FACING）。
- 前端 AI 由 `useAIController` 驱动：Web Worker（`ai.worker.ts`→`chooseAIMove`）+ 主线程兜底；最短展示时长（minDisplayMs）。

## 2. Game state format

`GameState { boardSize: 13|17, board: Cell[][]（A|B|C|null，row 0=顶行）, turnIndex: number(0-based), moves: MoveRecord[], status: 'playing'|'won'|'draw', winner: Player|null, winLine: CellPos[]|null }`。

- 行动顺序固定 **A→B→C→A…**：`playerFromTurn = ['A','B','C'][turnIndex % 3]`；`round = floor(turnIndex/3)+1`。
- BAC：R1–5 `eligible=null`；R≥6 `ELIGIBLE_ORDER[(round-6)%3] = ['C','B','A']`（R6=C, R7=B, R8=A）。
- 胜权获胜：当前行动者 == 本轮胜权者 且 本手形成穿过新子的 ≥4 → 立即 `status='won'`；平局=棋盘满无人胜。

## 3. Legal move pipeline

`getLegalMoves(state)`：所有空格；非胜权者落子若 `createsFourThroughCell` 形成自己 ≥4 → **禁手剔除**（UI 显示 ✕）；胜权者无此限制。`applyMove` 二次校验禁手并推进 turnIndex；无合法步 → `forcePass`/auto-pass 链（Pass 记入 moves）。

## 4. Evaluation methods

- `evaluateBAC`：三人向量效用 [uA,uB,uC]，`patternFeatures`（胜点/活三/半活三/活二/叉/连通）+ BAC 资格距离加权（`roundsUntilEligible`）+ 禁手自陷惩罚；sigmoid 压缩到 (0,1)；终局锚定（胜=1/负=0/和=1/3）。
- `tacticalAgent`：立即胜→堵当前资格对手胜点→预防近 2 轮→造三连/堵三连→中心。
- `selfishAgent`：1-ply 遍历合法步取 `evaluateForPlayer` 最大。
- `3ply/maxn`：MaxN 固定/迭代深度 d3，k 候选剪枝、换位表、叶必胜稳定化。

## 5. Search algorithms

`maxNSearch`（search.ts）：MaxN 向量备份，叶值=evaluateBAC；d3 为实测最佳深度（AI_TUNING_REPORT）。无 MCTS、无学习。

## 6. Performance bottlenecks

- 静态评估 `patternFeatures` O(n²×方向) 每叶一次；selfish 1-ply 在 17×17 每步遍历 ~200+ 合法点 × evaluate → 慢。
- AI 决策预算 `SRSZQ_AI_DELAY_MS` 350 / `aiTimeBudgetMs` 250（backend）、前端 `timeBudgetMs` 档位配置。
- Worker/主线程双通道已存在（可复用于 Invitus 推理集成）。
- 现有 benchmark/selfplay 脚本：`scripts/ai-selfplay.ts`、`scripts/ai-benchmark.ts`（TS，可作基线跑分）。

## 7. Existing benchmark infrastructure

`npm run ai:selfplay` / `ai:benchmark`；`results/` 存 JSON 报告（selfplay/benchmark 历史）。

## 结论（对 Invitus）

- 规则面：引擎自洽且被 131 单测+WS 集成锁定，可直接作为训练引擎 oracle。
- 需要新增：向量 value 网络（4 头）、多人 PUCT MCTS（actor-aware）、exact 残局求解、自对弈+对手联盟训练管线；缺 GPU（CPU-only torch）。
