import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '../shared/src/ai/rng';
import { selectTactic, TACTIC_PROFILES } from '../shared/src/ai/tacticMixer';
import { AI_DIFFICULTIES, TACTIC_IDS } from '../shared/src/ai/types';

const samples = Math.max(100_000, Number(process.argv[process.argv.indexOf('--samples') + 1]) || 100_000);
const rows = [];
let failed = false;

for (const difficulty of AI_DIFFICULTIES) {
  const rng = mulberry32(0x10cafe + difficulty * 104729);
  const counts = Object.fromEntries(TACTIC_IDS.map((tactic) => [tactic, 0])) as Record<(typeof TACTIC_IDS)[number], number>;
  for (let i = 0; i < samples; i++) counts[selectTactic(difficulty, rng)]++;
  const actual = Object.fromEntries(TACTIC_IDS.map((tactic) => [tactic, counts[tactic] / samples]));
  const maxAbsoluteError = Math.max(...TACTIC_IDS.map((tactic) => Math.abs(actual[tactic] - TACTIC_PROFILES[difficulty][tactic])));
  const expectedRank = TACTIC_IDS.reduce((sum, tactic, index) => sum + (index + 1) * TACTIC_PROFILES[difficulty][tactic], 0);
  rows.push({ difficulty, samples, target: TACTIC_PROFILES[difficulty], counts, actual, maxAbsoluteError, expectedRank });
  if (maxAbsoluteError > 0.01 || Object.values(counts).some((count) => count === 0)) failed = true;
  console.log(`[distribution] ${difficulty}★ n=${samples} maxError=${(maxAbsoluteError * 100).toFixed(3)}% expectedRank=${expectedRank.toFixed(2)}`);
}

mkdirSync(join(process.cwd(), 'results', 'w10'), { recursive: true });
const file = join(process.cwd(), 'results', 'w10', `tactic-distribution-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ samplesPerDifficulty: samples, tolerance: 0.01, rows }, null, 2));
console.log(`saved -> ${file}`);
if (failed) process.exit(2);
