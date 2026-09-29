/**
 * SRSZQ P3B(B6) —— CPU 评测矩阵运行器（规格 6.3 / 验收 D06、D08）。
 *
 *   npx tsx scripts/product/ai-eval-matrix.mts [--games 2] [--out evidence]
 *
 * 只做一件事：**在真实引擎上，用现有五档 AI 打真局**，把结果按
 * 棋盘尺寸 × 对手族 × 档位 × 座位 分层记录下来，并做同种子重跑的可复现性比对。
 *
 * 明确不做的事：
 *  - 不训练任何模型，不声称任何训练完成度；
 *  - 不输出胜率估计（五档不产生概率），因此校准标为 NOT_AVAILABLE；
 *  - 不把 shadow（Invitus 形态）的决策当作落子：它只被记录；这里用的 shadow 元数据故意不完整，
 *    用来证明“缺字段就拒绝”在真实运行里确实会发生。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, applyMove } from '../../shared/src/game/rules.js';
import { currentPlayerOf, getLegalMoves } from '../../shared/src/game/legalMoves.js';
import { stableDigest } from '../../shared/src/product/resultModel.js';
import {
  aggregateMatrix,
  type GameRecord, type OpponentFamily,
} from '../../shared/src/ai/evalMatrix.js';
import { createShadowAdapter, resolveMove, resolveProvider, describeProviderStatus, DETERMINISTIC_SEARCH_BUDGET } from '../../shared/src/ai/provider.js';
import { evaluateTrainingGates, CHECKPOINT_SCHEMA_VERSION } from '../../shared/src/ai/checkpoint.js';
import type { BoardSize, Player } from '../../shared/src/game/types.js';
import type { AiDifficulty } from '../../shared/src/ai/types.js';

const FENCE = String.fromCharCode(96).repeat(3);

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const GAMES_PER_CELL = Number(argOf('--games', '2'));
const OUT_DIR = argOf('--out', 'evidence');
const MAX_PLIES = Number(argOf('--max-plies', '220'));

const BOARD_SIZES: BoardSize[] = [13, 17];
const FAMILIES: OpponentFamily[] = ['SAME_LEVEL', 'MIXED_LEVEL', 'CHALLENGER_VS_5'];
const LEVELS: AiDifficulty[] = [1, 2, 3, 4, 5];
const SEATS: Player[] = ['A', 'B', 'C'];

/** 同一组输入必须得到同一个种子（可复现的第一块基石）。 */
function seedOf(boardSize: number, family: string, level: number, gameIndex: number): number {
  return parseInt(stableDigest(boardSize + '|' + family + '|' + level + '|' + gameIndex).slice(0, 8), 16);
}

/** 座位配置：被测档位在不同对局里分别坐 A/B/C，避免座位偏置被当成棋力差。 */
function levelsForFamily(family: OpponentFamily, subject: AiDifficulty, gameIndex: number): Record<Player, AiDifficulty> {
  const rotate = <T,>(arr: T[], n: number): T[] => arr.map((_, i) => arr[(i + n) % arr.length]);
  if (family === 'SAME_LEVEL') return { A: subject, B: subject, C: subject };
  const others: AiDifficulty[] = family === 'MIXED_LEVEL'
    ? [Math.min(5, subject + 1) as AiDifficulty, Math.max(1, subject - 1) as AiDifficulty]
    : [5, 5];
  const order = rotate<AiDifficulty>([subject, ...others], gameIndex % 3);
  return { A: order[0], B: order[1], C: order[2] };
}

interface PlayResult { record: GameRecord; moves: string[] }

function playGame(boardSize: BoardSize, family: OpponentFamily, subject: AiDifficulty, gameIndex: number, opts: { withShadow: boolean }): PlayResult {
  const gameId = 'eval-' + boardSize + '-' + family + '-' + subject + '-' + gameIndex;
  const seed = seedOf(boardSize, family, subject, gameIndex);
  const levelBySeat = levelsForFamily(family, subject, gameIndex);
  const shadowAdapter = opts.withShadow
    ? createShadowAdapter({
        id: 'invitus-shadow-probe',
        label: 'Invitus 形态的 shadow 适配器（元数据故意不完整，用于验证拒绝路径）',
        meta: { schema: CHECKPOINT_SCHEMA_VERSION, weightsSha: 'sha256:demo-weights-only' },
        claim: 'EXACT_RESUME',
      })
    : null;
  const resolved = resolveProvider({ invitusShadow: opts.withShadow }, shadowAdapter);

  let state = createInitialState(boardSize);
  const moves: string[] = [];
  const latencies: number[] = [];
  const nodes: number[] = [];
  let passCount = 0;
  let illegal = 0;
  let crashes = 0;
  let shadowRefusals = 0;

  while (state.status === 'playing' && moves.length < MAX_PLIES) {
    const seat = currentPlayerOf(state);
    const legal = getLegalMoves(state);
    if (legal.length === 0) break;
    let row: number;
    let col: number;
    try {
      const outcome = resolveMove(resolved, {
        state, player: seat, level: levelBySeat[seat], seed: seed + moves.length,
        // 可复现要求时间预算不成为约束：给足预算 + 固定深度。
        timeBudgetMs: DETERMINISTIC_SEARCH_BUDGET.timeBudgetMs,
        maxDepth: DETERMINISTIC_SEARCH_BUDGET.maxDepth,
      });
      if (outcome.telemetry.shadowOutcome === 'REFUSED') shadowRefusals += 1;
      if (!outcome.move) {
        // 生产 provider 拒绝（例如给出了非法手）：记非法尝试，回退到引擎的第一手合法着。
        illegal += 1;
        row = legal[0].row;
        col = legal[0].col;
      } else {
        row = outcome.move.row;
        col = outcome.move.col;
        if (typeof outcome.move.thinkTimeMs === 'number') latencies.push(outcome.move.thinkTimeMs);
        if (typeof outcome.move.nodes === 'number') nodes.push(outcome.move.nodes);
      }
    } catch (e) {
      crashes += 1;
      row = legal[0].row;
      col = legal[0].col;
    }
    const res = applyMove(state, row, col);
    if (res.rejected) {
      illegal += 1;
      const fallback = applyMove(state, legal[0].row, legal[0].col);
      state = fallback.state;
      moves.push('!' + legal[0].row + ',' + legal[0].col);
      continue;
    }
    passCount += res.autoPassed.length;
    state = res.state;
    moves.push(row + ',' + col);
  }

  const subjectSeats = SEATS.filter((s) => levelBySeat[s] === subject);
  const subjectOutcome: GameRecord['subjectOutcome'] = state.status === 'draw'
    ? 'DRAW'
    : state.status === 'won' && state.winner
      ? (subjectSeats.includes(state.winner) ? 'WIN' : 'LOSS')
      : 'UNKNOWN';

  const seatByLevel: Record<string, 'A' | 'B' | 'C'> = {};
  for (const s of SEATS) seatByLevel[String(levelBySeat[s])] = s;

  return {
    moves,
    record: {
      gameId, boardSize, family, subjectLevel: subject, seatByLevel,
      winnerSeat: state.winner ?? null, status: state.status as GameRecord['status'], plies: moves.length,
      subjectOutcome,
      illegalMoveAttempts: illegal, crashes, providerRefusals: shadowRefusals, passCount,
      latenciesMs: latencies, nodes, movesHash: stableDigest(moves.join('>')),
    },
  };
}

const records: GameRecord[] = [];
const t0 = Date.now();
for (const boardSize of BOARD_SIZES) {
  for (const family of FAMILIES) {
    for (const level of LEVELS) {
      for (let g = 0; g < GAMES_PER_CELL; g += 1) {
        records.push(playGame(boardSize, family, level, g, { withShadow: true }).record);
      }
    }
  }
}
const elapsedMs = Date.now() - t0;

// 可复现性：抽 1/5 的对局同种子重跑，逐手序列必须完全一致。
const sampleIdx = records.map((_, i) => i).filter((i) => i % 5 === 0);
let identical = true;
let checked = 0;
for (const i of sampleIdx) {
  const r = records[i];
  const again = playGame(r.boardSize, r.family, r.subjectLevel as AiDifficulty, Number(r.gameId.split('-').pop()), { withShadow: false });
  checked += 1;
  if (again.record.movesHash !== r.movesHash) identical = false;
}

const totalDecisions = records.reduce((n, r) => n + r.latenciesMs.length, 0);
const maxDecisionMs = records.reduce((m, r) => Math.max(m, ...(r.latenciesMs.length ? r.latenciesMs : [0])), 0);
const budgetPressure = maxDecisionMs / DETERMINISTIC_SEARCH_BUDGET.timeBudgetMs;
const budgetBound = budgetPressure > 0.5;

const matrix = aggregateMatrix(records, {
  boardSizes: BOARD_SIZES as number[], families: FAMILIES, levels: LEVELS, gamesPerCell: GAMES_PER_CELL,
});
matrix.reproducibility = {
  checkedGames: checked,
  identical,
  note: (identical
    ? '同种子重跑 ' + checked + ' 局，逐手序列哈希完全一致。'
    : '同种子重跑出现不一致 —— 存在非确定性来源，查清前不得用于研究结论。') +
    ' 预算压力：单次决策最长 ' + Math.round(maxDecisionMs * 100) / 100 + 'ms / 预算 ' + DETERMINISTIC_SEARCH_BUDGET.timeBudgetMs + 'ms' +
    (budgetBound
      ? '（>50%：时间预算可能在截断搜索，此时可复现性不成立）'
      : '（远低于预算：搜索按固定深度结束，可复现性成立）') +
    '；固定深度 maxDepth=' + DETERMINISTIC_SEARCH_BUDGET.maxDepth + '。',
};

const gates = evaluateTrainingGates({
  formalEpisodes: 0,
  episodesByBoardSize: { b13: 0, b17: 0 },
  seatsCovered: [...new Set(records.flatMap((r) => Object.values(r.seatByLevel)))],
  illegalMoves: matrix.illegalMoveAttempts,
  crashes: matrix.crashCount,
  nanDetected: false,
  calibrationReported: false,
});

const artifact = {
  schemaVersion: 1,
  kind: 'ai-eval-matrix',
  generatedAt: new Date().toISOString(),
  scope: 'existing-five-levels-cpu',
  note: '评测对象是现有五档 AI，不是新训练的模型；本项目未训练任何模型。',
  config: { boardSizes: BOARD_SIZES, families: FAMILIES, levels: LEVELS, gamesPerCell: GAMES_PER_CELL, maxPlies: MAX_PLIES },
  elapsedMs,
  totalDecisions,
  matrix,
  trainingGates: gates,
  providerStatus: describeProviderStatus({ invitusShadow: true }),
  shadowPolicy: resolveProvider({ invitusShadow: true }, null).policy,
  shadowRefusalEvidence: {
    adapter: 'invitus-shadow-probe',
    claim: 'EXACT_RESUME',
    observedRefusals: records.reduce((n, r) => n + r.providerRefusals, 0),
    meaning: 'shadow 元数据只有权重却声称精确续训 -> 每次决策都被拒绝；被拒绝不影响落子。',
  },
  honesty: [
    '校准：NOT_AVAILABLE —— 五档不输出胜率估计，score 是启发式分数而非概率。',
    '样本量 ' + records.length + ' 局，不足以做统计显著性判断，因此不给置信区间结论。',
    '训练量 0：研究协议的 100k 门槛未触及，门禁状态见 trainingGates.status。',
  ],
};
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, 'ai-eval-matrix.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 1) + '\n', 'utf8');

/** 模型卡：把“做了什么、没做什么、失败指标”写清楚（D08）。 */
const card = [
  '# 模型卡（2026-09-30，P3B/B6 批次生成）',
  '',
  '## 一句话结论',
  '',
  '**本项目没有训练任何模型。** 本卡记录的是现有五档 AI 在 CPU 上的评测矩阵，以及研究协议 100k 门槛的当前状态。',
  '任何“训练完成 / 续训完成”的说法都不成立。',
  '',
  '## 评测对象与环境',
  '',
  '- 对象：production-five-levels（现有五档 AI），即线上实际使用的决策实现。',
  '- 环境：CPU；' + matrix.totalGames + ' 局真实引擎对局（13 路与 17 路各半），' + totalDecisions + ' 次决策，耗时 ' + elapsedMs + 'ms。',
  '- 座位：每局 A/B/C 各坐一个配置并轮转；' + matrix.seatBalanceNote,
  '',
  '## 真实训练量 vs 目标量（分开写，不混为一谈）',
  '',
  '- 真实训练量：**0 局**（本仓库没有训练管线产出，也没有 checkpoint）。',
  '- 目标量（研究协议冻结值，未改动）：正式训练 >= 100,000 局，17 路占比 >= 30%，A/B/C 三座覆盖。',
  '- 门禁判定：**' + gates.status + '**',
  '',
  gates.checks.map((c) => '- ' + (c.ok ? '[OK] ' : '[FAIL] ') + c.name + '：' + c.detail).join('\n'),
  '',
  '## 失败指标（必须写，不能只报好看的数字）',
  '',
  '- 非法落子尝试：' + matrix.illegalMoveAttempts + ' 次（合法率 ' + matrix.legalityRate + '）。',
  '- 崩溃：' + matrix.crashCount + ' 次。',
  '- shadow 拒绝：' + artifact.shadowRefusalEvidence.observedRefusals + ' 次（元数据不全时按设计拒绝，不影响对局）。',
  '- 同种子可复现：' + (identical ? '是' : '否') + '（检查 ' + checked + ' 局，逐手序列哈希比对）。',
  '',
  '## 校准',
  '',
  matrix.calibration.status + '：' + matrix.calibration.reason,
  '',
  '## 分层结果（不只有 pooled 数字）',
  '',
  '| 棋盘 | 对手族 | 档位 | 局数 | 胜-负-和 | 胜率 | p95 延迟 | 非法 |',
  '|---|---|---|---|---|---|---|---|',
  matrix.cells.map((c) => '| ' + c.boardSize + ' | ' + c.family + ' | L' + c.level + ' | ' + c.games + ' | ' + c.wins + '-' + c.losses + '-' + c.draws + ' | ' + c.winRate + ' | ' + c.latency.p95 + 'ms | ' + c.illegalMoveAttempts + ' |').join('\n'),
  '',
  '按座位：' + matrix.bySeat.map((s) => s.seat + ' 胜 ' + s.wins + '/' + matrix.totalGames).join('，'),
  '',
  '## 未做的事情（不要误读）',
  '',
  '- 未接入 Invitus：shadow flag 默认关闭；即使打开也只观察，其决策在类型上无法成为落子。',
  '- 未做 GPU 训练、未产出 checkpoint、未做搜索 scaling（1600/3200 sims）与 exact oracle 残局评测。',
  '- 因此研究协议里的强度门槛（seat-adjusted win rate 95% CI 下界 > 1/3 等）**没有结论**。',
  '',
  '## 与 research/invitus 分支的关系',
  '',
  '该研究分支独立存在于远端（refs/heads/research/invitus），本批次只做只读检查：未合并、未改写、未检出。',
  '其 INVICTUS_ACCEPTANCE_CRITERIA.md 被本卡作为门槛口径引用，而不是复制它的实现。',
  '',
  '## 复现方式',
  '',
  FENCE,
  'npx tsx scripts/product/ai-eval-matrix.mts --games 2',
  FENCE,
  '',
  '产物：' + outPath.replace(/\\/g, '/') + '（含逐格分层统计与 matrixHash ' + matrix.matrixHash + '）。',
  '',
].join('\n');
writeFileSync('docs/MODEL_CARD_20260930.md', card, 'utf8');

console.log('=== AI 评测矩阵（现有五档，CPU）===');
console.log('games=' + records.length + ' decisions=' + totalDecisions + ' elapsed=' + elapsedMs + 'ms');
console.log('cells=' + matrix.cells.length + ' matrixHash=' + matrix.matrixHash);
console.log('illegal=' + matrix.illegalMoveAttempts + ' crashes=' + matrix.crashCount + ' legalityRate=' + matrix.legalityRate);
console.log('reproducibility=' + (identical ? 'IDENTICAL' : 'MISMATCH') + ' (' + checked + ' games)');
console.log('shadowRefusals=' + artifact.shadowRefusalEvidence.observedRefusals);
console.log('trainingGates=' + gates.status + ' failed=' + gates.checks.filter((c) => !c.ok).map((c) => c.name).join(','));
console.log('bySeat=' + JSON.stringify(matrix.bySeat));
for (const c of matrix.cells.slice(0, 5)) {
  console.log('  ' + c.boardSize + '/' + c.family + '/L' + c.level + ' games=' + c.games + ' W-L-D=' + c.wins + '-' + c.losses + '-' + c.draws + ' p95=' + c.latency.p95 + 'ms');
}
console.log('artifact=' + outPath + ' modelCard=docs/MODEL_CARD_20260930.md');
