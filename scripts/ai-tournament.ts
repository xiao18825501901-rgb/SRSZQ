import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, applyMove, skipCurrentPlayer } from '../shared/src/game/rules';
import { currentPlayerOf, getLegalMoves } from '../shared/src/game/legalMoves';
import { threatCellsFor } from '../shared/src/ai/defensePolicy';
import { chooseAIMove, chooseTacticMove } from '../shared/src/ai/chooseAIMove';
import { AI_DIFFICULTIES, TACTIC_IDS, type AiDifficulty, type TacticId } from '../shared/src/ai/types';
import type { BoardSize, Player } from '../shared/src/game/types';

type Entity = AiDifficulty | TacticId;
type Seats<T extends Entity> = Record<Player, T>;
type Mode = 'pure' | 'mixed';

interface EntityStats {
  appearances: number;
  wins: number;
  decisions: number;
  seatWins: Record<Player, number>;
  latencyMs: number[];
  selectedTactics: Record<TacticId, number>;
  blocks: number;
  bacWins: number;
  fallbacks: number;
}

function args(): { games: number; searchBudgetMs: number } {
  const valueAfter = (flag: string) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  };
  return {
    games: Math.max(1, valueAfter('--games') || 5),
    searchBudgetMs: Math.max(5, valueAfter('--search-budget') || 20),
  };
}

function combinations<T extends Entity>(values: readonly T[]): Array<[T, T, T]> {
  const out: Array<[T, T, T]> = [];
  for (let i = 0; i < values.length; i++) {
    for (let j = i; j < values.length; j++) {
      for (let k = j; k < values.length; k++) out.push([values[i], values[j], values[k]]);
    }
  }
  return out;
}

function rotations<T extends Entity>(items: [T, T, T]): Seats<T>[] {
  return [
    { A: items[0], B: items[1], C: items[2] },
    { A: items[1], B: items[2], C: items[0] },
    { A: items[2], B: items[0], C: items[1] },
  ];
}

function fresh(): EntityStats {
  return {
    appearances: 0, wins: 0, decisions: 0, seatWins: { A: 0, B: 0, C: 0 }, latencyMs: [],
    selectedTactics: { random: 0, tactical: 0, selfish: 0, '3ply': 0, maxn: 0 },
    blocks: 0, bacWins: 0, fallbacks: 0,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(stats: Record<string, EntityStats>) {
  return Object.fromEntries(Object.entries(stats).map(([entity, row]) => [entity, {
    appearances: row.appearances,
    wins: row.wins,
    winRate: row.appearances ? row.wins / row.appearances : 0,
    decisions: row.decisions,
    seatWins: row.seatWins,
    selectedTactics: row.selectedTactics,
    blocks: row.blocks,
    bacWins: row.bacWins,
    fallbacks: row.fallbacks,
    latency: {
      p50: percentile(row.latencyMs, 50),
      p95: percentile(row.latencyMs, 95),
      p99: percentile(row.latencyMs, 99),
      max: row.latencyMs.length ? Math.max(...row.latencyMs) : 0,
    },
  }]));
}

function runMode<T extends Entity>(
  mode: Mode,
  values: readonly T[],
  gamesPerPermutation: number,
  searchBudgetMs: number,
): Record<string, unknown> {
  const stats = Object.fromEntries(values.map((value) => [String(value), fresh()])) as Record<string, EntityStats>;
  let games = 0;
  let draws = 0;
  let aborted = 0;
  let illegal = 0;
  let roundsTotal = 0;
  const sizes: BoardSize[] = [13, 17];
  const configs = combinations(values);

  for (let comboIndex = 0; comboIndex < configs.length; comboIndex++) {
    for (const seats of rotations(configs[comboIndex])) {
      for (const size of sizes) {
        for (let gameIndex = 0; gameIndex < gamesPerPermutation; gameIndex++) {
          games++;
          for (const seat of ['A', 'B', 'C'] as Player[]) stats[String(seats[seat])].appearances++;
          let state = createInitialState(size);
          let guard = 0;
          while (state.status === 'playing' && guard < size * size + 20) {
            guard++;
            const player = currentPlayerOf(state);
            const legal = getLegalMoves(state);
            if (legal.length === 0) {
              state = skipCurrentPlayer(state);
              continue;
            }
            const entity = seats[player];
            const seed = 0x5a170000 + (mode === 'mixed' ? 50_000_000 : 0) + comboIndex * 100_000 + size * 1000 + gameIndex * 97 + guard;
            const options = { seed, timeBudgetMs: searchBudgetMs, maxDepth: 3, candidateK: 4 };
            const started = performance.now();
            const decision = mode === 'pure'
              ? chooseTacticMove(state, player, entity as TacticId, options)
              : chooseAIMove(state, player, entity as AiDifficulty, options);
            const latency = performance.now() - started;
            const row = stats[String(entity)];
            row.decisions++;
            row.latencyMs.push(latency);
            if (decision.selectedTactic) row.selectedTactics[decision.selectedTactic]++;
            if (decision.fallbackUsed) row.fallbacks++;
            if (decision.pass) {
              state = skipCurrentPlayer(state);
              continue;
            }
            const threatKeys = new Set(
              (['A', 'B', 'C'] as Player[])
                .filter((seat) => seat !== player)
                .flatMap((seat) => threatCellsFor(state.board, seat))
                .map((cell) => `${cell.row},${cell.col}`),
            );
            if (threatKeys.has(`${decision.row},${decision.col}`)) row.blocks++;
            const applied = applyMove(state, decision.row, decision.col);
            if (applied.rejected) {
              illegal++;
              break;
            }
            state = applied.state;
            if (state.status === 'won') row.bacWins++;
          }
          roundsTotal += Math.floor(state.turnIndex / 3) + 1;
          if (state.status === 'won' && state.winner) {
            const winnerEntity = seats[state.winner];
            stats[String(winnerEntity)].wins++;
            stats[String(winnerEntity)].seatWins[state.winner]++;
          } else if (state.status === 'draw') draws++;
          else aborted++;
          if (games % 100 === 0) console.log(`[tournament:${mode}] games=${games}`);
        }
      }
    }
  }
  return {
    games, gamesPerPermutation, configurations: configs.length, seatPermutations: 3,
    boardSizes: sizes, draws, aborted, illegal, averageTerminalRound: roundsTotal / games,
    stats: summarize(stats),
  };
}

const { games, searchBudgetMs } = args();
const startedAt = Date.now();
const pure = runMode('pure', TACTIC_IDS, games, searchBudgetMs);
const mixed = runMode('mixed', AI_DIFFICULTIES, games, searchBudgetMs);
const report = { fixedSeedBase: '0x5a170000', searchBudgetMs, pure, mixed, wallMs: Date.now() - startedAt };
mkdirSync(join(process.cwd(), 'results', 'w10'), { recursive: true });
const file = join(process.cwd(), 'results', 'w10', `ai-tournament-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`saved -> ${file}`);
if ((pure.illegal as number) > 0 || (mixed.illegal as number) > 0 || (pure.aborted as number) > 0 || (mixed.aborted as number) > 0) process.exit(2);
