import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../shared/src/game/rules';
import { chooseAIMove } from '../shared/src/ai/chooseAIMove';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'results', 'fourmode-20261115', 'ASTRA_ENGINE_TRACE.json');
const sourcePaths = [
  'shared/src/ai/chooseAIMove.ts',
  'shared/src/ai/searchAgents.ts',
  'shared/src/ai/search.ts',
];

const calls = ([13, 17] as const).map((boardSize, index) => {
  const state = createInitialState(boardSize);
  const started = performance.now();
  const decision = chooseAIMove(state, 'A', 5, {
    strategy: 'astra',
    seed: 20261115 + index,
    maxDepth: 3,
    candidateK: 10,
    timeBudgetMs: 1_500,
  });
  const wallMs = performance.now() - started;
  return {
    boardSize,
    selectedTactic: decision.selectedTactic,
    reason: decision.reason,
    fallbackUsed: decision.fallbackUsed === true,
    move: { row: decision.row, col: decision.col },
    depth: decision.depth ?? null,
    nodes: decision.nodes ?? null,
    candidates: decision.candidates?.length ?? null,
    engineThinkTimeMs: decision.thinkTimeMs ?? null,
    wallMs,
  };
});

for (const call of calls) {
  if (call.selectedTactic !== 'astra' || call.fallbackUsed || (call.depth ?? 0) < 1 || (call.nodes ?? 0) < 1) {
    throw new Error(`Invalid Astra trace: ${JSON.stringify(call)}`);
  }
}

const sourceHashes = Object.fromEntries(sourcePaths.map((file) => [
  file,
  createHash('sha256').update(readFileSync(join(root, file))).digest('hex'),
]));

const report = {
  capturedAt: new Date().toISOString(),
  classification: 'REAL_ENGINE_CALL_TRACE_PERFORMANCE_ONLY',
  strengthClaim: 'NONE',
  note: 'Pure MaxN engine call from the real shared implementation. This is not a win-rate or exhaustive-tree guarantee.',
  calls,
  sourceHashes,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
