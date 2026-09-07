/**
 * SRSZQ AI 自对弈调参评测（内部 harness，三 AI 座位）。
 *
 * 用法：
 *   npm run ai:selfplay                # 默认：6 组对阵 × 每棋盘 10 局
 *   npm run ai:selfplay -- --games 3   # 快速冒烟
 *   npm run ai:selfplay -- --size 13   # 只跑 13×13 *
 * 纯计策决策走与网页相同的计策执行层（引擎合法集唯一来源），
 * 任何 rejected / 内部非法兜底 / 异常都会使进程非零退出 —— 报告数字即真实数字。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, applyMove, skipCurrentPlayer } from '../shared/src/game/rules';
import { currentPlayerOf, getLegalMoves } from '../shared/src/game/legalMoves';
import type { BoardSize, Player } from '../shared/src/game/types';
import { chooseTacticMove } from '../shared/src/ai/chooseAIMove';
import type { AIDecision, TacticId } from '../shared/src/ai/types';
import { TACTIC_IDS } from '../shared/src/ai/types';
import { OFFLINE_TACTIC_CONFIG } from '../shared/src/ai/config/defaultWeights';
import { mulberry32 } from '../shared/src/ai/rng';

type SeatTactics = Record<Player, TacticId>;

/** 对阵表（座位 A/B/C → 计策），覆盖相邻强度与跳档。 */
const DEFAULT_COMBOS: SeatTactics[] = [
  { A: 'random', B: 'tactical', C: 'selfish' },
  { A: 'tactical', B: 'selfish', C: '3ply' },
  { A: 'selfish', B: '3ply', C: 'maxn' },
  { A: 'random', B: 'selfish', C: 'maxn' },
  { A: 'tactical', B: '3ply', C: 'maxn' },
  { A: '3ply', B: 'maxn', C: 'random' },
];

const SIZES: BoardSize[] = [13, 17];

interface TacticStats {
  decisions: number;
  nodes: number;
  ttHits: number;
  thinkMs: number;
  depthSum: number;
  wins: number;
  passCount: number;
  candidatesSum: number;
}

interface ComboResult {
  combo: string;
  size: BoardSize;
  games: number;
  wins: Record<Player, number>;
  draws: number;
  aborted: number;
  movesTotal: number;
  turnsTotal: number;
  byTactic: Record<string, TacticStats>;
}

function freshStats(): TacticStats {
  return { decisions: 0, nodes: 0, ttHits: 0, thinkMs: 0, depthSum: 0, wins: 0, passCount: 0, candidatesSum: 0 };
}

function parseArgs(argv: string[]): { games: number; sizes: BoardSize[]; combos: SeatTactics[] } {
  let games = 10;
  const sizes: BoardSize[] = [...SIZES];
  let combos = DEFAULT_COMBOS;
  let rotate = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') games = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--size') {
      const v = Number(argv[++i]);
      if (v === 13 || v === 17) {
        sizes.length = 0;
        sizes.push(v);
      }
    } else if (argv[i] === '--combo') {
      const raw = argv[++i];
      const levels = raw.split('/');
      if (levels.length === 3) {
        if (argv.includes('--combo')) {
          // 首次出现 --combo 时清空默认对阵表
          const firstIdx = argv.indexOf('--combo');
          if (i - 1 === firstIdx) combos = [];
        }
        if (levels.every((level) => TACTIC_IDS.includes(level as TacticId))) {
          combos.push({ A: levels[0] as TacticId, B: levels[1] as TacticId, C: levels[2] as TacticId });
        }
      }
    } else if (argv[i] === '--rotate') {
      rotate = true;
    }
  }
  if (rotate) {
    // 座位轮转：抵消行动顺序与 BAC 胜权窗口的座次优势，测真实计策强度。
    const rotated: SeatTactics[] = [];
    for (const c of combos) {
      const lv: TacticId[] = [c.A, c.B, c.C];
      rotated.push({ A: lv[0], B: lv[1], C: lv[2] });
      rotated.push({ A: lv[1], B: lv[2], C: lv[0] });
      rotated.push({ A: lv[2], B: lv[0], C: lv[1] });
    }
    combos = rotated;
  }
  return { games, sizes, combos };
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function main(): void {
  const { games, sizes, combos } = parseArgs(process.argv.slice(2));
  const baseSeed = 0x5a17c1;
  const rng = mulberry32(baseSeed);

  // 拦截 chooseAIMove 内部兜底（AI_INVALID_DECISION）—— 出现即视为评测失败
  let internalFallbacks = 0;
  const origError = console.error;
  console.error = (...a: unknown[]) => {
    const s = String(a[0] ?? '');
    if (s.includes('AI_INVALID_DECISION')) internalFallbacks++;
    origError(...a);
  };

  const results: ComboResult[] = [];
  const startedAt = Date.now();

  for (const combo of combos) {
    for (const size of sizes) {
      const res: ComboResult = {
        combo: `${combo.A}/${combo.B}/${combo.C}`,
        size,
        games: 0,
        wins: { A: 0, B: 0, C: 0 },
        draws: 0,
        aborted: 0,
        movesTotal: 0,
        turnsTotal: 0,
        byTactic: {},
      };
      for (const tactic of Object.values(combo)) res.byTactic[tactic] = freshStats();

      for (let g = 0; g < games; g++) {
        const gameSeed = rng.int(0x7fffffff);
        let s = createInitialState(size);
        let guard = 0;
        const MAX_TURNS = 600;

        while (s.status === 'playing' && guard < MAX_TURNS) {
          guard++;
          const cur = currentPlayerOf(s);
          const tactic = combo[cur];
          const legal = getLegalMoves(s);
          if (legal.length === 0) {
            s = skipCurrentPlayer(s);
            continue;
          }
          const decision: AIDecision = chooseTacticMove(s, cur, tactic, {
            seed: gameSeed + guard,
            timeBudgetMs: OFFLINE_TACTIC_CONFIG[tactic].timeBudgetMs,
            maxDepth: OFFLINE_TACTIC_CONFIG[tactic].maxDepth,
            candidateK: OFFLINE_TACTIC_CONFIG[tactic].candidateK,
          });
          const st = res.byTactic[tactic];
          st.decisions++;
          st.nodes += decision.nodes ?? 0;
          st.ttHits += decision.ttHits ?? 0;
          st.thinkMs += decision.thinkTimeMs ?? 0;
          st.depthSum += decision.depth ?? 0;
          st.candidatesSum += decision.candidates ?? 0;
          if (decision.pass) {
            st.passCount++;
            s = skipCurrentPlayer(s);
            continue;
          }
          const applied = applyMove(s, decision.row, decision.col);
          if (applied.rejected) {
            origError(`FATAL: illegal move by ${cur}/${tactic} at (${decision.row},${decision.col}): ${applied.rejected}`);
            process.exit(1);
          }
          s = applied.state;
        }

        res.games++;
        res.movesTotal += s.moves.length;
        res.turnsTotal += s.turnIndex;
        if (s.status === 'won' && s.winner) {
          res.wins[s.winner]++;
          res.byTactic[combo[s.winner]].wins++;
        }
        else if (s.status === 'draw') res.draws++;
        else res.aborted++;
      }
      results.push(res);

      const w = res.wins;
      const sum = res.games - res.draws - res.aborted;
      console.log(
        `[selfplay] ${res.combo.padEnd(20)} ${size}×${size}  games=${res.games}  A=${w.A} B=${w.B} C=${w.C}  draw=${res.draws} abort=${res.aborted}  avgMoves=${(res.movesTotal / Math.max(1, res.games)).toFixed(0)}`,
      );
      for (const [tactic, st] of Object.entries(res.byTactic)) {
        const n = Math.max(1, st.decisions);
        console.log(
          `           ${tactic.padEnd(9)} decisions=${st.decisions}  wins=${sum > 0 ? ((st.wins / sum) * 100).toFixed(0) : 0}%  avgThink=${(st.thinkMs / n).toFixed(0)}ms  avgNodes=${(st.nodes / n).toFixed(0)}  avgDepth=${(st.depthSum / n).toFixed(2)}  ttHits=${st.ttHits}  pass=${st.passCount}`,
        );
      }
    }
  }

  const totals = {
    combos: combos.length,
    games: results.reduce((a, r) => a + r.games, 0),
    wins: { A: 0, B: 0, C: 0 } as Record<Player, number>,
    draws: 0,
    aborted: 0,
    internalFallbacks,
    wallMs: Date.now() - startedAt,
  };
  for (const r of results) {
    totals.wins.A += r.wins.A;
    totals.wins.B += r.wins.B;
    totals.wins.C += r.wins.C;
    totals.draws += r.draws;
    totals.aborted += r.aborted;
  }
  console.log('');
  console.log(`TOTAL games=${totals.games}  A=${totals.wins.A} B=${totals.wins.B} C=${totals.wins.C} draw=${totals.draws} abort=${totals.aborted}  internalFallbacks=${internalFallbacks}  wall=${fmt(totals.wallMs)}`);

  // 结果落盘（真实数字存档）
  mkdirSync(join(process.cwd(), 'results'), { recursive: true });
  const file = join(process.cwd(), 'results', `selfplay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ totals, results }, null, 2));
  console.log(`saved -> ${file}`);

  if (internalFallbacks > 0) process.exit(2);
}

main();
