/**
 * SRSZQ P2(B4 第二批) —— 题库 V1（R07）与每日题/错题（R08）。
 *   npm run test:puzzles   （scripts/product/run-tests.mjs --suite puzzles 调用）
 *
 * 规格来源：reference_spec/01_PRODUCT_IMPLEMENTATION_SPEC_CN.md 6.2（题库 V1）、6.1（标准数据）。
 * 验收矩阵：R07 发布题库、R08 每日题/错题（attempt 去重、进度持久、未审核研究题不混进正式判题）。
 *
 * 最要紧的一条断言：在测试里**重新跑一遍抽取算法**，要求产出与仓库里的题库逐条一致。
 * 这能同时挡住两类错误：产物被手工改过，以及算法漂移后产物没跟着更新。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import {
  buildPuzzleBank, dailyPuzzleId, expandTrails, gradeAnswer, packTrailMoves, splitForGame,
  startStateOf, trailToEvents, unpackTrailMoves, verifyPuzzle,
  type Puzzle, type Trail,
} from '../../shared/src/product/puzzleBank.js';
import { PUZZLE_BANK, PUZZLE_BANK_META, PUZZLE_TRAJECTORIES_PACKED } from '../../shared/src/product/puzzleBank.generated.js';
import { replayGame } from '../../shared/src/product/replay.js';
import { getEligiblePlayer, roundFromTurn } from '../../shared/src/game/eligibility.js';
import { qualificationFromState } from '../../shared/src/game/qualification.js';
import { getWinningPoints, isLegalMove } from '../../shared/src/game/legalMoves.js';
import type { BoardSize, Player } from '../../shared/src/game/types.js';
import { applyMove, createInitialState } from '../../shared/src/game/rules.js';

let db: Db;
let apiBase = '';
let failures = 0;
const observed: Record<string, unknown> = {};

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}
async function registerUser(name: string) {
  const r = await api('POST', '/api/register', { email: name.toLowerCase() + '@t.local', username: name, password: 'Passw0rd!23' });
  assert.equal(r.status, 201, 'register ' + name + ' -> ' + JSON.stringify(r.json));
  await api('POST', '/api/tutorial/complete', {}, r.json.token);
  return { id: r.json.user.id as string, token: r.json.token as string, username: name };
}

const TRAILS: Trail[] = expandTrails(PUZZLE_TRAJECTORIES_PACKED);
const trailOf = (gameId: string): Trail => {
  const t = TRAILS.find((x) => x.gameId === gameId);
  assert.ok(t, '题目引用的轨迹必须在产物里: ' + gameId);
  return t!;
};

/** 独立复核：自己数四条方向上的连子（不使用被测模块的胜点函数）。 */
function independentFour(board: Array<Array<string | null>>, row: number, col: number, player: string): boolean {
  const n = board.length;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as Array<[number, number]>) {
    let run = 1;
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < n && c >= 0 && c < n && board[r][c] === player) { run += 1; r += dr * sign; c += dc * sign; }
    }
    if (run >= 4) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-puzzles-'));
  db = openDb(join(dir, 'test.sqlite'));
  const { server: apiServer } = createApi(db, {});
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;

  console.log('--- R07 题库 V1 ---');

  await check('R07a 首批题量在 30-60 之间，元信息与实际题目数组一致', async () => {
    observed.r07 = { total: PUZZLE_BANK.length, byType: PUZZLE_BANK_META.byType, bySource: PUZZLE_BANK_META.bySource, bySplit: PUZZLE_BANK_META.bySplit };
    assert.ok(PUZZLE_BANK.length >= 30 && PUZZLE_BANK.length <= 60, '首批应为 30-60 道，实际 ' + PUZZLE_BANK.length);
    assert.equal(PUZZLE_BANK.length, PUZZLE_BANK_META.total, 'meta.total 必须等于实际题数');
    assert.equal(PUZZLE_BANK.filter((x) => x.status === 'PUBLISHED').length, PUZZLE_BANK.length, '产物里只允许出现已发布的题');
    assert.equal(PUZZLE_BANK_META.pendingRejectedByVerification, 0, '本批次不应有验证拒绝的题（有则说明抽题器与验证器不一致）');
  });

  await check('R07b 规格要求的三类必备都在首批里（且禁手冲突子类非空）', async () => {
    const t = PUZZLE_BANK_META.byType;
    assert.ok((t.WIN_NOW ?? 0) > 0, '缺少「当前胜点」题');
    assert.ok((t.PREEMPT_LAST_THREAT ?? 0) + (t.PREEMPT_ONE_THREAT ?? 0) > 0, '缺少「跨轮提前防守」题');
    assert.ok((t.FORBIDDEN_BLOCK ?? 0) > 0, '缺少「禁手防守冲突」题');
    observed.r07_conflict = { forbidddenBlock: t.FORBIDDEN_BLOCK ?? 0, realConflict: PUZZLE_BANK_META.forbiddenConflictPositions };
    assert.ok(PUZZLE_BANK_META.forbiddenConflictPositions > 0, '必须存在“威胁点恰好是自己的禁手”的真冲突题，否则第三类名不副实');
  });

  await check('R07c 每条轨迹都能用真实引擎完整重放（题目来自合法完整轨迹）', async () => {
    let plies = 0;
    for (const t of TRAILS) {
      const outcome = replayGame(t.boardSize, trailToEvents(t));
      assert.equal(outcome.ok, true, '轨迹 ' + t.gameId + ' 重放失败: ' + outcome.errors.join(' '));
      assert.equal(outcome.steps.length, t.moves.length);
      plies += t.moves.length;
    }
    observed.r07_trails = { count: TRAILS.length, plies };
    assert.equal(plies, PUZZLE_BANK_META.trajectoryPlies, '总手数必须与 meta 一致');
    assert.equal(TRAILS.length, PUZZLE_BANK_META.trajectoryCount);
  });

  await check('R07d 每道题都能通过独立验证（起始局面 + 穷举重算的答案集）', async () => {
    for (const pz of PUZZLE_BANK) {
      const v = verifyPuzzle(pz, trailOf(pz.sourceGameId));
      assert.equal(v.ok, true, pz.puzzleId + ' 验证失败: ' + v.failures.join('；'));
      assert.ok(pz.answers.length > 0, pz.puzzleId + ' 答案集不能为空');
      assert.equal(pz.answerSetComplete, true, pz.puzzleId + ' 必须是已证明完整的答案集');
      assert.ok(pz.explanation.messageKey.startsWith('PUZZLE_'), pz.puzzleId + ' 缺少解析 key');
      assert.equal(pz.solver.depth, 1);
      assert.ok(pz.solver.solverVersion.length > 0);
    }
  });

  await check('R07e 题库就是算法从这批轨迹产出的那一份（在测试里重算并逐条比对）', async () => {
    const rebuilt = buildPuzzleBank(TRAILS, { target: 60, generator: PUZZLE_BANK_META.generator });
    const published = rebuilt.puzzles.filter((x) => x.status === 'PUBLISHED');
    observed.r07_rebuild = { published: published.length, hash: rebuilt.meta.bankHash };
    assert.equal(rebuilt.meta.bankHash, PUZZLE_BANK_META.bankHash, '重算得到的 bankHash 必须与产物一致');
    assert.equal(published.length, PUZZLE_BANK.length);
    const key = (x: Puzzle): string => x.puzzleId + '|' + x.acceptanceType + '|' + x.stateDigest + '|' + x.answers.map((c) => c.row + ',' + c.col).join(';');
    assert.deepEqual(published.map(key).sort(), PUZZLE_BANK.map(key).sort(), '重算的题目集合必须与产物完全相同');
    assert.equal(rebuilt.meta.pendingNotSelected, PUZZLE_BANK_META.pendingNotSelected, '未收录题数也必须一致（计数不能漂）');
  });

  await check('R07f 即时胜利题枚举全部致胜点（独立数连复核，不只引擎选中的那一个）', async () => {
    const winPuzzles = PUZZLE_BANK.filter((x) => x.acceptanceType === 'WIN_NOW');
    let multi = 0;
    for (const pz of winPuzzles) {
      const state = startStateOf(pz.boardSize, trailOf(pz.sourceGameId), pz.startPly);
      const independent: string[] = [];
      for (let r = 0; r < state.boardSize; r += 1) {
        for (let c = 0; c < state.boardSize; c += 1) {
          if (state.board[r][c] !== null) continue;
          if (independentFour(state.board, r, c, pz.actorSeat)) independent.push(r + ',' + c);
        }
      }
      const listed = pz.answers.map((c) => c.row + ',' + c.col).sort();
      assert.deepEqual(listed, independent.sort(), pz.puzzleId + ' 答案集与独立扫描不一致');
      if (listed.length > 1) multi += 1;
    }
    observed.r07_winnow = { puzzles: winPuzzles.length, withMultipleAnswers: multi };
    assert.ok(multi > 0, '题库里必须存在“有多个致胜点”的题，否则无法体现“不只留一个答案”');
  });

  await check('R07g 跨轮防守题不夸大：多威胁时只说占掉一个，并给出剩余威胁数', async () => {
    const one = PUZZLE_BANK.filter((x) => x.acceptanceType === 'PREEMPT_ONE_THREAT');
    const last = PUZZLE_BANK.filter((x) => x.acceptanceType === 'PREEMPT_LAST_THREAT');
    for (const pz of one) {
      assert.ok(pz.threatsBefore > 1, pz.puzzleId + ' 标注为“多个威胁”时 threatsBefore 必须 > 1');
      assert.equal(pz.explanation.messageKey, 'PUZZLE_PREEMPT_ONE_OF');
      assert.equal(typeof pz.explanation.args.remaining, 'number', '必须诚实给出占掉一个之后还剩几个威胁');
      assert.ok(pz.answers.length === pz.threatsBefore, '每个威胁点都应是可接受的答案（不把某一个说成唯一正解）');
    }
    for (const pz of last) {
      assert.equal(pz.threatsBefore, 1, pz.puzzleId + ' 声称唯一威胁时 threatsBefore 必须为 1');
      assert.equal(pz.answers.length, 1);
      assert.equal(pz.explanation.messageKey, 'PUZZLE_PREEMPT_LAST');
    }
    observed.r07_preempt = { last: last.length, oneOf: one.length };
  });

  await check('R07h 禁手冲突题：答案必须合法，且题面标出被禁手排除的威胁点数量', async () => {
    const list = PUZZLE_BANK.filter((x) => x.acceptanceType === 'FORBIDDEN_BLOCK');
    assert.ok(list.length > 0);
    for (const pz of list) {
      const state = startStateOf(pz.boardSize, trailOf(pz.sourceGameId), pz.startPly);
      assert.notEqual(getEligiblePlayer(roundFromTurn(state.turnIndex)), pz.actorSeat, '禁手题必须发生在没有胜权的回合');
      for (const a of pz.answers) {
        assert.equal(isLegalMove(state, a.row, a.col), true, pz.puzzleId + ' 答案 (' + a.row + ',' + a.col + ') 必须是合法手');
        assert.equal(independentFour(state.board, a.row, a.col, pz.actorSeat), false, '答案不能让自己的禁手成立');
      }
      const threats = getWinningPoints(state.board, pz.threatenedSeat as Player);
      assert.equal(threats.length, pz.threatsBefore, pz.puzzleId + ' threatsBefore 必须等于真实威胁点数');
      assert.equal(pz.answers.length + pz.excludedByForbidden, threats.length, '答案 + 被禁手排除 = 全部威胁点');
    }
    assert.ok(list.some((x) => x.excludedByForbidden > 0), '必须存在真的被禁手排除掉候选的题');
  });

  await check('R07i 判题：集合内的点都算对，合法但非答案算错，非法手单独区分', async () => {
    for (const type of ['WIN_NOW', 'PREEMPT_ONE_THREAT', 'FORBIDDEN_BLOCK'] as const) {
      const pz = PUZZLE_BANK.find((x) => x.acceptanceType === type);
      assert.ok(pz, '缺少类型 ' + type);
      const trail = trailOf(pz!.sourceGameId);
      const a = pz!.answers[0];
      assert.equal(gradeAnswer(pz!, trail, a.row, a.col).verdict, 'CORRECT', type + ' 答案点应判对');
      const state = startStateOf(pz!.boardSize, trail, pz!.startPly);
      let nonAnswer: { row: number; col: number } | null = null;
      let illegal: { row: number; col: number } | null = null;
      for (let r = 0; r < state.boardSize && (!nonAnswer || !illegal); r += 1) {
        for (let c = 0; c < state.boardSize && (!nonAnswer || !illegal); c += 1) {
          if (pz!.answers.some((x) => x.row === r && x.col === c)) continue;
          if (isLegalMove(state, r, c)) { if (!nonAnswer) nonAnswer = { row: r, col: c }; }
          else if (state.board[r][c] === null && !illegal) illegal = { row: r, col: c };
        }
      }
      if (nonAnswer) assert.equal(gradeAnswer(pz!, trail, nonAnswer.row, nonAnswer.col).verdict, 'INCORRECT', type + ' 合法但非答案应判错');
      if (illegal) assert.equal(gradeAnswer(pz!, trail, illegal.row, illegal.col).verdict, 'ILLEGAL', type + ' 非法手应判 ILLEGAL');
      assert.equal(gradeAnswer(pz!, trail, 0, 0).verdict === 'OPEN', false, '正式题不得返回 OPEN（未证明答案集的题才允许）');
    }
  });

  await check('R07j 整盘切分：同一局的题不跨 split，且三等分后 train/dev/test 都非空', async () => {
    const byGame = new Map<string, Set<string>>();
    for (const pz of PUZZLE_BANK) {
      if (!byGame.has(pz.sourceGameId)) byGame.set(pz.sourceGameId, new Set());
      byGame.get(pz.sourceGameId)!.add(pz.split);
    }
    for (const [gid, splits] of byGame) assert.equal(splits.size, 1, gid + ' 的题跨了 split');
    for (const pz of PUZZLE_BANK) assert.equal(pz.split, splitForGame(pz.sourceGameId), 'split 必须由 gameId 决定且稳定');
    const s = PUZZLE_BANK_META.bySplit;
    observed.r07_split = s;
    assert.ok((s.train ?? 0) > 0 && (s.dev ?? 0) > 0 && (s.test ?? 0) > 0, '三个 split 都应有题: ' + JSON.stringify(s));
  });

  await check('R07k 去重：没有两道已发布题是同一局面 + 同一类型', async () => {
    const keys = PUZZLE_BANK.map((x) => x.stateDigest + '|' + x.acceptanceType);
    assert.equal(new Set(keys).size, keys.length, '存在重复题目');
    assert.ok(PUZZLE_BANK_META.duplicatesRemoved >= 0);
  });

  await check('R07l 紧凑轨迹编码可逆（产物里的轨迹不是一次性快照）', async () => {
    for (const t of PUZZLE_TRAJECTORIES_PACKED) {
      const moves = unpackTrailMoves(t.packed);
      assert.equal(packTrailMoves(moves), t.packed, t.gameId + ' 编码不可逆');
      assert.equal(moves.length * 3, t.packed.length);
    }
  });

  await check('R07m 每日一题的选择只看已发布题，且按日期确定（同一天所有人同题）', async () => {
    const ids = new Set<string>();
    for (let d = 1; d <= 30; d += 1) {
      const day = '2026-10-' + String(d).padStart(2, '0');
      const id = dailyPuzzleId(PUZZLE_BANK, day);
      assert.ok(id, day + ' 必须有题');
      assert.ok(PUZZLE_BANK.some((x) => x.puzzleId === id && x.status === 'PUBLISHED'), '每日题必须是已发布的题');
      assert.equal(dailyPuzzleId(PUZZLE_BANK, day), id, '同一天必须稳定');
      ids.add(id!);
    }
    observed.r07_daily = { distinctOver30Days: ids.size };
    assert.ok(ids.size > 5, '30 天内每天应有变化，实际只有 ' + ids.size + ' 个不同题目');
  });

  console.log('--- R08 每日题 / 错题 / 进度 ---');

  await check('R08a 未登录不得取每日题', async () => {
    assert.equal((await api('GET', '/api/puzzles/daily')).status, 401);
  });

  await check('R08b 每日题对同一天稳定、跨天可变化，且不出售答案', async () => {
    const u = await registerUser('PuzzleA');
    const d1 = await api('GET', '/api/puzzles/daily?day=2026-10-05', undefined, u.token);
    assert.equal(d1.status, 200, JSON.stringify(d1.json));
    const d1b = await api('GET', '/api/puzzles/daily?day=2026-10-05', undefined, u.token);
    assert.equal(d1.json.puzzle.puzzleId, d1b.json.puzzle.puzzleId, '同一天必须同题');
    assert.equal(d1.json.puzzle.answers, undefined, '未作答前不得下发答案');
    assert.equal(typeof d1.json.puzzle.startMoves, 'number', '只下发起始手数，让客户端按规则重放');
    assert.ok(d1.json.puzzle.acceptanceType);
    const ids = new Set<string>();
    for (let d = 1; d <= 10; d += 1) {
      const r = await api('GET', '/api/puzzles/daily?day=2026-11-' + String(d).padStart(2, '0'), undefined, u.token);
      ids.add(r.json.puzzle.puzzleId);
    }
    observed.r08_daily = { distinct: ids.size };
    assert.ok(ids.size > 1, '不同日期应能取到不同题目');
  });

  await check('R08c 同一 attemptId 重发只记一次（attempt 去重）', async () => {
    const u = await registerUser('PuzzleB');
    const pz = PUZZLE_BANK[0];
    const a = pz.answers[0];
    const body = { attemptId: 'att-1', row: a.row, col: a.col };
    const first = await api('POST', '/api/puzzles/' + pz.puzzleId + '/attempt', body, u.token);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.verdict, 'CORRECT');
    const second = await api('POST', '/api/puzzles/' + pz.puzzleId + '/attempt', body, u.token);
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true, '重复 attemptId 必须被识别为重发');
    assert.equal(second.json.verdict, 'CORRECT', '重发必须回放同一结论');
    assert.equal(second.json.attempts, first.json.attempts, '重发不得增加尝试次数');
    // 必须用**真的不同**的坐标：曾经这里写死 (0,0)，而第一个答案本身就可能是 (0,0)，
    // 于是这个断言会偶发地把“正确的重发处理”误判成失败。
    const other = { row: a.row === 0 ? 1 : 0, col: a.col === 0 ? 1 : 0 };
    const third = await api('POST', '/api/puzzles/' + pz.puzzleId + '/attempt', { attemptId: 'att-1', ...other }, u.token);
    assert.equal(third.status, 409, '同一 attemptId 换答案必须被拒，而不是覆盖历史');
    const replayAfterConflict = await api('POST', '/api/puzzles/' + pz.puzzleId + '/attempt', body, u.token);
    assert.equal(replayAfterConflict.json.verdict, 'CORRECT', '被拒的冲突不得改动已落库的尝试');
    assert.equal(replayAfterConflict.json.attempts, first.json.attempts, '冲突之后尝试次数仍不变');
  });

  await check('R08d 进度持久：答对后状态为 SOLVED，答错进错题本并可重练', async () => {
    const u = await registerUser('PuzzleC');
    const wrongPz = PUZZLE_BANK.find((x) => x.acceptanceType === 'WIN_NOW')!;
    const state = startStateOf(wrongPz.boardSize, trailOf(wrongPz.sourceGameId), wrongPz.startPly);
    let wrongMove: { row: number; col: number } | null = null;
    for (let r = 0; r < state.boardSize && !wrongMove; r += 1) {
      for (let c = 0; c < state.boardSize && !wrongMove; c += 1) {
        if (wrongPz.answers.some((x) => x.row === r && x.col === c)) continue;
        if (isLegalMove(state, r, c)) wrongMove = { row: r, col: c };
      }
    }
    assert.ok(wrongMove, '需要找到一个合法但非答案的点');
    const bad = await api('POST', '/api/puzzles/' + wrongPz.puzzleId + '/attempt', { attemptId: 'w1', ...wrongMove }, u.token);
    assert.equal(bad.json.verdict, 'INCORRECT');
    assert.equal(bad.json.answers, undefined, '答错先不给答案（可再试）');
    const prog1 = await api('GET', '/api/puzzles/progress', undefined, u.token);
    assert.equal(prog1.json.progress.failed, 1);
    assert.equal(prog1.json.progress.wrong.length, 1);
    assert.equal(prog1.json.progress.wrong[0].puzzleId, wrongPz.puzzleId);
    assert.equal(prog1.json.progress.wrong[0].attempts, 1);
    const good = wrongPz.answers[0];
    const okRes = await api('POST', '/api/puzzles/' + wrongPz.puzzleId + '/attempt', { attemptId: 'w2', row: good.row, col: good.col }, u.token);
    assert.equal(okRes.json.verdict, 'CORRECT');
    assert.ok(Array.isArray(okRes.json.answers) && okRes.json.answers.length > 0, '答对后应给出完整答案集与解析');
    assert.equal(okRes.json.explanation.messageKey, 'PUZZLE_WIN_NOW');
    const prog2 = await api('GET', '/api/puzzles/progress', undefined, u.token);
    assert.equal(prog2.json.progress.solved, 1);
    assert.equal(prog2.json.progress.failed, 0, '答对后应从错题本移出');
    assert.equal(prog2.json.progress.wrong.length, 0);
    assert.equal(prog2.json.progress.totalAttempts, 2);
    assert.equal(prog2.json.progress.firstSolvedAt > 0, true, '首次解出时间必须落库');
  });

  await check('R08e 未证明答案集的题不会混进正式判题（本批次 0 道，机制上也不可能）', async () => {
    assert.equal(PUZZLE_BANK_META.researchOpenCount, 0, '产物里不应有答案集不完整的题');
    for (const pz of PUZZLE_BANK) assert.equal(pz.answerSetComplete, true);
    const u = await registerUser('PuzzleD');
    const unknown = await api('POST', '/api/puzzles/not-a-real-puzzle/attempt', { attemptId: 'x', row: 0, col: 0 }, u.token);
    assert.equal(unknown.status, 404, '未知题目必须 404，而不是给出任何判题结果');
  });

  await check('R08f 尝试记录与进度都在数据库里（不是内存态）', async () => {
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM puzzle_attempts').get() as { n: number };
    assert.ok(Number(rows.n) >= 3, '尝试必须落库，实际 ' + rows.n);
    const prog = db.raw.prepare('SELECT COUNT(*) AS n FROM puzzle_progress').get() as { n: number };
    assert.ok(Number(prog.n) >= 2, '进度必须落库，实际 ' + prog.n);
    const dup = db.raw.prepare('SELECT COUNT(*) AS n FROM (SELECT user_id, attempt_id FROM puzzle_attempts GROUP BY user_id, attempt_id HAVING COUNT(*) > 1)').get() as { n: number };
    assert.equal(Number(dup.n), 0, '(user_id, attempt_id) 不允许重复行');
  });

  // ---- 增量 A：每日一题胜权时间线（与 Online Match 同源） ----

  await check('R08g 每日一题时间线与服务器自报的 round/eligiblePlayer 一致（同一规则源）', async () => {
    const u = await registerUser('PuzzleE');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    assert.equal(daily.status, 200, 'daily 必须可读：' + JSON.stringify(daily.json));
    const pz = daily.json.puzzle as {
      puzzleId: string; boardSize: BoardSize; moves: Array<{ row: number; col: number }>;
      round: number; eligiblePlayer: Player | null; startMoves: number;
    };
    // 题面棋谱 = 题目起始局面的前 startMoves 手；用共享引擎重放，不许另算一套。
    assert.equal(pz.moves.length, pz.startMoves, '题面必须给出完整起始棋谱');
    let state = createInitialState(pz.boardSize);
    for (let i = 0; i < pz.moves.length; i += 1) {
      const m = pz.moves[i];
      const res = applyMove(state, m.row, m.col);
      // 注意：applyMove 成功时**没有** rejected 字段，所以只能用 falsy 判断，不能严格等于 false。
      assert.ok(!res.rejected,
        '题面棋谱必须合法：第 ' + (i + 1) + ' 手 (' + m.row + ',' + m.col + ') 被拒绝 reason=' + String(res.rejected)
        + ' 题=' + pz.puzzleId + ' 棋盘=' + pz.boardSize + ' 手数=' + pz.moves.length
        + ' 首手=' + JSON.stringify(pz.moves[0]));
      state = res.state;
    }
    assert.equal(roundFromTurn(state.turnIndex), pz.round, '题目 round 必须等于真实局面算出的 Round');
    const view = qualificationFromState(state);
    assert.equal(view.currentEligible, pz.eligiblePlayer, '时间线当前胜权必须等于服务器自报值');
    assert.equal(view.currentEligible, getEligiblePlayer(pz.round), '当前胜权必须等于正式规则结果');
    assert.ok(view.upcoming.length >= 5, '时间线窗口至少要能显示未来 5 轮，实际 ' + view.upcoming.length);
    observed.r08g = { puzzleId: pz.puzzleId, round: pz.round, eligible: pz.eligiblePlayer, window: view.upcoming.length };
  });

  await check('R08h 复盘步进：时间线随“正在查看第几手”变化（R5 无胜权 → R6 白 → R7 绿 → R8 红）', async () => {
    const trail = TRAILS.find((t) => t.moves.length >= 24);
    assert.ok(trail, '需要一条至少 24 手的真实轨迹');
    const byPly = new Map<number, Player | null>();
    for (let k = 0; k <= 21; k++) {
      const st = startStateOf(trail!.boardSize, trail!, k);
      const view = qualificationFromState(st);
      assert.equal(view.currentRound, roundFromTurn(k), '第 ' + k + ' 手对应的 Round 必须由引擎算出');
      assert.equal(view.currentEligible, getEligiblePlayer(roundFromTurn(k)), '第 ' + k + ' 手的胜权必须等于正式规则');
      byPly.set(k, view.currentEligible);
    }
    assert.equal(byPly.get(14), null, '第 14 手仍在 R5：无胜权');
    assert.equal(byPly.get(15), 'C', '第 15 手进入 R6：白棋');
    assert.equal(byPly.get(18), 'B', '第 18 手 R7：绿棋');
    assert.equal(byPly.get(21), 'A', '第 21 手 R8：红棋');
    // 后退一步必须回到上一步的结论（可重放，不是一次性状态）
    const back = qualificationFromState(startStateOf(trail!.boardSize, trail!, 14));
    assert.equal(back.currentEligible, null, '退回第 14 手必须回到“无胜权”');
    observed.r08h = { p0: byPly.get(0), p14: byPly.get(14), p15: byPly.get(15), p18: byPly.get(18), p21: byPly.get(21) };
  });

  await check('R08i 全部已发布题目的 round/eligiblePlayer 都符合正式规则（60 道逐条核对）', async () => {
    let wrong = 0;
    for (const pz of PUZZLE_BANK) {
      if (getEligiblePlayer(pz.round) !== pz.eligiblePlayer) wrong += 1;
      // 题面起始局面重放后的 Round 也必须等于题目自报 round
      const st = startStateOf(pz.boardSize, trailOf(pz.sourceGameId), pz.startPly);
      if (roundFromTurn(st.turnIndex) !== pz.round) wrong += 1;
    }
    assert.equal(wrong, 0, '不符合正式规则的题目数：' + wrong);
    observed.r08i = { checked: PUZZLE_BANK.length, wrong };
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  await new Promise<void>((r) => apiServer.close(() => r()));
  db.close();
  if (failures === 0) console.log('PUZZLES: ALL PASS 0');
  else console.log('PUZZLES: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });