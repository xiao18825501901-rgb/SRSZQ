/**
 * Invitus persistent tactic worker（常驻 Node 进程）：
 * 通过 stdin/stdout JSONL 复用生产 shared 引擎的 chooseAIMove。
 * 入站：{"id":str,"board":string[][], "turn":int, "player":"A"|"B"|"C", "level":"random"|..., "seed":int}
 * 出站：{"id":str,"row":int,"col":int,"pass":bool,"thinkMs":number}
 */
import { chooseAIMove, chooseTacticMove } from '../../../shared/src/ai/chooseAIMove.js';
import type { GameState, Player } from '../../../shared/src/game/types.js';
import type { AiDifficulty, TacticId } from '../../../shared/src/ai/types.js';
import { currentPlayerOf, getLegalMoves } from '../../../shared/src/game/legalMoves.js';

const readline = (() => {
  // node >= 17: stdin 为异步迭代器
  return process.stdin;
})();

function toState(req: { board: (string | null)[][]; turn: number }): GameState {
  const n = req.board.length;
  const board = req.board.map((row) => row.map((c) => (c === null || c === '' || c === '.') ? null : (c as Player)));
  return { boardSize: n as 13 | 17, board, turnIndex: req.turn, moves: [], status: 'playing', winner: null, winLine: null };
}

(async () => {
  for await (const raw of readline) {
    const line = String(raw).trim();
    if (!line) continue;
    let req: any = null;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const t0 = Date.now();
    let out: Record<string, unknown> = { id: req.id };
    try {
      const st = toState(req);
      const legal = getLegalMoves(st);
      if (st.status !== 'playing' || legal.length === 0 || currentPlayerOf(st) !== req.player) {
        out = { ...out, row: -1, col: -1, pass: true, thinkMs: 0 };
      } else {
        const opts = { seed: req.seed, timeBudgetMs: 250, candidateK: 8, maxDepth: 3 };
        const d = req.tactic
          ? chooseTacticMove(st, req.player, req.tactic as TacticId, opts)
          : chooseAIMove(st, req.player, req.difficulty as AiDifficulty, opts);
        out = { ...out, row: d.row, col: d.col, pass: d.pass, thinkMs: Date.now() - t0, reason: d.reason ?? '' };
      }
    } catch (e) {
      out = { ...out, row: -1, col: -1, pass: true, thinkMs: 0, error: String((e as Error)?.stack ?? e).slice(0, 400) };
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  }
})();
