/**
 * SRSZQ P2(B4 第二批) —— 题库 V1：从**真实完整轨迹**抽题、引擎验证、完整答案集与判题。
 *
 * 规格来源：01_PRODUCT_IMPLEMENTATION_SPEC_CN.md 6.2（题库 V1）、5.1（不依赖 LLM 的解释）、6.1（标准数据）。
 * 验收矩阵：R07 发布题库、R08 每日题/错题（未审核研究题不混进正式判题）。
 *
 * 四条自我约束（都是规格明写的红线）：
 *  1. 题目只能来自**合法完整轨迹**：抽取用真实 applyMove 逐步重放，越界/禁手/违反行动序的轨迹抽不出题。
 *  2. 即时胜利题枚举**全部**合法致胜点，绝不只留引擎选中的那一个；答案集用穷举扫描得到。
 *  3. 跨轮防守题只在“有精确一步证明”的范围内命名：只有一个威胁时才能说“挡住即解除”，
 *     多个威胁时只能诚实地写“占掉其中一个，还剩 N 个”，不写成解杀。
 *  4. 没有已证明答案集的题一律进不了正式题库（answerSetComplete=false 的只能按开放研究题处理，判题返回 OPEN）。
 */
import type { BoardSize, CellPos, GameState, Player } from '../game/types.js';
import { applyMove, createInitialState } from '../game/rules.js';
import { getEligiblePlayer, playerFromTurn, roundFromTurn } from '../game/eligibility.js';
import { getForbiddenCells, getLegalMoves, getWinningPoints, isLegalMove } from '../game/legalMoves.js';
import { RULESET_VERSION } from './protocol.js';
import { stableDigest } from './resultModel.js';
import { nextActionTurnIndex, replayGame, stateDigest, type PersistedEvent } from './replay.js';

/** 抽题器的版本号：题目里记录它，题库才不会把两代算法产出的题混为一谈。 */
export const PUZZLE_SOLVER_VERSION = 'puzzle-solver-v1-exact-one-ply';
export const PUZZLE_SCHEMA = 1;

export type PuzzleAcceptanceType =
  | 'WIN_NOW'                // 当前胜权在你手上：找出全部致胜点
  | 'PREEMPT_LAST_THREAT'    // 对手下个行动回合能成四，且这是它唯一的致胜点：占掉它即解除
  | 'PREEMPT_ONE_THREAT'     // 对手有多个致胜点：占掉其中一个（不声称解杀）
  | 'FORBIDDEN_BLOCK';       // 你没有胜权，还得在禁手约束下找到合法防守点
export type PuzzleStatus = 'PUBLISHED' | 'PENDING' | 'RETRACTED';
export type PuzzleSplit = 'train' | 'dev' | 'test';
export type PuzzleSourceKind = 'HUMAN_ONLINE' | 'ONLINE_AI_BACKFILL' | 'SYNTHETIC_SELFPLAY';

export interface TrailMove { seat: Player; row: number; col: number }

/** 一条完整轨迹（合法来源）。moves 按真实行动顺序排列。 */
export interface Trail {
  gameId: string;
  boardSize: BoardSize;
  sourceKind: PuzzleSourceKind;
  /** 自对弈轨迹的选点策略（真实对局没有这一项）。写进产物里，读者能看到题目是怎么走出来的。 */
  policy?: string;
  moves: TrailMove[];
  terminal?: 'win' | 'draw' | 'open';
}

/**
 * 轨迹的紧凑编码：seat + base36(row) + base36(col)，一手 3 个字符。
 * 题库产物里轨迹是大头（几千手），不压缩会让仓库里多出几百 KB 的机器生成文件。
 */
export function packTrailMoves(moves: TrailMove[]): string {
  let out = '';
  for (const m of moves) {
    if (m.row < 0 || m.row > 35 || m.col < 0 || m.col > 35) throw new Error('坐标超出紧凑编码范围: ' + m.row + ',' + m.col);
    out += m.seat + m.row.toString(36) + m.col.toString(36);
  }
  return out;
}

export function unpackTrailMoves(packed: string): TrailMove[] {
  if (packed.length % 3 !== 0) throw new Error('紧凑轨迹长度必须是 3 的倍数');
  const moves: TrailMove[] = [];
  for (let i = 0; i < packed.length; i += 3) {
    const seat = packed[i] as Player;
    if (seat !== 'A' && seat !== 'B' && seat !== 'C') throw new Error('紧凑轨迹出现非法座位: ' + seat);
    const row = parseInt(packed[i + 1], 36);
    const col = parseInt(packed[i + 2], 36);
    if (!Number.isInteger(row) || !Number.isInteger(col)) throw new Error('紧凑轨迹坐标无法解析');
    moves.push({ seat, row, col });
  }
  return moves;
}

/** 产物里实际存放的轨迹形态。 */
export interface PackedTrail {
  gameId: string;
  boardSize: BoardSize;
  sourceKind: PuzzleSourceKind;
  policy: string;
  packed: string;
}

export function expandTrails(packed: PackedTrail[]): Trail[] {
  return packed.map((t) => ({
    gameId: t.gameId,
    boardSize: t.boardSize,
    sourceKind: t.sourceKind,
    policy: t.policy,
    moves: unpackTrailMoves(t.packed),
  }));
}

export interface PuzzleAnswer { row: number; col: number }

export interface Puzzle {
  puzzleId: string;
  schema: number;
  acceptanceType: PuzzleAcceptanceType;
  boardSize: BoardSize;
  sourceGameId: string;
  sourceKind: PuzzleSourceKind;
  /** 1-based：这条题目关于轨迹里的第几手 */
  sourcePly: number;
  /** 起始局面 = 轨迹前 startPly 手（重建时用真实引擎走一遍） */
  startPly: number;
  actorSeat: Player;
  round: number;
  eligiblePlayer: Player | null;
  threatenedSeat: Player | null;
  /** **完整**答案集（穷举得到）；answerSetComplete=false 表示未证明唯一/完整，只能当研究题 */
  answers: PuzzleAnswer[];
  answerSetComplete: boolean;
  threatsBefore: number;
  threatsAfter: number;
  /** 与被忽略的候选点数量（例如既是威胁点又是自己的禁手） */
  excludedByForbidden: number;
  explanation: { messageKey: string; args: Record<string, string | number> };
  solver: { solverVersion: string; depth: number; budget: string; nodes: number };
  status: PuzzleStatus;
  stateDigest: string;
  split: PuzzleSplit;
  reviewNote: string;
}

export interface PuzzleBankMeta {
  bankVersion: string;
  schema: number;
  solverVersion: string;
  rulesetVersion: string;
  generator: string;
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  bySplit: Record<string, number>;
  byStatus: Record<string, number>;
  byPolicy: Record<string, number>;
  duplicatesRemoved: number;
  rejectedByVerification: number;
  /** 验证通过但本轮未收录（首批做了数量上限；未收录不等于题目有问题） */
  pendingNotSelected: number;
  /** 抽出来但因验证未通过而未发布的题数 */
  pendingRejectedByVerification: number;
  noLegalBlockPositions: number;
  /** 真的存在“既是威胁点、又是自己禁手”的冲突局面的题数（规格 6.2 的第三类核心） */
  forbiddenConflictPositions: number;
  researchOpenCount: number;
  bankHash: string;
  trajectoryCount: number;
  trajectoryPlies: number;
}

/** 轨迹 → 持久事件（复用 replayGame 的逐手真实引擎校验）。 */
export function trailToEvents(trail: Trail): PersistedEvent[] {
  return trail.moves.map((m, i) => ({
    seq: i + 1,
    revision: i + 1,
    type: 'move.applied',
    payload: { seat: m.seat, row: m.row, col: m.col },
  }));
}

/** 由轨迹前缀重建起始局面；任何一手非法都会抛错而不是被吞掉。 */
export function startStateOf(boardSize: BoardSize, trail: Trail, startPly: number): GameState {
  let state = createInitialState(boardSize);
  for (let i = 0; i < startPly; i += 1) {
    const m = trail.moves[i];
    if (!m) throw new Error('startPly 超出轨迹长度');
    const res = applyMove(state, m.row, m.col);
    if (res.rejected) throw new Error('轨迹第 ' + (i + 1) + ' 手非法: ' + res.rejected);
    state = res.state;
  }
  return state;
}

/** 对手在其**下一个真实行动回合**是否持有胜权（规格 5.1 的跨轮口径）。 */
function threatSeatsAt(state: GameState, actor: Player): Player[] {
  const out: Player[] = [];
  for (const other of ['A', 'B', 'C'] as Player[]) {
    if (other === actor) continue;
    const nextTurn = nextActionTurnIndex(actor, state.turnIndex, other);
    if (getEligiblePlayer(roundFromTurn(nextTurn)) === other) out.push(other);
  }
  return out;
}

export function splitForGame(gameId: string, schema = PUZZLE_SCHEMA): PuzzleSplit {
  // 先按 gameId 分：同一局的所有题目必须落在同一个 split，否则同局泄漏。
  // 三等分（而不是 60/20/20）：首批题量还不大，偏斜的分法会出现某个 split 恒为 0。
  const n = parseInt(stableDigest(schema + ':' + gameId).slice(0, 8), 16) % 3;
  return n === 0 ? 'train' : n === 1 ? 'dev' : 'test';
}

export interface ExtractResult { puzzles: Puzzle[]; noLegalBlockPositions: number; duplicates: number }

/**
 * 从一条完整轨迹抽题。对每一手都看**该手之前的局面**，只产出有精确一步证明的题目。
 * 抽取本身不做判断力假设：题面是“这个局面下的已证明事实”，不是“你该怎么下更好”。
 */
export function extractPuzzles(trail: Trail, opts: { maxPerTrail?: number } = {}): ExtractResult {
  const maxPerTrail = opts.maxPerTrail ?? 40;
  const outcome = replayGame(trail.boardSize, trailToEvents(trail));
  if (!outcome.ok) throw new Error('轨迹无法重放: ' + outcome.errors.join('; '));
  const puzzles: Puzzle[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let noLegalBlockPositions = 0;

  const push = (pz: Puzzle): void => {
    const key = pz.stateDigest + '|' + pz.acceptanceType;
    if (seen.has(key)) { duplicates += 1; return; }
    seen.add(key);
    puzzles.push(pz);
  };

  const split = splitForGame(trail.gameId);
  for (let i = 0; i < outcome.steps.length && puzzles.length < maxPerTrail; i += 1) {
    const step = outcome.steps[i];
    const before = outcome.frames[i].before;
    if (before.status !== 'playing') break;
    const actor = step.seat;
    const eligible = step.eligiblePlayer;
    const actorEligible = eligible === actor;
    const digest = stateDigest(before);
    const base = {
      schema: PUZZLE_SCHEMA,
      boardSize: trail.boardSize,
      sourceGameId: trail.gameId,
      sourceKind: trail.sourceKind,
      sourcePly: i + 1,
      startPly: i,
      actorSeat: actor,
      round: step.round,
      eligiblePlayer: eligible,
      solver: { solverVersion: PUZZLE_SOLVER_VERSION, depth: 1, budget: 'exhaustive-scan', nodes: 0 },
      status: 'PUBLISHED' as PuzzleStatus,
      stateDigest: digest,
      split,
      reviewNote: '',
    };

    // 类型一：当前胜权在手 —— 找出全部致胜点。
    if (actorEligible) {
      const nodes = before.boardSize * before.boardSize;
      // 注意 isLegalMove(state, row, col) 是三参数：传 CellPos 对象会被当成 row 而恒为 false。
      const winning = getWinningPoints(before.board, actor).filter((c) => isLegalMove(before, c.row, c.col));
      if (winning.length > 0) {
        push({
          ...base,
          puzzleId: trail.gameId + ':ply' + (i + 1) + ':win-now',
          acceptanceType: 'WIN_NOW',
          threatenedSeat: null,
          answers: winning.map((c) => ({ row: c.row, col: c.col })),
          answerSetComplete: true,
          threatsBefore: 0,
          threatsAfter: 0,
          excludedByForbidden: 0,
          explanation: {
            messageKey: 'PUZZLE_WIN_NOW',
            args: { seat: actor, round: step.round, points: winning.length },
          },
          solver: { solverVersion: PUZZLE_SOLVER_VERSION, depth: 1, budget: 'exhaustive-scan', nodes },
        });
      }
    }

    // 类型二 / 三：对手威胁（含无胜权时的禁手防守冲突）。
    for (const threatened of threatSeatsAt(before, actor)) {
      const points = getWinningPoints(before.board, threatened);
      if (points.length === 0) continue;
      const afterIdx = i < outcome.frames.length ? outcome.frames[i].after : before;
      const remaining = getWinningPoints(afterIdx.board, threatened).length;
      const nodes = before.boardSize * before.boardSize;

      if (actorEligible) {
        const playedIsThreat = points.some((c) => c.row === step.row && c.col === step.col);
        if (!playedIsThreat) continue;
        const last = points.length === 1;
        push({
          ...base,
          puzzleId: trail.gameId + ':ply' + (i + 1) + ':preempt-' + threatened,
          acceptanceType: last ? 'PREEMPT_LAST_THREAT' : 'PREEMPT_ONE_THREAT',
          threatenedSeat: threatened,
          answers: points.map((c) => ({ row: c.row, col: c.col })),
          answerSetComplete: true,
          threatsBefore: points.length,
          threatsAfter: remaining,
          excludedByForbidden: 0,
          explanation: last
            ? { messageKey: 'PUZZLE_PREEMPT_LAST', args: { threatened, round: step.round, row: step.row, col: step.col } }
            : { messageKey: 'PUZZLE_PREEMPT_ONE_OF', args: { threatened, round: step.round, points: points.length, remaining } },
          solver: { solverVersion: PUZZLE_SOLVER_VERSION, depth: 1, budget: 'exhaustive-scan', nodes },
        });
        continue;
      }

      // 类型三：你没有胜权 —— 既是威胁点又是你禁手的格子不能作为答案。
      const legalBlocks = points.filter((c) => isLegalMove(before, c.row, c.col));
      const forbiddenCount = points.length - legalBlocks.length;
      if (legalBlocks.length === 0) {
        noLegalBlockPositions += 1;
        continue;
      }
      push({
        ...base,
        puzzleId: trail.gameId + ':ply' + (i + 1) + ':forbidden-' + threatened,
        acceptanceType: 'FORBIDDEN_BLOCK',
        threatenedSeat: threatened,
        answers: legalBlocks.map((c) => ({ row: c.row, col: c.col })),
        answerSetComplete: true,
        threatsBefore: points.length,
        threatsAfter: remaining,
        excludedByForbidden: forbiddenCount,
        explanation: {
          messageKey: 'PUZZLE_FORBIDDEN_BLOCK',
          args: { threatened, round: step.round, blocks: legalBlocks.length, forbidden: forbiddenCount, forbiddenCells: getForbiddenCells(before).length },
        },
        solver: { solverVersion: PUZZLE_SOLVER_VERSION, depth: 1, budget: 'exhaustive-scan', nodes },
      });
    }
  }
  return { puzzles, noLegalBlockPositions, duplicates };
}

export interface PuzzleVerification { ok: boolean; failures: string[]; recomputedAnswers: PuzzleAnswer[] }

/**
 * 独立复核一道题：从轨迹前缀重建起始局面，再用穷举扫描**重算**答案集，
 * 与题面里的 answers 做集合比较。验证不通过的一律不能进正式题库。
 */
export function verifyPuzzle(puzzle: Puzzle, trail: Trail): PuzzleVerification {
  const failures: string[] = [];
  let state: GameState;
  try {
    state = startStateOf(puzzle.boardSize, trail, puzzle.startPly);
  } catch (e) {
    return { ok: false, failures: ['起始局面无法重建: ' + (e instanceof Error ? e.message : String(e))], recomputedAnswers: [] };
  }
  if (playerFromTurn(state.turnIndex) !== puzzle.actorSeat) failures.push('起始局面的行棋方与 actorSeat 不一致');
  if (playerFromTurn(state.turnIndex) !== playerFromTurn(puzzle.startPly)) failures.push('起始局面回合序号与 startPly 不一致');
  if (stateDigest(state) !== puzzle.stateDigest) failures.push('起始局面摘要与题面不一致');

  const recomputed: CellPos[] = [];
  if (puzzle.acceptanceType === 'WIN_NOW') {
    const eligible = getEligiblePlayer(roundFromTurn(state.turnIndex));
    if (eligible !== puzzle.actorSeat) failures.push('WIN_NOW 题必须发生在该玩家持有胜权的回合');
    for (const c of getWinningPoints(state.board, puzzle.actorSeat)) {
      if (isLegalMove(state, c.row, c.col)) recomputed.push(c);
    }
  } else {
    const threatened = puzzle.threatenedSeat;
    if (!threatened) {
      failures.push('非 WIN_NOW 题必须标明被威胁方');
    } else {
      const seats = threatSeatsAt(state, puzzle.actorSeat);
      if (!seats.includes(threatened)) failures.push('被威胁方在该手的下一个真实行动回合并不持有胜权');
      for (const c of getWinningPoints(state.board, threatened)) {
        if (puzzle.acceptanceType === 'FORBIDDEN_BLOCK') {
          if (isLegalMove(state, c.row, c.col)) recomputed.push(c);
        } else {
          recomputed.push(c);
        }
      }
      if (puzzle.acceptanceType === 'FORBIDDEN_BLOCK' && getEligiblePlayer(roundFromTurn(state.turnIndex)) === puzzle.actorSeat) {
        failures.push('FORBIDDEN_BLOCK 题必须发生在该玩家没有胜权的回合');
      }
      if (puzzle.acceptanceType === 'PREEMPT_LAST_THREAT' && recomputed.length !== 1) {
        failures.push('PREEMPT_LAST_THREAT 声称“唯一威胁”，但重算得到 ' + recomputed.length + ' 个');
      }
    }
  }

  const norm = (list: Array<{ row: number; col: number }>): string[] =>
    list.map((c) => c.row + ',' + c.col).sort();
  const a = norm(puzzle.answers);
  const b = norm(recomputed);
  if (a.join('|') !== b.join('|')) {
    failures.push('答案集与重算结果不一致：题面 ' + a.join(';') + ' 重算 ' + b.join(';'));
  }
  if (a.length === 0) failures.push('答案集为空');
  if (!puzzle.answerSetComplete) failures.push('answerSetComplete=false 的题不得作为正式题');
  return { ok: failures.length === 0, failures, recomputedAnswers: recomputed.map((c) => ({ row: c.row, col: c.col })) };
}

export type AttemptVerdict = 'CORRECT' | 'INCORRECT' | 'ILLEGAL' | 'OPEN';

export interface GradeResult { verdict: AttemptVerdict; isAnswer: boolean; answerCount: number }

/**
 * 判题。三种正式题都拿**完整**答案集比对：集合里的任何一点都算对，
 * 绝不把启发式第二名说成唯一错误（规格 6.2/R05）。没有已证明答案集的题返回 OPEN。
 */
export function gradeAnswer(puzzle: Puzzle, trail: Trail, row: number, col: number): GradeResult {
  const answers = puzzle.answers;
  const isAnswer = answers.some((c) => c.row === row && c.col === col);
  if (!puzzle.answerSetComplete) return { verdict: 'OPEN', isAnswer, answerCount: answers.length };
  if (isAnswer) return { verdict: 'CORRECT', isAnswer: true, answerCount: answers.length };
  let state: GameState;
  try {
    state = startStateOf(puzzle.boardSize, trail, puzzle.startPly);
  } catch {
    return { verdict: 'ILLEGAL', isAnswer: false, answerCount: answers.length };
  }
  const legal = getLegalMoves(state).some((c) => c.row === row && c.col === col);
  return { verdict: legal ? 'INCORRECT' : 'ILLEGAL', isAnswer: false, answerCount: answers.length };
}

export interface BankBuildResult { puzzles: Puzzle[]; meta: PuzzleBankMeta }

/**
 * 由轨迹集合构建题库：抽取 → 去重 → 验证 → 只发布验证通过的题。
 * 排序固定（sourceGameId, sourcePly, 类型），保证同一批轨迹每次得到同一个题库。
 */
export function buildPuzzleBank(
  trails: Trail[],
  opts: { target?: number; bankVersion?: string; generator?: string; maxPerTrail?: number } = {},
): BankBuildResult {
  const target = opts.target ?? 60;
  const sorted = [...trails].sort((a, b) => a.gameId.localeCompare(b.gameId));
  const byGame = new Map<string, Trail>();
  for (const t of sorted) byGame.set(t.gameId, t);

  const collected: Puzzle[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let noLegalBlockPositions = 0;
  let rejected = 0;
  for (const trail of sorted) {
    const res = extractPuzzles(trail, { maxPerTrail: opts.maxPerTrail ?? 40 });
    noLegalBlockPositions += res.noLegalBlockPositions;
    duplicates += res.duplicates;
    for (const pz of res.puzzles) {
      const key = pz.stateDigest + '|' + pz.acceptanceType;
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      const v = verifyPuzzle(pz, trail);
      if (!v.ok) {
        rejected += 1;
        collected.push({ ...pz, status: 'PENDING', reviewNote: '验证未通过：' + v.failures.join('；') });
        continue;
      }
      collected.push({ ...pz, status: 'PUBLISHED', reviewNote: '' });
    }
  }

  // 排序：人类真实对局优先，其次来源与位置稳定 —— 保证同一批轨迹每次得到同一个顺序。
  const rank = (x: Puzzle): number => (x.sourceKind === 'HUMAN_ONLINE' ? 0 : 1);
  const ordered = [...collected].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.sourceGameId !== b.sourceGameId) return a.sourceGameId.localeCompare(b.sourceGameId);
    if (a.sourcePly !== b.sourcePly) return a.sourcePly - b.sourcePly;
    return a.acceptanceType.localeCompare(b.acceptanceType);
  });

  // 选取策略：**按类型轮转**，保证规格 6.2 要求的三类必备都在首批里。
  // 上一版用 sourceGameId 排序后直接 slice(0, target)：合法题目会被静默丢弃，
  // 而且类型相差一个字母就整类落选（PREEMPT_* 就是这样消失的）。
  const eligible = ordered.filter((x) => x.status === 'PUBLISHED');
  // 禁手冲突题（威胁点恰好也是自己的禁手）在同类里排前面：这是规格 6.2 点名的第三类核心，
  // 但它天然稀有，不优先就会被同类里更常见的“无胜权防守”挤掉。
  const groups: PuzzleAcceptanceType[] = ['WIN_NOW', 'PREEMPT_LAST_THREAT', 'PREEMPT_ONE_THREAT', 'FORBIDDEN_BLOCK'];
  const byGroup = groups.map((g) => {
    const list = eligible.filter((x) => x.acceptanceType === g);
    if (g !== 'FORBIDDEN_BLOCK') return list;
    // 人类真实对局优先仍然是最外层规则；冲突优先只在同一来源内部生效。
    return [...list].sort((a, b) => {
      const h = rank(a) - rank(b);
      if (h !== 0) return h;
      return (b.excludedByForbidden > 0 ? 1 : 0) - (a.excludedByForbidden > 0 ? 1 : 0);
    });
  });
  const selected: Puzzle[] = [];
  for (let round = 0; selected.length < target; round += 1) {
    let added = 0;
    for (const list of byGroup) {
      const cand = list[round];
      if (!cand) continue;
      selected.push(cand);
      added += 1;
      if (selected.length >= target) break;
    }
    if (added === 0) break;
  }
  const selectedIds = new Set(selected.map((x) => x.puzzleId));
  const published = selected;
  const pending = ordered
    .filter((x) => !selectedIds.has(x.puzzleId))
    .map((x) =>
      x.status === 'PUBLISHED'
        ? { ...x, status: 'PENDING' as PuzzleStatus, reviewNote: '验证通过，但首批上限为 ' + target + ' 道，本批次未收录（不代表题目本身有问题）' }
        : x,
    );
  const puzzles = [...published, ...pending];

  const count = (key: (x: Puzzle) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const x of published) out[key(x)] = (out[key(x)] ?? 0) + 1;
    return out;
  };
  const meta: PuzzleBankMeta = {
    bankVersion: opts.bankVersion ?? 'p2-puzzles-20260930',
    schema: PUZZLE_SCHEMA,
    solverVersion: PUZZLE_SOLVER_VERSION,
    rulesetVersion: RULESET_VERSION,
    generator: opts.generator ?? 'scripts/product/build-puzzle-bank.mjs',
    total: published.length,
    byType: count((x) => x.acceptanceType),
    bySource: count((x) => x.sourceKind),
    bySplit: count((x) => x.split),
    byStatus: { PUBLISHED: published.length, PENDING: pending.length },
    byPolicy: (() => {
      const out: Record<string, number> = {};
      for (const t of sorted) {
        const pol = t.policy ?? (t.sourceKind === 'HUMAN_ONLINE' ? 'human' : 'unspecified');
        out[pol] = (out[pol] ?? 0) + 1;
      }
      return out;
    })(),
    duplicatesRemoved: duplicates,
    rejectedByVerification: rejected,
    pendingNotSelected: pending.filter((x) => x.status === 'PENDING' && x.reviewNote.startsWith('验证通过')).length,
    pendingRejectedByVerification: rejected,
    noLegalBlockPositions,
    forbiddenConflictPositions: published.filter((x) => x.acceptanceType === 'FORBIDDEN_BLOCK' && x.excludedByForbidden > 0).length,
    researchOpenCount: published.filter((x) => !x.answerSetComplete).length,
    bankHash: '',
    trajectoryCount: sorted.length,
    trajectoryPlies: sorted.reduce((n, t) => n + t.moves.length, 0),
  };
  meta.bankHash = bankHashOf(published, meta);
  return { puzzles, meta };
}

/** 题库摘要（用于“题库文件是否就是算法从这批轨迹产出的那一份”的自证）。 */
export function bankHashOf(published: Puzzle[], meta: Omit<PuzzleBankMeta, 'bankHash'>): string {
  const canonical = published
    .map((x) => [x.puzzleId, x.acceptanceType, x.stateDigest, x.answers.map((c) => c.row + ',' + c.col).join(';'), x.split].join('|'))
    .sort()
    .join('\n');
  return stableDigest(canonical + '\n' + meta.solverVersion + '|' + meta.rulesetVersion + '|' + meta.schema);
}

/** 每日一题：按日期确定性挑选（同一天所有人拿到同一题；不需要随机数或状态）。 */
export function dailyPuzzleId(published: Puzzle[], day: string): string | null {
  if (published.length === 0) return null;
  const ranked = published
    .map((x) => ({ id: x.puzzleId, k: stableDigest(day + '|' + x.puzzleId) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return ranked[0].id;
}