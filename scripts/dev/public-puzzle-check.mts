
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
import { dailyPuzzleId, expandTrails, startStateOf, type Puzzle, type Trail } from '../../shared/src/product/puzzleBank.js';
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
  console.log('=== 每日题（' + day + '） ===');
  const daily = await api('GET', '/api/puzzles/daily?day=' + day, undefined, token);
  ok(daily.status === 200, 'daily http=' + daily.status);
  const online = daily.json?.puzzle;
  const localPublished = PUZZLE_BANK.filter((x) => x.status === 'PUBLISHED');
  const localId = dailyPuzzleId(localPublished, day);
  ok(online?.puzzleId === localId, '线上今日题目 = 本仓库确定性算出的同一题（' + String(localId).slice(-28) + '）');
  const local = localPublished.find((x) => x.puzzleId === localId) as Puzzle | undefined;
  ok(!!local, '本地题库存在该题');
  if (!local) { console.log('FATAL: 本地题库缺题'); process.exit(1); }
  ok(online?.acceptanceType === local.acceptanceType && online?.boardSize === local.boardSize, '题类/棋盘与本地一致');
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
  const conflict = await api('POST', '/api/puzzles/' + local.puzzleId + '/attempt', { attemptId: 'pub-w1', row: 0, col: 0 }, token);
  ok(conflict.status === 409, '同一 attemptId 换答案 -> 409（实际 ' + conflict.status + '）');
  const a = local.answers[0];
  const good = await api('POST', '/api/puzzles/' + local.puzzleId + '/attempt', { attemptId: 'pub-c1', row: a.row, col: a.col }, token);
  ok(good.json?.verdict === 'CORRECT', '答案点 -> CORRECT（实际 ' + good.json?.verdict + '）');
  ok(Array.isArray(good.json?.answers) && good.json.answers.length === local.answers.length, '答对后下发完整答案集（' + good.json?.answers?.length + ' 个）');
  ok(good.json?.answerSetComplete === true, '答案集标记为完整');
  ok(typeof good.json?.explanation?.messageKey === 'string', '解析以 messageKey + args 下发：' + good.json?.explanation?.messageKey);

  console.log('=== 进度与错题本 ===');
  const prog = await api('GET', '/api/puzzles/progress', undefined, token);
  ok(prog.json?.progress?.solved === 1, 'solved=1（实际 ' + prog.json?.progress?.solved + '）');
  ok(prog.json?.progress?.failed === 0, '答对后不在错题本（failed=' + prog.json?.progress?.failed + '）');
  ok(prog.json?.progress?.totalAttempts === 2, '总尝试次数=2（实际 ' + prog.json?.progress?.totalAttempts + '）');
  ok(prog.json?.progress?.firstSolvedAt > 0, '首次解出时间已落库');
  const unknown = await api('POST', '/api/puzzles/not-a-real-puzzle/attempt', { attemptId: 'x', row: 0, col: 0 }, token);
  ok(unknown.status === 404, '未知题目 -> 404（实际 ' + unknown.status + '）');
  const anon = await api('GET', '/api/puzzles/daily');
  ok(anon.status === 401, '未登录取每日题 -> 401（实际 ' + anon.status + '）');

  console.log('=== 观测 ===');
  console.log('  RELEASE=' + release);
  console.log('  DEMO_USER=' + username);
  console.log('  puzzleId=' + local.puzzleId);
  console.log('  type=' + local.acceptanceType + ' answers=' + local.answers.length + ' startPly=' + local.startPly);
  console.log('  bank=' + JSON.stringify(PUZZLE_BANK_META.byType) + ' hash=' + PUZZLE_BANK_META.bankHash);
  console.log(failures === 0 ? 'PUBLIC PUZZLE CHECK: ALL PASS 0' : 'PUBLIC PUZZLE CHECK: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });