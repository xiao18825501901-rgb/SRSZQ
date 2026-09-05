# 三人四子棋 · Three-Player Connect Four

本地网页版（Local-First SPA）—— 三名玩家轮流在网格上落子，只有「拥有胜权」的玩家可以凭落子形成 ≥4 连获胜。

技术栈：React 19 + TypeScript + Vite 8 + Vitest。

---

## 如何启动

双击 `start.bat`（或手动执行）：

```bash
npm install     # 首次运行
npm run dev     # 启动开发服务器
```

然后浏览器打开： **http://localhost:5173**

`start.bat` 会自动打开浏览器。

## 如何停止

- 关闭运行中的 `start.bat` 黑色窗口（Ctrl+C 或关窗口）即可停止服务器。

## 构建

```bash
build.bat       # = npm run build，产物输出到 dist/
npm test        # 运行全部规则测试（Vitest）
```

---

## 项目目录

```
three-player-connect-four/
├── src/
│   ├── game/                  # 纯规则引擎（与 UI 完全分离，可独立测试/复用）
│   │   ├── types.ts           # 类型：玩家/棋盘/资格顺序/状态
│   │   ├── eligibility.ts     # 资格顺序：CBA / CBACC / BAC 与 Round 计算
│   │   ├── winDetection.ts    # ≥4 连检测（横/竖/主对角/副对角，穿过落子格）
│   │   ├── legalMoves.ts      # 合法落子 / 禁手 / 胜点 / 棋盘满
│   │   ├── rules.ts           # 状态机：落子 / 自动Pass / 撤销 / 重放 / 导入校验
│   │   └── __tests__/         # Vitest 规则测试（66 项）
│   ├── ai/                    # ★ SRSZQ AI（BAC 人机对弈，Web Worker + 离线脚本共用）
│   │   ├── types.ts / seats.ts / rng.ts
│   │   ├── threatAnalysis.ts / evaluation.ts / moveOrdering.ts
│   │   ├── search.ts / searchAgents.ts           # MaxN / 3-Ply
│   │   ├── randomAgent.ts / tacticalAgent.ts / selfishAgent.ts
│   │   ├── chooseAIMove.ts                       # 统一决策入口（引擎合法集为唯一规则来源）
│   │   ├── config/defaultWeights.ts              # 一套权重 + 在线/离线预算
│   │   ├── worker/ai.worker.ts + aiWorkerClient.ts
│   │   └── tests/                                # AI 单元/扫掠测试（14 项）
│   ├── components/            # Board / Cell / PlayerCard / SeatSetup / History / Modal 等
│   ├── hooks/useGame.ts       # React 状态桥接
│   ├── hooks/useAIController.ts # ★ AI 行动控制器（串行思考/锁盘/竞态保护/自动 Pass）
│   ├── styles/global.css      # 样式（深色竞技风格，响应式）
│   ├── App.tsx
│   └── main.tsx
├── scripts/
│   ├── ai-selfplay.ts         # 三 AI 自对弈评测（npm run ai:selfplay）
│   └── ai-benchmark.ts        # 分档性能基准（npm run ai:benchmark）
├── SRSZQ_AI_REPORT.md / AI_TUNING_REPORT.md / AI_BENCHMARK_REPORT.md
├── start.bat / build.bat
└── README.md
```

---

## 当前规则

- 玩家：A（红）、B（绿）、C（白），固定行动顺序 **A → B → C**。
- 棋盘：11×11（默认）或 13×13，正方形等格。
- 一个 Round = A、B、C 各行动一次。
- **Round 1–3：无人拥有胜权**，任何玩家都不得形成自己的 ≥4 连（禁手）。
- 从 Round 4 起按所选资格顺序轮转胜权；只有「当前玩家 == 胜权玩家」时，落子形成 ≥4 才获胜。
- 非资格玩家的「形成 ≥4 落子」为禁手，无法点击。
- ≥4 即算（4/5/6…连均可），方向含横、竖、两斜。
- 胜利只能由「当前新落的一颗棋」触发的连线判定（不做全局扫描，杜绝“储存四连”）。
- 无合法步 → 自动 Pass（回合照常消耗）；若撤销到无合法步状态，界面会提供「跳过」按钮。
- 棋盘填满无人获胜 → 和棋。

## 三种资格顺序（从 R4 生效）

| 方案 | 周期 | R4 R5 R6 R7 R8 R9 R10 R11 R12 R13 | 说明 |
|---|---|---|---|
| **CBA** | C→B→A | C B A C B A C B A C | 原始 baseline，3 轮一循环 |
| **CBACC** | C→B→A→C→C | C B A C C C B A C C | 5 轮一循环；注意 R7-R9 会出现连续三个 C（规则如此，非 Bug） |
| **BAC** | B→A→C | B A C B A C B A C | 3 轮一循环 |

页面顶部状态栏与「资格时间轴」会实时显示：当前轮胜权、上一轮、未来 5 轮。

## 界面功能

- 状态栏：Round / 当前玩家 / 当前胜权（🏆）/ 资格顺序 / 下轮胜权。
- 玩家卡：棋子数、是否持胜权、禁手点、胜点；AI 座位显示 🤖 AI·档位·星级，思考中显示 THINKING。
- **AI 座位（BAC 专用）**：开局设置中每个座位可选 人类 / Random / Tactical / Selfish / 3-Ply / MaxN；
  每局 0–2 个 AI、至少 1 名人类（禁止三 AI）。AI 与人类共享同一规则引擎，
  思考期间棋盘锁定，AI 走子自动串行，日志带 🤖AI 标记（?debug=1 显示深度/节点/耗时）。
  悔棋在 AI 局为「悔棋到上一人类回合」。
- 显示合法落子（小圆点）与禁手（淡红 ✕ + 悬停解释）。
- 显示胜点（红/绿/白外框，表示各玩家下一手可成 ≥4 的位置）。
- 棋局日志（Move History）：`Turn 17 — B → (7, 5)`，含自动 Pass 与胜局记录。
- 悔棋（撤销一步，含撤销 Pass）、新游戏（确认后开始）、规则说明。
- 折叠 Debug 面板（`?debug=1` 自动展开）：turnIndex/round/eligible/各玩家 legal/winning/forbidden 统计。
- 导出 / 导入棋局 JSON（见下）。

## 导入 / 导出棋局

- **导出**：点击 `⤓ Export JSON`，得到形如：

```json
{
  "boardSize": 11,
  "schedule": "BAC",
  "players": { "A": { "kind": "human" }, "B": { "kind": "ai", "level": "3ply" }, "C": { "kind": "human" } },
  "moves": [
    { "turn": 0, "round": 1, "player": "A", "row": 6, "col": 6 },
    { "turn": 1, "round": 1, "player": "B", "row": 7, "col": 7,
      "ai": { "depth": 3, "nodes": 586, "thinkTimeMs": 142, "ttHits": 0, "candidates": 7, "reason": "MaxN depth 3 best utility" } }
  ]
}
```

坐标均为 1-based（与棋盘坐标一致）；自动 Pass 记录为 `{ "turn": n, "round": r, "player": "X", "pass": true }`。
`players` 为座位配置（仅 BAC 生效，可缺省 = 全人类）；每步 `ai` 为该步 AI 决策统计（可缺省）。

- **导入**：点击 `⤒ Import JSON` 选择文件。系统会逐手校验（玩家顺序、占位、禁手规则、Pass 合法性、终局状态），任一非法会明确报错：`Invalid move at turn 17 (B → (3, 4)): 禁手...`，不会静默接受。
  带 `players` 的 BAC 文件会恢复座位（旧格式无 players → 默认全人类）。

## 测试 / 调试

- `npm test`：80 项测试（引擎 66 + AI 14：合法性扫掠、禁手专项、战术行为）。
- `npm run ai:selfplay`：三 AI 自对弈评测（真实胜率/统计，见 AI_TUNING_REPORT.md）。
- `npm run ai:benchmark`：分档性能基准（耗时/深度/节点/100% 合法性，见 AI_BENCHMARK_REPORT.md）。
- `?debug=1`：展开 Debug 面板，并暴露 `window.__tcf`（getState/place/undo/pass/newGame/seats/setSeats/aiStats/thinking）供自动化与研究使用。
- 坐标约定：页面行列均为 1–N 数字（行自上而下，列自左而右）；内部实现为 0-based。

## 快捷键/提示

- 单击空格落子；悬停显示当前玩家半透明预览。
- 修改棋盘尺寸或资格顺序会询问是否开新局（不会静默改动进行中的棋局）。
