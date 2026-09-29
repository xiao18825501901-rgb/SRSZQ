/**
 * SRSZQ P3B(B6) —— provider 接口 / 续训声明校验 / 评测矩阵聚合。
 *   npm run test:provider   （scripts/product/run-tests.mjs --suite provider 调用）
 *
 * 规格 6.3；验收矩阵 D06（分层评测、不只 pooled）、D07（缺字段拒绝“完整续训”声明）、D08（失败指标）。
 */
import assert from 'node:assert/strict';
import { createInitialState, applyMove } from '../../shared/src/game/rules.js';
import { currentPlayerOf, getLegalMoves } from '../../shared/src/game/legalMoves.js';
import { stableDigest } from '../../shared/src/product/resultModel.js';
import {
  EXACT_RESUME_REQUIRED, NOT_RESTORED_IN_WEIGHTS_ONLY, evaluateTrainingGates,
  strongestDefensibleClaim, validateResumeClaim, type CheckpointMeta,
} from '../../shared/src/ai/checkpoint.js';
import {
  createProductionProvider, createShadowAdapter, describeProviderStatus, emptyState,
  resolveMove, resolveProvider, DETERMINISTIC_SEARCH_BUDGET,
} from '../../shared/src/ai/provider.js';
import { aggregateMatrix, latencyStats, matrixHashOf, type GameRecord } from '../../shared/src/ai/evalMatrix.js';
import type { AiDifficulty } from '../../shared/src/ai/types.js';
import type { BoardSize } from '../../shared/src/game/types.js';

let failures = 0;
const observed: Record<string, unknown> = {};

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

const COMPLETE_META: CheckpointMeta = {
  schema: 1,
  weightsSha: 'sha256:weights-abc',
  rngState: 'rng:deadbeef',
  optimizerState: 'adam:moments',
  step: 12000,
  episodes: 100000,
  seedFrom: 1,
  seedTo: 100000,
  engineVersion: 'engine-1',
  rulesetVersion: 'formal-rules-v2',
  configHash: 'cfg-1',
  trajectoryHash: 'traj-1',
  budget: 'sims=800',
  sourceSha: 'abc123',
  createdAt: 1,
  boardSizeMix: { b13: 65000, b17: 35000 },
};

/** 用真实引擎打一局（双方都用五档生产 provider），返回逐手序列。用于真实路径与可复现性检查。 */
function playRealGame(boardSize: BoardSize, levels: Record<'A' | 'B' | 'C', AiDifficulty>, seed: number, maxPlies = 120): string[] {
  const provider = createProductionProvider();
  let state = createInitialState(boardSize);
  const moves: string[] = [];
  while (state.status === 'playing' && moves.length < maxPlies) {
    const seat = currentPlayerOf(state);
    const legal = getLegalMoves(state);
    if (legal.length === 0) break;
    const outcome = provider.decide({
      state, player: seat, level: levels[seat], seed: seed + moves.length,
      timeBudgetMs: DETERMINISTIC_SEARCH_BUDGET.timeBudgetMs, maxDepth: DETERMINISTIC_SEARCH_BUDGET.maxDepth,
      // 可复现的前提：时间预算不能成为约束（引擎没有节点预算旋钮）。
    });
    assert.equal(outcome.kind, 'decided', '生产 provider 必须给出决策：' + JSON.stringify(outcome));
    if (outcome.kind !== 'decided') break;
    const res = applyMove(state, outcome.decision.row, outcome.decision.col);
    assert.equal(res.rejected, undefined, '生产 provider 不得给出非法手：' + res.rejected);
    state = res.state;
    moves.push(outcome.decision.row + ',' + outcome.decision.col);
  }
  return moves;
}

function syntheticRecord(over: Partial<GameRecord>): GameRecord {
  return {
    gameId: 'g-' + Math.random().toString(36).slice(2, 8),
    boardSize: 13, family: 'SAME_LEVEL', subjectLevel: 3,
    seatByLevel: { 3: 'A' }, winnerSeat: 'A', status: 'won', plies: 40,
    subjectOutcome: 'WIN', illegalMoveAttempts: 0, crashes: 0, providerRefusals: 0, passCount: 0,
    latenciesMs: [10, 20, 30], nodes: [100], movesHash: stableDigest('x'),
    ...over,
  };
}

async function main(): Promise<void> {
  console.log('--- D07 续训声明校验 ---');

  await check('D07a 字段齐全时 EXACT_RESUME 通过；缺 RNG/优化器/步数时被拒绝并列出缺失项', async () => {
    const ok = validateResumeClaim(COMPLETE_META, 'EXACT_RESUME');
    assert.equal(ok.ok, true, ok.reasons.join(' '));
    assert.equal(ok.strongestSupported, 'EXACT_RESUME');
    assert.deepEqual(ok.missing, []);

    for (const drop of ['rngState', 'optimizerState', 'step', 'trajectoryHash', 'budget'] as const) {
      const meta: CheckpointMeta = { ...COMPLETE_META };
      delete (meta as Record<string, unknown>)[drop];
      const v = validateResumeClaim(meta, 'EXACT_RESUME');
      assert.equal(v.ok, false, '缺 ' + drop + ' 时不得通过精确续训');
      assert.ok(v.missing.includes(drop), '缺失项必须列出 ' + drop);
      assert.equal(v.strongestSupported, 'WEIGHTS_ONLY_LOAD', '只减不增：应降级为仅加载权重');
      assert.ok(v.reasons.some((r) => r.includes('不是一回事')), '必须说明为什么不能叫精确续训');
    }
    observed.d07_required = EXACT_RESUME_REQUIRED.length;
  });

  await check('D07b WEIGHTS_ONLY_LOAD 通过，但必须明确列出“没有恢复什么”', async () => {
    const meta: CheckpointMeta = { weightsSha: 'sha256:only-weights' };
    const v = validateResumeClaim(meta, 'WEIGHTS_ONLY_LOAD');
    assert.equal(v.ok, true);
    assert.equal(v.strongestSupported, 'WEIGHTS_ONLY_LOAD');
    assert.deepEqual(v.notRestored, []);
    const richer: CheckpointMeta = { ...COMPLETE_META };
    const v2 = validateResumeClaim(richer, 'WEIGHTS_ONLY_LOAD');
    assert.equal(v2.ok, true);
    assert.ok(v2.notRestored.includes('rngState') && v2.notRestored.includes('optimizerState'));
    assert.ok(v2.notRestored.length <= NOT_RESTORED_IN_WEIGHTS_ONLY.length);
    assert.ok(v2.reasons.some((r) => r.includes('不能算作同一次训练的继续')));
  });

  await check('D07c 连权重都没有时任何声明都不成立；不存在静默升级', async () => {
    const empty: CheckpointMeta = { step: 5 } as CheckpointMeta;
    assert.equal(strongestDefensibleClaim(empty), null);
    assert.equal(validateResumeClaim(empty, 'WEIGHTS_ONLY_LOAD').ok, false);
    assert.equal(validateResumeClaim(empty, 'EXACT_RESUME').ok, false);
    // 只有权重时不支持更弱的声明 -> 不等于可以声明更强
    const onlyWeights: CheckpointMeta = { weightsSha: 'sha256:w' };
    assert.equal(strongestDefensibleClaim(onlyWeights), 'WEIGHTS_ONLY_LOAD');
  });

  await check('D07d 研究协议门槛：训练量 0 -> PARTIAL；有非法手/崩溃 -> BLOCKED；全满足 -> READY', async () => {
    const zero = evaluateTrainingGates({
      formalEpisodes: 0, episodesByBoardSize: { b13: 0, b17: 0 }, seatsCovered: ['A', 'B', 'C'],
      illegalMoves: 0, crashes: 0, nanDetected: false, calibrationReported: false,
    });
    assert.equal(zero.status, 'PARTIAL', '训练量为 0 只能是 PARTIAL');
    assert.ok(zero.checks.some((c) => c.name === 'EPISODES_100K' && !c.ok));
    const bad = evaluateTrainingGates({
      formalEpisodes: 100000, episodesByBoardSize: { b13: 65000, b17: 35000 }, seatsCovered: ['A', 'B', 'C'],
      illegalMoves: 3, crashes: 0, nanDetected: false, calibrationReported: true,
    });
    assert.equal(bad.status, 'BLOCKED', '出现非法手只能是 BLOCKED');
    const good = evaluateTrainingGates({
      formalEpisodes: 100000, episodesByBoardSize: { b13: 65000, b17: 35000 }, seatsCovered: ['A', 'B', 'C'],
      illegalMoves: 0, crashes: 0, nanDetected: false, calibrationReported: true,
    });
    assert.equal(good.status, 'READY');
    observed.d07_gates = { zero: zero.status, bad: bad.status, good: good.status };
  });

  console.log('--- 6.3 provider 接口 ---');

  await check('P1 生产 provider 是默认且唯一会落子的实现：逐手合法', async () => {
    const provider = createProductionProvider();
    assert.equal(provider.kind, 'PRODUCTION');
    const moves = playRealGame(13, { A: 3, B: 3, C: 3 }, 42, 40);
    assert.ok(moves.length >= 10, '必须真的走出棋来，实际 ' + moves.length);
    assert.ok(moves.every((m) => !m.startsWith('!')), '不得出现非法手标记');
    observed.p1_moves = moves.length;
  });

  await check('P2 shadow flag 默认关闭时，shadow provider 完全不会被调用', async () => {
    let called = 0;
    const shadow = createShadowAdapter({
      id: 'shadow-probe', label: 'probe', meta: COMPLETE_META, claim: 'EXACT_RESUME',
      decideWith: () => { called += 1; return { row: 0, col: 0, pass: false }; },
    });
    const resolved = resolveProvider({}, shadow);
    assert.equal(resolved.shadow, null, 'flag 关闭时不应解析出 shadow');
    assert.equal(resolved.shadowMode, 'OFF');
    const state = emptyState(13);
    const outcome = resolveMove(resolved, { state, player: 'A', level: 3, seed: 1 });
    assert.equal(called, 0, 'shadow 绝不能在 flag 关闭时被调用');
    assert.ok(outcome.move, '生产决策必须照常产生');
    assert.equal(outcome.telemetry.shadowOutcome, 'OFF');
  });

  await check('P3 shadow 即使开启也只观察：落子永远来自生产 provider', async () => {
    // 构造一个“总是给出不同合法手”的 shadow，验证它不会改变落子。
    const shadow = createShadowAdapter({
      id: 'shadow-differs', label: '总是不同', meta: COMPLETE_META, claim: 'EXACT_RESUME',
      decideWith: (req) => {
        const legal = getLegalMoves(req.state);
        const prod = createProductionProvider().decide(req);
        const prodRow = prod.kind === 'decided' ? prod.decision.row : -1;
        const prodCol = prod.kind === 'decided' ? prod.decision.col : -1;
        const other = legal.find((m) => m.row !== prodRow || m.col !== prodCol) ?? legal[0];
        return { row: other.row, col: other.col, pass: false };
      },
    });
    const resolved = resolveProvider({ invitusShadow: true }, shadow);
    assert.equal(resolved.shadowMode, 'OBSERVE_ONLY');
    const state = emptyState(13);
    const outcome = resolveMove(resolved, { state, player: 'A', level: 3, seed: 7, timeBudgetMs: 20 });
    assert.equal(outcome.providerId, 'production-five-levels', '落子方必须仍是生产 provider');
    const prod = createProductionProvider().decide({ state, player: 'A', level: 3, seed: 7, timeBudgetMs: 20 });
    assert.equal(prod.kind, 'decided');
    if (prod.kind === 'decided') {
      assert.equal(outcome.move?.row, prod.decision.row, 'shadow 不得改变落子');
      assert.equal(outcome.move?.col, prod.decision.col);
    }
    assert.ok(['DIFFERS', 'AGREES'].includes(outcome.telemetry.shadowOutcome));
    observed.p3_shadow = outcome.telemetry.shadowOutcome;
  });

  await check('P4 Invitus 形态的适配器：元数据不全时拒绝运行，并说明缺什么', async () => {
    const adapter = createShadowAdapter({
      id: 'invitus-shape', label: 'Invitus 形态', meta: { weightsSha: 'sha256:only-weights' }, claim: 'EXACT_RESUME',
      decideWith: () => { throw new Error('不该被调用'); },
    });
    const outcome = adapter.decide({ state: emptyState(13), player: 'A', level: 5, seed: 1 });
    assert.equal(outcome.kind, 'refused');
    if (outcome.kind === 'refused') {
      assert.equal(outcome.reason, 'MISSING_FIELDS_FOR_EXACT_RESUME');
      assert.ok(outcome.missing.includes('rngState') && outcome.missing.includes('optimizerState'));
    }
    // 生产不受影响：同一局面下生产 provider 照常落子
    const resolved = resolveProvider({ invitusShadow: true }, adapter);
    const move = resolveMove(resolved, { state: emptyState(13), player: 'A', level: 3, seed: 2, timeBudgetMs: 20 });
    assert.ok(move.move, 'shadow 拒绝时对局必须照常推进');
    assert.equal(move.telemetry.shadowOutcome, 'REFUSED');
  });

  await check('P5 provider 现状描述如实：未接入 Invitus、未训练任何模型', async () => {
    const lines = describeProviderStatus({});
    const text = lines.join(' ');
    assert.ok(text.includes('未接入'), '必须写明 Invitus 未接入');
    assert.ok(text.includes('未训练任何模型'), '必须写明没有训练');
    assert.ok(text.includes('精确一步'), '分析口径必须写明只给精确一步事实');
  });

  console.log('--- D06/D08 评测矩阵 ---');

  await check('D06a 分层聚合：按棋盘/对手族/档位/座位分别统计，不只 pooled', async () => {
    const records: GameRecord[] = [
      syntheticRecord({ boardSize: 13, family: 'SAME_LEVEL', subjectLevel: 1, subjectOutcome: 'WIN', latenciesMs: [10, 10] }),
      syntheticRecord({ boardSize: 13, family: 'SAME_LEVEL', subjectLevel: 1, subjectOutcome: 'LOSS', latenciesMs: [20, 20] }),
      syntheticRecord({ boardSize: 17, family: 'CHALLENGER_VS_5', subjectLevel: 4, subjectOutcome: 'DRAW', latenciesMs: [30] }),
      syntheticRecord({ boardSize: 17, family: 'CHALLENGER_VS_5', subjectLevel: 4, subjectOutcome: 'LOSS', latenciesMs: [40] }),
    ];
    const matrix = aggregateMatrix(records, { boardSizes: [13, 17], families: ['SAME_LEVEL', 'CHALLENGER_VS_5'], levels: [1, 4], gamesPerCell: 2 });
    assert.equal(matrix.cells.length, 2, '两个格子');
    const c1 = matrix.cells.find((c) => c.boardSize === 13)!;
    assert.equal(c1.games, 2);
    assert.equal(c1.winRate, 0.5);
    assert.equal(matrix.bySeat.length, 3, '座位维度必须在');
    assert.equal(matrix.calibration.status, 'NOT_AVAILABLE', '五档不输出概率，校准必须如实标不可用');
    assert.ok(matrix.calibration.reason.includes('启发式分数'), '必须说明为什么不可用');
    assert.ok(matrix.legalityRate === 1);
    observed.d06_cells = matrix.cells.length;
  });

  await check('D06b 延迟分位与合法性、崩溃、拒绝都进统计', async () => {
    const stats = latencyStats([5, 10, 15, 100]);
    assert.equal(stats.count, 4);
    assert.ok(stats.p50 <= stats.p95 && stats.p95 <= stats.max);
    const records = [
      syntheticRecord({ illegalMoveAttempts: 1, crashes: 1, providerRefusals: 3, latenciesMs: [1, 2, 3] }),
      syntheticRecord({ illegalMoveAttempts: 0, latenciesMs: [4, 5] }),
    ];
    const matrix = aggregateMatrix(records, { boardSizes: [13], families: ['SAME_LEVEL'], levels: [3], gamesPerCell: 2 });
    assert.equal(matrix.illegalMoveAttempts, 1);
    assert.equal(matrix.crashCount, 1);
    assert.equal(matrix.cells[0].providerRefusals, 3);
    assert.ok(matrix.legalityRate < 1, '有非法手时合法率必须小于 1');
  });

  await check('D06c 矩阵哈希稳定：同输入同哈希，改一手即变', async () => {
    const a = [syntheticRecord({ gameId: 'x1' }), syntheticRecord({ gameId: 'x2' })];
    const b = [syntheticRecord({ gameId: 'x2' }), syntheticRecord({ gameId: 'x1' })].map((r) => ({ ...r }));
    assert.equal(matrixHashOf(a), matrixHashOf(b), '顺序不应影响哈希');
    const c = [{ ...a[0], movesHash: stableDigest('changed') }, a[1]];
    assert.notEqual(matrixHashOf(a), matrixHashOf(c), '棋谱变了哈希必须变');
  });

  await check('D06d 真实引擎路径：预算不成为约束时，同种子两局逐手一致', async () => {
    const levels = { A: 2 as AiDifficulty, B: 3 as AiDifficulty, C: 5 as AiDifficulty };
    const first = playRealGame(13, levels, 20260930, 30);
    const second = playRealGame(13, levels, 20260930, 30);
    assert.deepEqual(second, first, '同种子必须走出同一盘棋');
    const third = playRealGame(13, levels, 7, 30);
    assert.notDeepEqual(third, first, '不同种子应能走出不同结果（否则种子没起作用）');
    observed.d06_real = { plies: first.length, hash: stableDigest(first.join('>')), budget: DETERMINISTIC_SEARCH_BUDGET };
  });

  await check('D06e 可复现的前提被验证：单次决策耗时远低于时间预算（预算没卡住搜索）', async () => {
    // 实测过：时间预算一旦截断搜索，同一 seed 会因运行时冷热走出不同的棋。
    // 因此这里断言“预算没有被用满”，而不是假设可复现性天然成立。
    const provider = createProductionProvider();
    const state = emptyState(17);
    let maxMs = 0;
    for (const level of [1, 3, 5] as AiDifficulty[]) {
      for (let i = 0; i < 3; i += 1) {
        const d = provider.decide({
          state, player: 'A', level, seed: 1000 + i,
          timeBudgetMs: DETERMINISTIC_SEARCH_BUDGET.timeBudgetMs, maxDepth: DETERMINISTIC_SEARCH_BUDGET.maxDepth,
        });
        assert.equal(d.kind, 'decided');
        if (d.kind === 'decided') maxMs = Math.max(maxMs, d.decision.thinkTimeMs ?? 0);
      }
    }
    const pressure = maxMs / DETERMINISTIC_SEARCH_BUDGET.timeBudgetMs;
    observed.d06_budget = { maxMs: Math.round(maxMs * 100) / 100, budgetMs: DETERMINISTIC_SEARCH_BUDGET.timeBudgetMs, pressure: Math.round(pressure * 1000) / 1000 };
    assert.ok(
      pressure < 0.5,
      '预算压力过高（' + Math.round(pressure * 100) + '%）：时间预算可能在截断搜索，此时同种子可复现性不成立，评测结论也不可信',
    );
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  if (failures === 0) console.log('AI PROVIDER: ALL PASS 0');
  else console.log('AI PROVIDER: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
