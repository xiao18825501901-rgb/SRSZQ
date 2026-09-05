/**
 * SRSZQ AI 基准评测：在大量随机 BAC 中盘局面上，逐档测量
 * 决策耗时 / 节点数 / 迭代深度 / TT 命中 / 候选数，并验证 100% 合法。
 *
 * 用法：
 *   npm run ai:benchmark                # 默认：每档 120 局面（11+13 混合）
 *   npm run ai:benchmark -- --states 40 # 快速冒烟
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardSize, GameState, Player } from '../src/game/types';
import { createInitialState, applyMove } from '../src/game/rules';
import { currentPlayerOf, getLegalMoves } from '../src/game/legalMoves';
import { chooseAIMove } from '../src/ai/chooseAIMove';
import type { AILevel } from '../src/ai/types';
import { AI_LEVELS, AI_LEVEL_LABELS } from '../src/ai/types';
import { OFFLINE_LEVEL_CONFIG } from '../src/ai/config/defaultWeights';
import { mulberry32 } from '../src/ai/rng';

/** 与测试 helpers 等价的确定性随机中盘生成器（不依赖测试目录） */
function randomMidGame(seed: number, size: BoardSize, maxMoves = 34): GameState {
  const rng = mulberry32(seed);
  let s = createInitialState(size);
  const target = Math.min(maxMoves, 1 + rng.int(size * size));
  for (let i = 0; i < target; i++) {
    if (s.status !== 'playing') break;
    const legal = getLegalMoves(s);
    if (legal.length === 0) break;
    const m = legal[rng.int(legal.length)];
    const res = applyMove(s, m.row, m.col);
    if (res.rejected) break;
    s = res.state;
  }
  return s;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function parseArgs(argv: string[]): { states: number } {
  let states = 120;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--states') states = Math.max(1, Number(argv[++i]) || 1);
  }
  return { states };
}

function main(): void {
  const { states } = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  // 拦截内部兜底
  let internalFallbacks = 0;
  const origError = console.error;
  console.error = (...a: unknown[]) => {
    if (String(a[0] ?? '').includes('AI_INVALID_DECISION')) internalFallbacks++;
    origError(...a);
  };

  console.log(`[benchmark] 每档 ${states} 个随机局面（13/17 交替），离线预算见 OFFLINE_LEVEL_CONFIG`);
  console.log(`            3ply: ${OFFLINE_LEVEL_CONFIG['3ply'].timeBudgetMs}ms k${OFFLINE_LEVEL_CONFIG['3ply'].candidateK} · maxn: ${OFFLINE_LEVEL_CONFIG.maxn.timeBudgetMs}ms k${OFFLINE_LEVEL_CONFIG.maxn.candidateK}`);
  console.log('');

  const out: Array<Record<string, number | string | boolean>> = [];
  let illegalTotal = 0;
  let passTotal = 0;

  for (const level of AI_LEVELS) {
    const cfg = OFFLINE_LEVEL_CONFIG[level];
    const times: number[] = [];
    const nodes: number[] = [];
    const depths: number[] = [];
    const ttHits: number[] = [];
    const cands: number[] = [];
    let illegal = 0;
    let passes = 0;
    const wallStart = Date.now();

    for (let i = 0; i < states; i++) {
      const s = randomMidGame(0xbeef + i * 7919, i % 2 === 0 ? 13 : 17, 40);
      if (s.status !== 'playing') continue;
      const player = currentPlayerOf(s);
      const t0 = Date.now();
      const d = chooseAIMove(s, player, level, {
        seed: 1000 + i,
        timeBudgetMs: cfg.timeBudgetMs,
        maxDepth: cfg.maxDepth,
        candidateK: cfg.candidateK,
      });
      const dt = Date.now() - t0;
      times.push(dt);
      if (d.pass) {
        passes++;
        continue;
      }
      const legal = getLegalMoves(s);
      if (!legal.some((m) => m.row === d.row && m.col === d.col)) illegal++;
      nodes.push(d.nodes ?? 0);
      depths.push(d.depth ?? 0);
      ttHits.push(d.ttHits ?? 0);
      cands.push(d.candidates ?? 0);
    }
    illegalTotal += illegal;
    passTotal += passes;
    const wallMs = Date.now() - wallStart;

    const row: Record<string, number | string | boolean> = {
      level,
      label: AI_LEVEL_LABELS[level],
      budgetMs: cfg.timeBudgetMs,
      states: states,
      wallMs,
      avgMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      p50Ms: pct(times, 50),
      p95Ms: pct(times, 95),
      maxMs: times.length ? Math.max(...times) : 0,
      avgNodes: nodes.length ? nodes.reduce((a, b) => a + b, 0) / nodes.length : 0,
      avgDepth: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0,
      ttHits: ttHits.reduce((a, b) => a + b, 0),
      avgCandidates: cands.length ? cands.reduce((a, b) => a + b, 0) / cands.length : 0,
      passes,
      illegal,
      legal100: illegal === 0,
    };
    out.push(row);
    console.log(
      `[benchmark] ${AI_LEVEL_LABELS[level].padEnd(9)} avg=${row.avgMs.toFixed(1)}ms  p50=${row.p50Ms}ms  p95=${row.p95Ms}ms  max=${row.maxMs}ms  ` +
        `nodes=${row.avgNodes.toFixed(0)}  depth=${row.avgDepth.toFixed(2)}  ttHits=${row.ttHits}  cand=${row.avgCandidates.toFixed(0)}  ` +
        `pass=${passes}  ILLEGAL=${illegal}`,
    );
  }

  console.log('');
  console.log(
    `TOTAL illegal=${illegalTotal}  pass=${passTotal}  internalFallbacks=${internalFallbacks}  wall=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );

  mkdirSync(join(process.cwd(), 'results'), { recursive: true });
  const file = join(process.cwd(), 'results', `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ levels: out, illegalTotal, passTotal, internalFallbacks }, null, 2));
  console.log(`saved -> ${file}`);

  if (illegalTotal > 0 || internalFallbacks > 0) process.exit(2);
}

main();
