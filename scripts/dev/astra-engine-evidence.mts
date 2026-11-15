import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chooseAIMove } from '../../shared/src/ai/chooseAIMove';
import { createInitialState } from '../../shared/src/game/rules';
import { getLegalMoves } from '../../shared/src/game/legalMoves';

const output = resolve(process.argv[2] ?? 'evidence/fourmode-chat/ASTRA_ENGINE_EVIDENCE.json');
const runs = ([13, 17] as const).map((boardSize) => {
  const state = createInitialState(boardSize);
  const started = performance.now();
  const decision = chooseAIMove(state, 'A', 5, {
    strategy: 'astra',
    seed: 20261115 + boardSize,
    timeBudgetMs: 600,
    maxDepth: 2,
    candidateK: 6,
  });
  const elapsedMs = performance.now() - started;
  const legal = getLegalMoves(state).some((move) => move.row === decision.row && move.col === decision.col);
  return {
    boardSize,
    requested: {
      strategy: 'astra',
      timeBudgetMs: 600,
      maxDepth: 2,
      candidateK: 6,
      seed: 20261115 + boardSize,
    },
    decision: {
      row: decision.row,
      col: decision.col,
      pass: decision.pass,
      selectedTactic: decision.selectedTactic,
      reason: decision.reason,
      depth: decision.depth,
      nodes: decision.nodes,
      ttHits: decision.ttHits,
      candidates: decision.candidates,
      fallbackUsed: decision.fallbackUsed ?? false,
    },
    elapsedMs,
    legal,
  };
});

const report = {
  status: runs.every((run) => run.legal && run.decision.selectedTactic === 'astra' && !run.decision.pass)
    ? 'PASS_ENGINE_WIRING'
    : 'FAIL_ENGINE_WIRING',
  testedAt: new Date().toISOString(),
  qualification: 'REAL_ENGINE_CALL_NOT_A_STRENGTH_RESULT',
  note: 'Astra is a bounded MaxN search over the selected candidate width. It is not a full game-tree solve and does not guarantee a win.',
  runs,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS_ENGINE_WIRING' ? 0 : 1);
