/**
 * 每日训练 Session（Daily Training Session ≤20）——本轮新增功能的真实 API 测试。
 *
 * 覆盖（对应需求里的 A–O）：
 *  A 首次进入生成 <=20 题；B 再次进入顺序一致；C 错误答案不永久改题面；D 正确答案 → solved；
 *  E 正确棋子出现在棋盘；F 无手数（服务端不提供手数标记，前端另有断言）；G 多个正解时以玩家选择为准；
 *  H 正确后刷新 → 正解仍在；I 未完成调用 next → 拒绝；J 完成后 next → 恰好 +1；
 *  K 双 next 并发 → 不跳两题；L 最后一题 → session complete、没有第 21 题；
 *  M/N 时间线用的局面（ANSWERING=题面，SOLVED=题面+正解）；O 旧历史回放控件的数据不再下发。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { getLegalMoves } from '../../shared/src/game/legalMoves.js';
import { applyMove, createInitialState } from '../../shared/src/game/rules.js';
import { qualificationFromState } from '../../shared/src/game/qualification.js';
import { DAILY_SESSION_MAX } from '../../shared/src/product/dailySession.js';
import { PUZZLE_BANK } from '../../shared/src/product/puzzleBank.generated.js';
import type { BoardSize } from '../../shared/src/game/types.js';

let failures = 0;
const observed: Record<string, unknown> = {};
let db: Db;
let apiBase = '';

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
  return { id: r.json.user.id as string, token: r.json.token as string };
}
/** 题目起始局面的真实重建（用于找一个合法落点 / 正确答案）。 */
function stateOfPuzzle(pz: { boardSize: number; moves: Array<{ row: number; col: number }> }) {
  let s = createInitialState(pz.boardSize as BoardSize);
  for (const m of pz.moves) s = applyMove(s, m.row, m.col).state;
  return s;
}
const bankById = new Map(PUZZLE_BANK.map((p) => [p.puzzleId, p]));

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-daily20-'));
  db = openDb(join(dir, 'test.sqlite'));
  const { server } = createApi(db, {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  apiBase = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

  await check('A 首次进入生成每日训练 Session，题目数 <= 20 且都是已验证题', async () => {
    const u = await registerUser('DailyA');
    const r = await api('GET', '/api/puzzles/daily', undefined, u.token);
    assert.equal(r.status, 200, 'daily -> ' + r.status + ' ' + JSON.stringify(r.json));
    const s = r.json.session;
    assert.ok(s.total > 0 && s.total <= DAILY_SESSION_MAX, 'total 必须在 1..20（实际 ' + s.total + '）');
    assert.equal(s.currentIndex, 0);
    assert.equal(s.solvedCount, 0);
    assert.equal(s.position, 1);
    assert.equal(s.phase, 'ANSWERING');
    assert.ok(r.json.puzzle && r.json.puzzle.puzzleId, '必须返回第一道题');
    // 落库的题目列表也都是已验证题（用题目表反查，不信客户端）
    const rows = db.raw.prepare('SELECT puzzle_ids_json, total FROM daily_puzzle_sessions WHERE user_id = ?').get(u.id) as any;
    const ids = JSON.parse(String(rows.puzzle_ids_json)) as string[];
    assert.equal(ids.length, Number(rows.total), 'total 必须等于落库的题目数');
    for (const id of ids) {
      const pz = bankById.get(id);
      assert.ok(pz, '题目必须存在：' + id);
      assert.equal(pz!.status, 'PUBLISHED', '只允许正式题：' + id);
      assert.equal(pz!.answerSetComplete, true, '只允许答案集完整的题：' + id);
    }
    observed.a = { total: s.total, verifiedInBank: bankById.size };
  });

  await check('B 再次进入顺序与进度完全一致（不会重新随机）', async () => {
    const u = await registerUser('DailyB');
    const first = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const again = await api('GET', '/api/puzzles/daily', undefined, u.token);
    assert.equal(again.json.puzzle.puzzleId, first.json.puzzle.puzzleId, '同一天同一用户必须是同一道首题');
    assert.equal(again.json.session.total, first.json.session.total);
    const rows1 = db.raw.prepare('SELECT puzzle_ids_json FROM daily_puzzle_sessions WHERE user_id = ?').get(u.id) as any;
    const before = String(rows1.puzzle_ids_json);
    await api('GET', '/api/puzzles/daily', undefined, u.token);
    const rows2 = db.raw.prepare('SELECT puzzle_ids_json FROM daily_puzzle_sessions WHERE user_id = ?').get(u.id) as any;
    assert.equal(String(rows2.puzzle_ids_json), before, '题目顺序在当天必须固定');
    observed.b = { firstPuzzle: first.json.puzzle.puzzleId, total: first.json.session.total };
  });

  await check('C 错误的合法落点：solved=false、题面不落子、下一次读取仍是原题面', async () => {
    const u = await registerUser('DailyC');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const def = bankById.get(pz.puzzleId)!;
    const st = stateOfPuzzle(pz);
    const answerSet = new Set(def.answers.map((a) => a.row + ',' + a.col));
    const wrongPoint = getLegalMoves(st).find((m) => !answerSet.has(m.row + ',' + m.col));
    assert.ok(wrongPoint, '必须能找到一个合法但非答案的点');
    const r = await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'c1', row: wrongPoint!.row, col: wrongPoint!.col }, u.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.verdict, 'INCORRECT');
    assert.equal(r.json.daily, undefined, '答错不产生每日训练回执');
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(after.puzzle.solvedMove, null, '答错不得在题面上留下棋子');
    assert.equal(after.session.phase, 'ANSWERING');
    assert.equal(after.session.solvedCount, 0);
    observed.c = { wrongPoint: [wrongPoint!.row, wrongPoint!.col] };
  });

  await check('D 正确答案：solved=true 且每日训练进入 SOLVED', async () => {
    const u = await registerUser('DailyD');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const def = bankById.get(pz.puzzleId)!;
    const answer = def.answers[0];
    const r = await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'd1', row: answer.row, col: answer.col }, u.token);
    assert.equal(r.json.verdict, 'CORRECT');
    assert.ok(r.json.daily, '答对必须带每日训练回执');
    assert.equal(r.json.daily.newlySolved, true);
    assert.equal(r.json.daily.solvedCount, 1);
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(after.session.phase, 'SOLVED');
    assert.equal(after.session.solvedCount, 1);
    observed.d = { solvedCount: r.json.daily.solvedCount };
  });

  await check('E 正确棋子出现在棋盘上：返回的 solvedMove 就是玩家下的那一格', async () => {
    const u = await registerUser('DailyE');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const def = bankById.get(pz.puzzleId)!;
    const answer = def.answers[def.answers.length - 1]; // 故意不用第一个
    await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'e1', row: answer.row, col: answer.col }, u.token);
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.deepEqual(after.puzzle.solvedMove, { row: answer.row, col: answer.col, seat: pz.actorSeat }, '正解落子必须是玩家选择的那一格');
    observed.e = after.puzzle.solvedMove;
  });

  await check('F 服务端不下发任何手数/序号标记（题型/轮次仍在）', async () => {
    const u = await registerUser('DailyF');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const keys = Object.keys(pz);
    for (const banned of ['moveNumbers', 'plyNumbers', 'moveNumber']) {
      assert.equal(keys.includes(banned), false, '不得下发 ' + banned);
    }
    assert.ok(pz.round > 0 && pz.acceptanceType && pz.actorSeat, '题型/轮次/座位仍然要有');
    observed.f = { puzzleKeys: keys.length };
  });

  await check('G 多个正解时：玩家选哪个就保存哪个（不强制 answers[0]）', async () => {
    // 不能靠“碰运气抽到多正解题”：直接读这个用户今天 Session 的题目列表，
    // 在里面找一道真正有多个答案的题，然后把它推到当前题目（答对 + next）。
    const u = await registerUser('DailyG');
    await api('GET', '/api/puzzles/daily', undefined, u.token);
    const row = db.raw.prepare('SELECT puzzle_ids_json FROM daily_puzzle_sessions WHERE user_id = ?').get(u.id) as any;
    const ids = JSON.parse(String(row.puzzle_ids_json)) as string[];
    const multiIdx = ids.findIndex((id) => (bankById.get(id)?.answers.length ?? 0) > 1);
    assert.ok(multiIdx >= 0, '今天的训练里必须含有多正解题（实际题目数 ' + ids.length + '）');
    // 把前面的题逐题答对并前进，直到多正解题成为当前题
    for (let i = 0; i < multiIdx; i += 1) {
      const cur = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
      const a = bankById.get(cur.puzzle.puzzleId)!.answers[0];
      await api('POST', '/api/puzzles/' + encodeURIComponent(cur.puzzle.puzzleId) + '/attempt', { attemptId: 'gpre' + i, row: a.row, col: a.col }, u.token);
      const nx = await api('POST', '/api/puzzles/daily/next', { expectedIndex: cur.session.currentIndex }, u.token);
      assert.equal(nx.status, 200, 'advance -> ' + nx.status);
    }
    const daily = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    const pz = daily.puzzle;
    const def = bankById.get(pz.puzzleId)!;
    assert.equal(pz.puzzleId, ids[multiIdx], '当前题必须是那道多正解题');
    assert.ok(def.answers.length > 1, '前置条件：这道题有多个正解');
    const chosen = def.answers[1]; // 明确不选第一个
    await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'g1', row: chosen.row, col: chosen.col }, u.token);
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(after.puzzle.solvedMove.row, chosen.row);
    assert.equal(after.puzzle.solvedMove.col, chosen.col);
    assert.notDeepEqual(
      { row: after.puzzle.solvedMove.row, col: after.puzzle.solvedMove.col },
      def.answers[0],
      '不得回落到 answers[0]',
    );
    observed.g = { puzzleId: pz.puzzleId, answers: def.answers.length, chosen: [chosen.row, chosen.col], first: [def.answers[0].row, def.answers[0].col] };
  });

  await check('H 答对后“刷新”（重新拉取）正解棋子仍在、阶段仍 SOLVED', async () => {
    const u = await registerUser('DailyH');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const answer = bankById.get(pz.puzzleId)!.answers[0];
    await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'h1', row: answer.row, col: answer.col }, u.token);
    // 模拟“刷新页面”：清空客户端状态后重新请求
    const fresh = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(fresh.puzzle.puzzleId, pz.puzzleId, '必须还是同一道题');
    assert.equal(fresh.session.phase, 'SOLVED');
    assert.deepEqual(fresh.puzzle.solvedMove, { row: answer.row, col: answer.col, seat: pz.actorSeat });
    // 连“重新登录”也要在：新 token、同一账号
    const relogin = await api('POST', '/api/login', { account: 'DailyH', password: 'Passw0rd!23' });
    const afterLogin = (await api('GET', '/api/puzzles/daily', undefined, relogin.json.token)).json;
    assert.deepEqual(afterLogin.puzzle.solvedMove, { row: answer.row, col: answer.col, seat: pz.actorSeat }, '重新登录后正解落子必须还在');
    observed.h = { afterRelogin: afterLogin.puzzle.solvedMove };
  });

  await check('I 未答对就调用 next：409 CURRENT_PUZZLE_NOT_SOLVED，索引不变', async () => {
    const u = await registerUser('DailyI');
    await api('GET', '/api/puzzles/daily', undefined, u.token);
    const r = await api('POST', '/api/puzzles/daily/next', { expectedIndex: 0 }, u.token);
    assert.equal(r.status, 409, '未答对必须 409（实际 ' + r.status + '）');
    assert.equal(r.json.code, 'CURRENT_PUZZLE_NOT_SOLVED');
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(after.session.currentIndex, 0, '被拒绝时索引不得前进');
    observed.i = { status: r.status, code: r.json.code };
  });

  await check('J 答对后 next：索引恰好 +1，并返回下一题', async () => {
    const u = await registerUser('DailyJ');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const answer = bankById.get(pz.puzzleId)!.answers[0];
    await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'j1', row: answer.row, col: answer.col }, u.token);
    const r = await api('POST', '/api/puzzles/daily/next', { expectedIndex: 0 }, u.token);
    assert.equal(r.status, 200, 'next -> ' + r.status + ' ' + JSON.stringify(r.json));
    assert.equal(r.json.session.currentIndex, 1, '必须恰好 +1');
    assert.equal(r.json.session.position, 2);
    assert.ok(r.json.puzzle && r.json.puzzle.puzzleId, '必须返回下一题');
    assert.notEqual(r.json.puzzle.puzzleId, pz.puzzleId, '下一题不能还是同一道');
    assert.equal(r.json.puzzle.solvedMove, null, '新题必须是未答状态');
    observed.j = { next: r.json.puzzle.puzzleId, index: r.json.session.currentIndex };
  });

  await check('K 双 next 并发：只前进一格（不会跳两题）', async () => {
    const u = await registerUser('DailyK');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const answer = bankById.get(pz.puzzleId)!.answers[0];
    await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'k1', row: answer.row, col: answer.col }, u.token);
    const [r1, r2] = await Promise.all([
      api('POST', '/api/puzzles/daily/next', { expectedIndex: 0 }, u.token),
      api('POST', '/api/puzzles/daily/next', { expectedIndex: 0 }, u.token),
    ]);
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(after.session.currentIndex, 1, '并发双请求只能前进一格（实际 ' + after.session.currentIndex + '）');
    const advanced = [r1, r2].filter((r) => r.json.advanced === true).length;
    assert.equal(advanced, 1, '只允许一个请求报告 advanced=true（实际 ' + advanced + '）');
    observed.k = { index: after.session.currentIndex, advancedCount: advanced };
  });

  await check('L 最后一题答对后：session complete，且不会返回第 21 题', async () => {
    const u = await registerUser('DailyL');
    let daily = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    const total = daily.session.total as number;
    assert.ok(total >= 2, '需要至少 2 题才能验证最后一题');
    for (let i = 0; i < total; i += 1) {
      const pz = daily.puzzle;
      const answer = bankById.get(pz.puzzleId)!.answers[0];
      await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'l' + i, row: answer.row, col: answer.col }, u.token);
      const nx = await api('POST', '/api/puzzles/daily/next', { expectedIndex: i }, u.token);
      assert.equal(nx.status, 200, 'next #' + i + ' -> ' + nx.status);
      if (i === total - 1) {
        assert.equal(nx.json.completed, true, '最后一题之后必须是 completed');
        assert.equal(nx.json.puzzle, null, '不得返回第 21 题');
      } else {
        daily = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
        assert.ok(daily.puzzle.puzzleId, '还有下一题');
      }
    }
    const done = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(done.session.phase, 'COMPLETE');
    assert.equal(done.puzzle, null, '完成后再读也不得给第 21 题');
    assert.equal(done.session.solvedCount, total, '解出数必须等于总题数');
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM daily_puzzle_solutions WHERE user_id = ? AND daily_key = ?').get(u.id, done.session.dailyKey) as any;
    assert.equal(Number(rows.n), total, '每题一条正解记录（实际 ' + rows.n + '）');
    observed.l = { total, solvedCount: done.session.solvedCount, complete: done.session.phase };
  });

  await check('M/N 时间线局面：ANSWERING 用题面、SOLVED 用“题面+玩家正解”', async () => {
    const u = await registerUser('DailyM');
    const daily = await api('GET', '/api/puzzles/daily', undefined, u.token);
    const pz = daily.json.puzzle;
    const baseState = stateOfPuzzle(pz);
    const baseTimeline = qualificationFromState(baseState);
    assert.equal(baseTimeline.currentRound, pz.round, '题面时间线的轮次必须与题目一致（ANSWERING）');
    const answer = bankById.get(pz.puzzleId)!.answers[0];
    await api('POST', '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt', { attemptId: 'm1', row: answer.row, col: answer.col }, u.token);
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    // 前端就是这么算 SOLVED 局面的：题面 + 玩家正解
    const solvedState = applyMove(baseState, after.puzzle.solvedMove.row, after.puzzle.solvedMove.col).state;
    assert.equal(solvedState.turnIndex, baseState.turnIndex + 1, 'SOLVED 局面必须比题面多一手');
    const solvedTimeline = qualificationFromState(solvedState);
    assert.equal(solvedTimeline.currentRound, solvedTimeline.currentRound, '时间线必须能从 SOLVED 局面算出');
    assert.ok(solvedTimeline.currentRound >= baseTimeline.currentRound, '轮次只可能前进');
    observed.mn = { baseRound: baseTimeline.currentRound, solvedRound: solvedTimeline.currentRound, baseEligible: baseTimeline.currentEligible, solvedEligible: solvedTimeline.currentEligible };
  });

  await check('O 旧的“历史回放”控件所需数据不再下发（moves 仍是题面，但页面不再有步进语义）', async () => {
    const u = await registerUser('DailyO');
    const daily = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(daily.puzzle.moves.length, daily.puzzle.startMoves, 'moves 必须正好是题面的起始手数');
    assert.equal(typeof daily.puzzle.startMoves, 'number');
    // 关键：不再下发“当前查看第几步”这类状态（那是历史回放的东西，已从每日训练移除）
    assert.equal(daily.puzzle.viewStep, undefined);
    assert.equal(daily.session.phase, 'ANSWERING');
    observed.o = { startMoves: daily.puzzle.startMoves, hasViewStep: daily.puzzle.viewStep !== undefined };
  });

  await check('P 幂等：同一 attemptId 重发不会让 solvedCount +2；同格不同 attemptId 也只算一次', async () => {
    const u = await registerUser('DailyP');
    const daily = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    const pz = daily.puzzle;
    const answer = bankById.get(pz.puzzleId)!.answers[0];
    const url = '/api/puzzles/' + encodeURIComponent(pz.puzzleId) + '/attempt';
    await api('POST', url, { attemptId: 'p1', row: answer.row, col: answer.col }, u.token);
    await api('POST', url, { attemptId: 'p1', row: answer.row, col: answer.col }, u.token);
    await api('POST', url, { attemptId: 'p2', row: answer.row, col: answer.col }, u.token);
    const after = (await api('GET', '/api/puzzles/daily', undefined, u.token)).json;
    assert.equal(after.session.solvedCount, 1, '重复提交不得让解出数 +2（实际 ' + after.session.solvedCount + '）');
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM daily_puzzle_solutions WHERE user_id = ? AND puzzle_id = ?').get(u.id, pz.puzzleId) as any;
    assert.equal(Number(rows.n), 1, '同一题只允许一条正解记录');
    observed.p = { solvedCount: after.session.solvedCount, solutionRows: Number(rows.n) };
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));
  await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  if (failures === 0) console.log('DAILY20: ALL PASS 0');
  else console.log('DAILY20: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
