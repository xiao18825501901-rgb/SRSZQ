# SRSZQ AI — 三人四子棋 BAC 专用人机对弈 AI 技术报告

> 项目：三人四子棋（D:\three-player-connect-four）· 增量功能：BAC 模式 AI 座位
> 版本：SRSZQ-AI-v1 · 报告日期见文末提交记录

## 1. 目标与范围

在既有三人四子棋 Web 应用中**增量**加入 BAC 模式人机对弈 AI（未新增页面、未改动任何规则）：

- 每个座位（A/B/C）可独立选择 人类 或 五档 AI：**Random / Tactical / Selfish / 3-Ply / MaxN**（每座位 6 选 1）；
- 每局 0–2 个 AI、至少 1 名人类玩家（**禁止三 AI** 对网页用户开放；三 AI 仅供内部评测 harness）；
- 所有 AI 与人类**共享同一套规则引擎**（`src/game` 的 `getLegalMoves / applyMove / getEligiblePlayer / checkVictory`），AI 决策 100% 合法；
- BAC-aware：R4=B、R5=A、R6=C 循环；禁手（无资格成四）规则对 AI 与人类一致；
- Web Worker 搜索、异步 AI 行动链、THINKING 状态与棋盘锁定、悔棋到上一人类回合、
  对局日志 AI 标记、导出/导入含座位配置与 AI 统计（旧格式仍可导入）。

## 2. 系统结构

```
src/
├── game/                        # 规则引擎（既有，AI 唯一规则来源，本次仅新增 undoN 原子撤销）
│   ├── rules.ts                 #   applyMove / replayMoves / undoN / importMoves…
│   ├── legalMoves.ts            #   getLegalMoves（禁手过滤）/ getWinningPoints / isLegalMove
│   ├── eligibility.ts           #   BAC: R4=B R5=A R6=C …
│   └── winDetection.ts          #   穿过落子格的 ≥4 判定
├── ai/                          # ★ 新增 AI 层（与页面无关的纯函数，可离线复用）
│   ├── types.ts                 #   AILevel / SeatConfig / AIDecision / AIOptions
│   ├── seats.ts                 #   座位工具（解析/校验/序列化，≥1 人类约束）
│   ├── rng.ts                   #   mulberry32 确定性随机（?seed= 可复现）
│   ├── threatAnalysis.ts        #   线型扫描特征（胜点/双活三/冲三/活二/连通性，gap 桥接）
│   ├── evaluation.ts            #   BAC-aware 评估：utility=sigmoid(加权特征)，terminal 1/0/⅓ 锚定
│   ├── moveOrdering.ts          #   候选生成：引擎合法集 + 禁手过滤 + 胜点/封堵强制集 + 排序剪枝
│   ├── search.ts                #   MaxN 三人搜索：迭代加深 + 换位表 + 时间预算 + 严格同分随机
│   ├── searchAgents.ts          #   3-Ply（maxDepth=3）/ MaxN（ID 至 maxDepth=8）入口
│   ├── randomAgent.ts           #   随机合法点
│   ├── tacticalAgent.ts         #   立即胜 > 堵对方胜点 > 预防将获权者胜点 > 造三/堵三 > 造二 > 中心
│   ├── selfishAgent.ts          #   1-ply：遍历合法点，只最大化自己分量（含资格轮距离权重）
│   ├── chooseAIMove.ts          #   统一入口：座位校验 + 二次合法性校验 + 兜底
│   ├── config/defaultWeights.ts #   一套权重（无座位特化）+ 在线/离线运行预算
│   ├── worker/ai.worker.ts      #   Web Worker 决策（一次请求一个 Worker，terminate 即取消）
│   └── worker/aiWorkerClient.ts #   客户端：jobId/取消/超时安全
├── hooks/useAIController.ts     #   AI 行动控制器：状态监视、串行思考、代数防竞态、最短展示时长
├── components/SeatSetup.tsx     #   座位选择 UI（BAC 专用）
└── App.tsx                      #   接线：座位状态、悔棋语义、导出/导入、PlayerCard/日志标记
scripts/
├── ai-selfplay.ts               #   三 AI 自对弈评测（npm run ai:selfplay）
└── ai-benchmark.ts              #   分档基准评测（npm run ai:benchmark）
```

## 3. 关键设计决策

### 3.1 规则来源唯一性
所有档位的决策候选都来自引擎 `getLegalMoves(state)`（当前行动者视角，已剔除禁手点）。
`chooseAIMove` 在返回前对动作做**第二次引擎合法性校验**；`useAIController` 在落子前做第三次；
最终 `applyMove` 自身仍会拒绝任何非法动作。三层防护下 AI 不可能走出引擎不认可的动作。
（E2E/单测/离线评测均验证 100% 合法，含「无资格 AI 绝不选择禁手成四点」专项断言。）

### 3.2 评估函数（一套权重，无座位特化）
- 特征：几何胜点、双活三/冲三/活二、双胜点(fork)、连通性、己/对方胜点、中心性、禁手自陷惩罚；
- **BAC 资格距离**：`roundsUntilEligible(player)` 将「距自己有资格还有几轮」折入攻防权重
  （R4=B / R5=A / R6=C，每 3 轮一周期）；
- 搜索叶节点效用 = `sigmoid(Σ w·f)`（k=45）映射到 (0,1)，使终局 1/0/⅓ 锚点严格可比较
  （修掉了早期「活局-27 < 输棋 0」的可比性问题）；
- MaxN：当前行动者最大化自己分量；严格同分才随机（保持稳定性），开局多样性来自随机种子。

### 3.3 搜索（3-Ply / MaxN）
- 迭代加深 + 换位表（棋盘+turnIndex 键）+ 候选剪枝（top-K 排序）+ 时间预算；
- 立即胜点、可堵的对方胜点进入「受保护强制集」—— 永不被剪枝；
- 超时回退到**最后一个完整深度**的结果；根节点短接立即获胜；
- 引擎自动 Pass 链内嵌于 `applyMove`，搜索无需显式 Pass 分支。

### 3.4 异步控制器与竞态保护
- 一个 AI 回合 = 一个独立 Web Worker 请求（`terminate()` 即取消，无陈旧结果回写）；
- 代数(generation) + 回合号 + 步数 + 座位快照四重校验，外部动作（悔棋/新棋局/导入/换座位）
  一律作废在途思考；
- 每档设 `minDisplayMs`（220–450ms），快档 AI 也有可感知的 THINKING 展示；
- 状态机只在「当前座位是 AI 且该回合尚未触发」时行动 → 多个 AI 座位天然串行；
- 当前 AI 无合法步（撤销重放后可能）→ 引擎式自动跳过；
- Worker 失败 → 主线程同步小预算兜底，绝不卡死回合。

### 3.5 UI 语义
- AI 座位仅 BAC 模式可选/生效；CBA/CBACC 保持纯人类（回归无行为差异）；
- 悔棋：AI 局 =「悔棋到上一人类回合」（弹出尾部 AI 记录与该人类最后一步，人类重新决策）；
- PlayerCard 显示 HUMAN / 🤖 AI·档位·星级；思考中显示 THINKING 并锁盘；
- 历史日志 AI 步带 🤖AI·档位 标记，debug 模式追加 `[d深度 n节点 耗时ms tt命中 k候选]`；
- 导出 JSON 含 `players` 座位配置与每步 `ai` 决策统计；旧格式（无 players）导入默认全人类。

## 4. 验证矩阵

| 验证层 | 内容 | 结果 |
|---|---|---|
| 单元测试 | 引擎 66 项（回归）+ AI 14 项（合法性扫掠 400+ 局面/档、禁手专项、战术行为） | **80/80 通过** |
| 浏览器 E2E | 原 CBA/CBACC 回归 + AI 场景（座位约束/自动行动/THINKING 锁盘/悔棋到人类回合/导入导出/日志标记/console 0 错误） | **66/66 全部通过**（headless Edge，最终配置复跑） |
| 合法性 | 基准 600 决策 + 自对弈 200+ 局全程 | **非法 0 / 内部兜底 0** |
| 性能基准 | 每档 120 随机 BAC 局面（真实运行，见 AI_BENCHMARK_REPORT.md） | 见基准报告 |
| 自对弈 | 阶梯 + 座位轮转共 200+ 局（真实运行，见 AI_TUNING_REPORT.md） | 见调参报告 |

> 报告中的数字全部来自真实运行输出（results/ 目录留有 JSON 存档，命令可重跑），无模拟值。

## 5. 已知边界与后续方向
- 自对弈实测：在当前静态评估函数下，MaxN 的 d4+ 深层迭代为净负收益（评估对长线时序判断失真，
  深搜放大偏差），故最终网页配置 MaxN 封顶 d3（宽候选 k9 + 叶必胜稳定化，同深度严格超集于 3ply）；
  3ply 与 maxn 强度同量级（受控实验 19:21 均势、三人轮转互有胜负）。**后续工作：改进评估函数
  （资格时序/长线威胁建模）后放开迭代加深，MaxN 才能兑现「更深更强」**；
- 网页对用户仍禁止三 AI 座位（需求约束）；内部评测不受限（self-play harness）。
