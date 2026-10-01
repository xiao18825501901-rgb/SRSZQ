
/**
 * 公网行为验收（P2 题库）：每日题 / 作答判题 / attempt 幂等 / 进度与错题。
 *
 *   npx tsx scripts/dev/public-puzzle-check.mts
 *
 * 为什么要在真实域名上跑：题库是构建期产物，只有把「部署上去的那份题库」
 * 与本仓库的题库逐项比对，才能证明线上发的是这一版题，而不是某次旧构建留下的。
 * 因此这里会用与线上同一套确定性算法本地算一遍今日题目，再核对线上返回的是不是同一道。
 */
import { PUZZLE_BANK, PUZZLE_BANK_META, PUZZLE_TRAJECTORIES_PACKED } from '../../shared/src/product/puzzleBank.generated.js';
import { expandTrails, startStateOf, type Puzzle, type Trail } from '../../shared/src/product/puzzleBank.js';
import { DAILY_SESSION_MAX, isVerifiedPuzzle } from '../../shared/src/product/dailySession.js';
import { isLegalMove } from '../../shared/src/game/legalMoves.js';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const stamp = Date.now().toString(36);
const username = ('dshp3' + stamp).slice(0, 16);
const email = ('dsh.p3.' + stamp + '@example.invalid').toLowerCase();
const password = 'Demo-P3-' + stamp + '!3';

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留原文 */ }
  return { status: res.status, json, text };
}

const TRAILS: Trail[] = expandTrails(PUZZLE_TRAJECTORIES_PACKED);
const trailOf = (id: string): Trail | undefined => TRAILS.find((t) => t.gameId === id);

const main = async (): Promise<void> => {
  console.log('=== 公网版本 ===');
  const v = await api('GET', '/api/version');
  const release = v.json?.protocol?.releaseId;
  ok(v.json?.protocol?.protocolVersion === 2, 'protocolVersion=2 release=' + release);

  console.log('=== 注册 DEMO 账号 ===');
  const reg = await api('POST', '/api/register', { email, username, password });
  ok(reg.status === 201, 'register http=' + reg.status);
  const token: string = reg.json?.token;
  if (!token) { console.log('FATAL: 无法继续 ' + reg.text.slice(0, 200)); process.exit(1); }
  await api('POST', '/api/tutorial/complete', {}, token);

  const day = new Date().toISOString().slice(0, 10);
  console.log('=== 每日训练 Session（' + day + '） ===');
  const daily = await api('GET', '/api/puzzles/daily?day=' + day, undefined, token);
  ok(daily.status === 200, 'daily http=' + daily.status);
  const s0 = daily.json?.session;
  ok(s0?.dailyKey === day && s0?.currentIndex === 0 && s0?.position === 1, 'Session 已建立：key=' + s0?.dailyKey + ' 位置=' + s0?.position + '/' + s0?.total);
  ok(s0?.phase === 'ANSWERING', '初始阶段=ANSWERING（实际 ' + s0?.phase + '）');
  ok(Number.isInteger(s0?.total) && s0.total >= 1 && s0.total <= DAILY_SESSION_MAX, '当天题数在 1..' + DAILY_SESSION_MAX + '（实际 ' + s0?.total + '）');
  const online = daily.json?.puzzle;
  ok(!!online?.puzzleId, '服务器下发了当前题（puzzleId 非空）');
  // 同一用户同一天再取一次：顺序当天固定，刷新/重登不得重新随机。
  const daily2 = await api('GET', '/api/puzzles/daily?day=' + day, undefined, token);
  ok(daily2.json?.puzzle?.puzzleId === online?.puzzleId && daily2.json?.session?.currentIndex === s0?.currentIndex, '同用户同一天重复获取：同一道题、同一索引');
  // 唯一能证明「线上发的是这一版题库」的办法：拿线上题 id 回本仓库题库原样找。
  const local = PUZZLE_BANK.find((x) => x.puzzleId === online?.puzzleId) as Puzzle | undefined;
  ok(!!local, '线上当前题存在于本仓库题库（' + String(online?.puzzleId).slice(-28) + '）');
  if (!local) { console.log('FATAL: 本地题库缺题'); process.exit(1); }
  ok(isVerifiedPuzzle(local), '线上当前题在本地也是已验证题（PUBLISHED 且答案集完整）');
  ok(online?.acceptanceType === local.acceptanceType && online?.boardSize === local.boardSize, '题类/棋盘与本地一致');
  ok(online?.solvedMove === null || online?.solvedMove === undefined, '尚未答对时不下发 solvedMove');
  ok(online?.answers === undefined && online?.explanation === undefined, '未作答前不下发答案与解析');
  const trail = trailOf(local.sourceGameId)!;
  const localMoves = trail.moves.slice(0, local.startPly);
  ok(Array.isArray(online?.moves) && online.moves.length === localMoves.length, '起始手数与本地一致：' + online?.moves?.length);
  const sameMoves = (online?.moves ?? []).every((m: any, i: number) => m.seat === localMoves[i].seat && m.row === localMoves[i].row && m.col === localMoves[i].col);
  ok(sameMoves, '线上起始局面逐手与本地一致（客户端可据规则重放）');
  ok(daily.json?.bank?.total === PUZZLE_BANK_META.total, '线上题库总数=' + daily.json?.bank?.total + '，与本地一致');

  console.log('=== 判题与 attempt 幂等 ===');
  const state = startStateOf(local.boardSize, trail, local.startPly);
  let wrongMove: { row: number; col: number } | null = null;
  for (let r = 0; r < state.boardSize && !wrongMove; r += 1) {
    for (let c = 0; c < state.boardSize && !wrongMove; c += 1) {
      if (local.answers.some((a) => a.row === r && a.col === c)) continue;
      if (isLegalMove(state, r, c)) wrongMove = { row: r, col: c };
    }
  }
  ok(!!wrongMove, '能在本地找到一个合法但非答案的点：' + JSON.stringify(wrongMove));
  const bad = await api('POST', '/api/puzzles/' + local.puzzleId + '/attempt', { attemptId: 'pub-w1', ...wrongMove }, token);
  ok(bad.status === 200 && bad.json?.verdict === 'INCORRECT', '合法非答案 -> INCORRECT（实际 ' + bad.json?.verdict + '）');
  ok(bad.json?.answers === undefined, '答错先不给答案（可重试）');
  const badAgain = await api('POST', '/api/puzzles/' + local.puzzleId + '/attempt', { attemptId: 'pub-w1', ...wrongMove }, token);
  ok(badAgain.json?.duplicate === true && badAgain.json?.attempts === bad.json?.attempts, '同一 attemptId 重发：duplicate=true 且次数不变（' + badAgain.json?.attempts + '）');
  // 换一个**真的不同**的坐标：写死 (0,0) 会在 wrongMove 恰好是 (0,0) 时把正确的重发处理误判成失败。
  const otherCell = { row: wrongMove!.row === 0 ? 1 : 0, col: wrongMove!.col === 0 ? 1 : 0 };
  const conflict = await api('POST', '/api/puzzles/' + local.puzzleId + '/attempt', { attemptId: 'pub-w1', ...otherCell }, token);
  ok(conflict.status === 409, '同一 attemptId 换答案 -> 409（实际 ' + conflict.status + '）');
  const afterConflict = await api('POST', '/api/puzzles/' + local.puzzleId + '/attempt', { attemptId: 'pub-w1', ...wrongMove }, token);
  ok(afterConflict.json?.verdict === 'INCORRECT' && afterConflict.json?.attempts === bad.json?.attempts, '被拒的冲突不得改动已落库的尝试');
  const a = local.answers[0];
  const good = await api('POST', '/api/puzzles/' + local.puzzleId + '/attempt', { attemptId: 'pub-c1', row: a.row, col: a.col }, token);
  ok(good.json?.verdict === 'CORRECT', '答案点 -> CORRECT（实际 ' + good.json?.verdict + '）');
  ok(Array.isArray(good.json?.answers) && good.json.answers.length === local.answers.length, '答对后下发完整答案集（' + good.json?.answers?.length + ' 个）');
  ok(good.json?.answerSetComplete === true, '答案集标记为完整');
  ok(typeof good.json?.explanation?.messageKey === 'string', '解析以 messageKey + args 下发：' + good.json?.explanation?.messageKey);
  ok(good.json?.daily?.newlySolved === true && good.json?.daily?.solvedCount === 1, '答对即记入当天 Session：daily=' + JSON.stringify(good.json?.daily));

  console.log('=== 正解落子持久化（刷新后能还原棋盘） ===');
  const afterSolve = await api('GET', '/api/puzzles/daily?day=' + day, undefined, token);
  ok(afterSolve.json?.session?.phase === 'SOLVED', '重新拉取后阶段=SOLVED（实际 ' + afterSolve.json?.session?.phase + '）');
  ok(afterSolve.json?.session?.solvedCount === 1, 'solvedCount=1（实际 ' + afterSolve.json?.session?.solvedCount + '）');
  const sm = afterSolve.json?.puzzle?.solvedMove;
  ok(sm?.row === a.row && sm?.col === a.col, '服务器保存的是玩家自己下的那一步：' + JSON.stringify(sm));
  // 答案集**只**随 attempt 响应下发：每日列表任何时候都不带答案（刷新也拿不到，免得直接看答案）。
  ok(afterSolve.json?.puzzle?.answers === undefined && afterSolve.json?.puzzle?.explanation === undefined, '每日列表始终不下发答案集与解析（答案只在 attempt 响应里）');

  console.log('=== 进度与错题本 ===');
  const prog = await api('GET', '/api/puzzles/progress', undefined, token);
  ok(prog.json?.progress?.solved === 1, 'solved=1（实际 ' + prog.json?.progress?.solved + '）');
  ok(prog.json?.progress?.failed === 0, '答对后不在错题本（failed=' + prog.json?.progress?.failed + '）');
  ok(prog.json?.progress?.totalAttempts === 2, '总尝试次数=2（实际 ' + prog.json?.progress?.totalAttempts + '）');
  ok(prog.json?.progress?.firstSolvedAt > 0, '首次解出时间已落库');

  console.log('=== 服务器权威的下一题 ===');
  const n1 = await api('POST', '/api/puzzles/daily/next', { day, expectedIndex: 0 }, token);
  ok(n1.status === 200, 'next http=' + n1.status);
  ok(n1.json?.advanced === true, '答对后 next 前进一步（advanced=' + n1.json?.advanced + '）');
  if (n1.json?.completed === true) {
    ok(n1.json?.puzzle === null && n1.json?.session?.currentIndex === n1.json?.session?.total, '最后一题答对 -> completed，且不吐第 ' + (DAILY_SESSION_MAX + 1) + ' 题');
  } else {
    ok(n1.json?.session?.currentIndex === 1 && n1.json?.session?.position === 2, '索引 0 -> 1（实际 ' + n1.json?.session?.currentIndex + '）');
    ok(!!n1.json?.puzzle?.puzzleId && n1.json.puzzle.puzzleId !== local.puzzleId, '下一题是另一道题：' + String(n1.json?.puzzle?.puzzleId).slice(-28));
    ok(n1.json?.puzzle?.answers === undefined && n1.json?.puzzle?.solvedMove === null, '下一题不预发答案，也不带 solvedMove');
    // 未答对就想前进：服务器一律拒绝，无论索引是新的还是过期的 —— 这是「不能空跳刷题」的底线。
    const skip = await api('POST', '/api/puzzles/daily/next', { day, expectedIndex: 1 }, token);
    ok(skip.status === 409 && skip.json?.code === 'CURRENT_PUZZLE_NOT_SOLVED', '未答对想跳到第 3 题 -> 409 CURRENT_PUZZLE_NOT_SOLVED（实际 ' + skip.status + '/' + skip.json?.code + '）');
    const skipStale = await api('POST', '/api/puzzles/daily/next', { day, expectedIndex: 0 }, token);
    ok(skipStale.status === 409 && skipStale.json?.code === 'CURRENT_PUZZLE_NOT_SOLVED' && skipStale.json?.position === 2, '过期索引且未答对 -> 409 且回传真实位置（实际 ' + skipStale.status + '/' + skipStale.json?.code + ' 位置 ' + skipStale.json?.position + '）');
    const back = await api('GET', '/api/puzzles/daily?day=' + day, undefined, token);
    ok(back.json?.session?.currentIndex === 1 && back.json?.puzzle?.puzzleId === n1.json?.puzzle?.puzzleId, '连点两次 next 后索引没有多跳（仍在第 2 格）');

    // 第二题同样用**本仓库题库**里的答案去答：再证明一次线上题库=本仓库题库。
    const bId = String(n1.json.puzzle.puzzleId);
    const localB = PUZZLE_BANK.find((x) => x.puzzleId === bId) as Puzzle | undefined;
    ok(!!localB, '第 2 题也能在本仓库题库里原样找到：' + bId.slice(-28));
    if (localB) {
      const ab = localB.answers[0];
      const goodB = await api('POST', '/api/puzzles/' + bId + '/attempt', { attemptId: 'pub-c2', row: ab.row, col: ab.col }, token);
      ok(goodB.json?.verdict === 'CORRECT' && goodB.json?.daily?.newlySolved === true && goodB.json?.daily?.solvedCount === 2, '用本地答案答对第 2 题并记入 Session（' + goodB.json?.verdict + ' solvedCount=' + goodB.json?.daily?.solvedCount + '）');
      // 答对之后才轮到过期索引：此时服务器该给 STALE_INDEX，并且绝不前进。
      const stale = await api('POST', '/api/puzzles/daily/next', { day, expectedIndex: 0 }, token);
      ok(stale.status === 409 && stale.json?.code === 'STALE_INDEX', '答对后拿过期索引 -> 409 STALE_INDEX（实际 ' + stale.status + '/' + stale.json?.code + '）');
      ok(stale.json?.advanced === false, '被拒的过期请求没有前进（advanced=' + stale.json?.advanced + '）');
      const n3 = await api('POST', '/api/puzzles/daily/next', { day, expectedIndex: 1 }, token);
      ok(n3.json?.advanced === true && n3.json?.session?.currentIndex === 2, '正确索引 -> 前进到第 3 格（实际 ' + n3.json?.session?.currentIndex + '）');
      const back2 = await api('GET', '/api/puzzles/daily?day=' + day, undefined, token);
      ok(back2.json?.session?.currentIndex === 2 && back2.json?.session?.solvedCount === 2, '刷新后索引=2、solvedCount=2（服务器权威）');
    }
  }

  const unknown = await api('POST', '/api/puzzles/not-a-real-puzzle/attempt', { attemptId: 'x', row: 0, col: 0 }, token);
  ok(unknown.status === 404, '未知题目 -> 404（实际 ' + unknown.status + '）');
  const anon = await api('GET', '/api/puzzles/daily');
  ok(anon.status === 401, '未登录取每日题 -> 401（实际 ' + anon.status + '）');

  console.log('=== 观测 ===');
  console.log('  RELEASE=' + release);
  console.log('  DEMO_USER=' + username);
  console.log('  puzzleId=' + local.puzzleId);
  console.log('  type=' + local.acceptanceType + ' answers=' + local.answers.length + ' startPly=' + local.startPly);
  console.log('  session=' + JSON.stringify({ total: s0?.total, afterNext: n1.json?.session?.currentIndex, phase: n1.json?.session?.phase }));
  console.log('  bank=' + JSON.stringify(PUZZLE_BANK_META.byType) + ' hash=' + PUZZLE_BANK_META.bankHash);
  console.log(failures === 0 ? 'PUBLIC PUZZLE CHECK: ALL PASS 0' : 'PUBLIC PUZZLE CHECK: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });