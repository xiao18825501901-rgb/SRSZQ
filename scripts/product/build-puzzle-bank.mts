/**
 * 题库生成器（P2 / B4 第二批，R07）。
 *
 *   npx tsx scripts/product/build-puzzle-bank.mts
 *
 * 输入：
 *  - scripts/product/sources/prod-human-trajectories-*.json：从生产库只读导出的真实对局持久事件流；
 *  - 固定种子的自对弈轨迹（真实引擎、只用合法手），按三种策略走出不同形态的局面：
 *      random-legal    纯随机合法手（局面自然铺开）
 *      threat-seeking  有胜权时优先走自己的致胜点（多产出「当前胜点」题）
 *      preempt-biased  有胜权时优先占掉对手的致胜点（多产出「跨轮提前防守」题）
 * 输出：shared/src/product/puzzleBank.generated.ts（题库 + 紧凑编码轨迹 + 元信息，自包含）。
 *
 * 为什么把轨迹一起写进产物：测试可以**在测试里重跑一遍抽取算法**，断言提交进仓库的题库
 * 就是这批轨迹用这套算法算出来的那一份，而不是被手工编辑过的文件。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyMove, createInitialState } from '../../shared/src/game/rules.js';
import { currentPlayerIsEligible, currentPlayerOf, getLegalMoves, getWinningPoints, isLegalMove } from '../../shared/src/game/legalMoves.js';
import { getEligiblePlayer, roundFromTurn } from '../../shared/src/game/eligibility.js';
import { countLine } from '../../shared/src/game/winDetection.js';
import { nextActionTurnIndex } from '../../shared/src/product/replay.js';
import {
  buildPuzzleBank, packTrailMoves,
  type PackedTrail, type PuzzleSourceKind, type Trail, type TrailMove,
} from '../../shared/src/product/puzzleBank.js';
import { PLAYERS, type BoardSize, type GameState, type Player } from '../../shared/src/game/types.js';

const SOURCE_DIR = 'scripts/product/sources';
const OUT = 'shared/src/product/puzzleBank.generated.ts';
const TARGET = 60;
const GEN_NAME = 'scripts/product/build-puzzle-bank.mts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
}

function threatenedPointsAt(state: GameState, actor: Player) {
  const out = [];
  for (const other of PLAYERS) {
    if (other === actor) continue;
    const nextTurn = nextActionTurnIndex(actor, state.turnIndex, other);
    if (getEligiblePlayer(roundFromTurn(nextTurn)) !== other) continue;
    out.push(...getWinningPoints(state.board, other));
  }
  return out;
}

/** 自对弈：每手在引擎给出的合法手里按策略挑一个。只用合法手 ⇒ 轨迹必然合法可重放。 */
/** 落子后该玩家在四条方向上最长的一条连线（用于“把自己走到刚好三连”这种定向策略）。 */
function maxLineThrough(board: GameState['board'], row: number, col: number, player: Player): number {
  let best = 0;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as Array<[number, number]>) {
    best = Math.max(best, countLine(board, row, col, player, dr, dc));
  }
  return best;
}

function selfplay(gameId: string, boardSize: BoardSize, seed: number, policy: string, maxPlies = 320): Trail {
  const rnd = lcg(seed);
  let state = createInitialState(boardSize);
  const moves: TrailMove[] = [];
  while (state.status === 'playing' && moves.length < maxPlies) {
    const legal = getLegalMoves(state);
    if (legal.length === 0) break;
    let pick = legal[rnd() % legal.length];
    if (policy === 'forbidden-builder' && !currentPlayerIsEligible(state)) {
      // 无胜权的一方主动把自己连成三：这样“补第四子”的格子就成了自己的禁手，
      // 若这些格子恰好也是对手的致胜点，就产生规格要的「禁手防守冲突」局面。
      const actor = currentPlayerOf(state);
      let bestScore = -1;
      const best = [];
      for (const cand of legal) {
        const score = maxLineThrough(state.board, cand.row, cand.col, actor);
        if (score > bestScore) { bestScore = score; best.length = 0; best.push(cand); }
        else if (score === bestScore) best.push(cand);
      }
      if (best.length > 0) pick = best[rnd() % best.length];
    } else if (policy !== 'random-legal' && currentPlayerIsEligible(state)) {
      const actor = currentPlayerOf(state);
      const pool = policy === 'threat-seeking'
        ? getWinningPoints(state.board, actor).filter((c) => isLegalMove(state, c.row, c.col))
        : threatenedPointsAt(state, actor);
      if (pool.length > 0) pick = pool[rnd() % pool.length];
    }
    const seat = ['A', 'B', 'C'][state.turnIndex % 3] as TrailMove['seat'];
    const res = applyMove(state, pick.row, pick.col);
    if (res.rejected) throw new Error('自对弈产生了非法手：' + res.rejected);
    moves.push({ seat, row: pick.row, col: pick.col });
    state = res.state;
  }
  return {
    gameId, boardSize, sourceKind: 'SYNTHETIC_SELFPLAY', policy, moves,
    terminal: state.status === 'won' ? 'win' : state.status === 'draw' ? 'draw' : 'open',
  };
}

function loadProdTrails(): Trail[] {
  const files = readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.json')).sort();
  const trails: Trail[] = [];
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(SOURCE_DIR, f), 'utf8')) as {
      trails: Array<{ gameId: string; boardSize: BoardSize; sourceKind: PuzzleSourceKind; moves: TrailMove[]; endReason?: string | null }>;
    };
    for (const t of doc.trails) {
      trails.push({
        gameId: t.gameId,
        boardSize: t.boardSize,
        sourceKind: t.sourceKind,
        policy: 'human-production',
        moves: t.moves,
        terminal: t.endReason === 'NORMAL_WIN' ? 'win' : t.endReason === 'BOARD_DRAW' ? 'draw' : 'open',
      });
    }
  }
  return trails;
}

const prodTrails = loadProdTrails();
const SELFPLAY: Array<[string, BoardSize, number, string]> = [
  ['selfplay-13-s11', 13, 11, 'random-legal'],
  ['selfplay-13-s23', 13, 23, 'random-legal'],
  ['selfplay-17-s20260930', 17, 20260930, 'random-legal'],
  ['selfplay-17-s7', 17, 7, 'random-legal'],
  ['selfplay-13-s99', 13, 99, 'random-legal'],
  ['selfplay-17-s1234', 17, 1234, 'random-legal'],
  ['selfplay-13-preempt-s31', 13, 31, 'preempt-biased'],
  ['selfplay-13-preempt-s47', 13, 47, 'preempt-biased'],
  ['selfplay-13-preempt-s59', 13, 59, 'preempt-biased'],
  ['selfplay-17-preempt-s71', 17, 71, 'preempt-biased'],
  ['selfplay-17-preempt-s83', 17, 83, 'preempt-biased'],
  ['selfplay-17-preempt-s97', 17, 97, 'preempt-biased'],
  ['selfplay-13-threat-s101', 13, 101, 'threat-seeking'],
  ['selfplay-17-threat-s113', 17, 113, 'threat-seeking'],
  ['selfplay-13-threat-s127', 13, 127, 'threat-seeking'],
  ['selfplay-17-threat-s139', 17, 139, 'threat-seeking'],
  ['selfplay-13-forbidden-s151', 13, 151, 'forbidden-builder'],
  ['selfplay-13-forbidden-s163', 13, 163, 'forbidden-builder'],
  ['selfplay-13-forbidden-s179', 13, 179, 'forbidden-builder'],
  ['selfplay-17-forbidden-s191', 17, 191, 'forbidden-builder'],
  ['selfplay-17-forbidden-s211', 17, 211, 'forbidden-builder'],
  ['selfplay-17-forbidden-s223', 17, 223, 'forbidden-builder'],
];
const selfTrails = SELFPLAY.map(([id, size, seed, policy]) => selfplay(id, size, seed, policy));
const all = [...prodTrails, ...selfTrails];
const built = buildPuzzleBank(all, { target: TARGET, generator: GEN_NAME });

const packed: PackedTrail[] = all.map((t) => ({
  gameId: t.gameId,
  boardSize: t.boardSize,
  sourceKind: t.sourceKind,
  policy: t.policy ?? 'unspecified',
  packed: packTrailMoves(t.moves),
}));

const lines: string[] = [];
lines.push('/**');
lines.push(' * SRSZQ 题库 V1 —— **自动生成，请勿手工编辑**。');
lines.push(' * 重新生成：npx tsx ' + GEN_NAME);
lines.push(' *');
lines.push(' * 只有引擎验证通过（status=PUBLISHED）的题会被每日题与正式判题取用；');
lines.push(' * PENDING 的题写明了原因（验证未通过，或验证通过但首批数量上限未收录）。');
lines.push(' *');
lines.push(' * 轨迹以紧凑编码（seat+base36(row)+base36(col)，一手 3 字符）一并写入，');
lines.push(' * 使题库可以被离线复核：测试会用同一套算法从这些轨迹重算出题库并逐条比对。');
lines.push(' */');
lines.push("import type { PackedTrail, Puzzle, PuzzleBankMeta } from './puzzleBank.js';");
lines.push('');
lines.push('export const PUZZLE_TRAJECTORIES_PACKED: PackedTrail[] = [');
for (const t of packed) lines.push('  ' + JSON.stringify(t) + ',');
lines.push('];');
lines.push('');
lines.push('/** 只写已发布的题：未收录/未验证的题不落进产物，其计数在 meta 里，');
lines.push(' * 且随时可由这些轨迹重跑算法得到（测试就是这么做的）。 */');
lines.push('export const PUZZLE_BANK: Puzzle[] = [');
for (const pz of built.puzzles.filter((x) => x.status === 'PUBLISHED')) lines.push('  ' + JSON.stringify(pz) + ',');
lines.push('];');
lines.push('');
lines.push('export const PUZZLE_BANK_META: PuzzleBankMeta = ' + JSON.stringify(built.meta, null, 1) + ';');
lines.push('');
writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log('=== 题库生成结果 ===');
console.log('trails=' + all.length + '（生产 ' + prodTrails.length + ' / 自对弈 ' + selfTrails.length + '），总手数=' + built.meta.trajectoryPlies);
console.log('published=' + built.meta.total + ' pending=' + built.meta.byStatus.PENDING + '（未收录 ' + built.meta.pendingNotSelected + '，验证拒绝 ' + built.meta.pendingRejectedByVerification + '）去重=' + built.meta.duplicatesRemoved);
console.log('byType=' + JSON.stringify(built.meta.byType));
console.log('bySource=' + JSON.stringify(built.meta.bySource));
console.log('bySplit=' + JSON.stringify(built.meta.bySplit));
console.log('byPolicy=' + JSON.stringify(built.meta.byPolicy));
console.log('真正存在禁手冲突的题=' + built.meta.forbiddenConflictPositions + '，无合法防守点局面（如实计数）=' + built.meta.noLegalBlockPositions);
console.log('bankHash=' + built.meta.bankHash);