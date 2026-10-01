/**
 * 每日训练 Session（Daily Training Session）/ 错题重练。
 *
 * 相对上一版的实质变化：
 *  - **去掉了每日训练里的历史回放控件**（第一手/上一手/下一手/最后一手/回到当前局面/手数）：
 *    每日一题不该表现得像棋局日志。正常对局的棋局日志与赛后复盘不受影响（那是别的页面）。
 *  - 棋盘不显示手数（Daily Puzzle 只显示红/绿/白棋子）。
 *  - 两阶段：ANSWERING（点空交叉点 → 服务端判题）/ SOLVED（正解**留在棋盘上**并冻结）。
 *  - 答错只是短暂提示“再想想”，题面立刻恢复原样，不显示答案，可以继续作答。
 *  - 保存的是**玩家自己选的**那一步正解（多个正解时以玩家选择为准，不强制 answers[0]）。
 *  - “下一题”由服务器权威推进：未答对不可用；双请求不会跳两题；最后一题给“今日训练完成”。
 *
 * 纪律：判题一律在服务端（客户端不做答案判定，也拿不到完整答案集）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardSize } from '../../../shared/src/game/types';
import { applyMove } from '../../../shared/src/game/rules';
import { puzzleApi, type AttemptResult, type DailySessionView, type PuzzleProgress, type PuzzleView } from '../api';
import { ReviewBoard, buildStateFromMoves } from './ReviewParts';
import { VictoryTrack } from '../components/MatchPanel';
import { timelineCopy, timelineOf } from './puzzleTimeline';
import { ACCEPTANCE_LABEL, explainPuzzle } from './reviewCopy';
import { playerName } from '../playerPresentation';

const VERDICT_LABEL: Record<string, string> = {
  CORRECT: '正确', INCORRECT: '不对', ILLEGAL: '这一手不合法', OPEN: '开放研究题',
};

/**
 * 把接口错误翻成用户看得懂的话。只改**显示**：原始错误仍然打到控制台，便于排查。
 */
function friendlyPuzzleError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/CURRENT_PUZZLE_NOT_SOLVED/.test(msg)) return '先答对当前这道题，才能进入下一题。';
  if (/STALE_INDEX/.test(msg)) return '进度已经更新过了，已为你同步到最新状态。';
  if (/not found|HTTP 404/i.test(msg)) return '题目不存在或已更新，请重新加载今日训练。';
  if (/HTTP 5\d\d|source trajectory missing/i.test(msg)) return '暂时无法判题，请稍后重试。';
  if (/unauthorized|HTTP 401|HTTP 403/i.test(msg)) return '登录状态已过期，请重新登录后再试。';
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) return '提交失败，请检查网络后重试。';
  return msg;
}

export function PuzzlePage() {
  const [session, setSession] = useState<DailySessionView | null>(null);
  const [puzzle, setPuzzle] = useState<PuzzleView | null>(null);
  const [bank, setBank] = useState<{ total: number; byType: Record<string, number>; solverVersion: string } | null>(null);
  const [progress, setProgress] = useState<PuzzleProgress | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [wrong, setWrong] = useState<{ row: number; col: number } | null>(null);
  const [mode, setMode] = useState<'session' | 'single'>('session');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const loadProgress = useCallback(async () => {
    try {
      const r = await puzzleApi.progress();
      setProgress(r.data.progress);
    } catch (e) {
      console.warn('[puzzle] progress failed', e);
    }
  }, []);

  const loadTraining = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setWrong(null);
    try {
      const r = await puzzleApi.daily();
      setSession(r.data.session);
      setPuzzle(r.data.puzzle);
      setBank(r.data.bank);
      setMode('session');
      setErr('');
    } catch (e) {
      console.warn('[puzzle] load training failed', e);
      setErr(friendlyPuzzleError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 错题重练：单题模式（不属于今天的 Session，因此不参与今日进度与“下一题”）。 */
  const loadSingle = useCallback(async (puzzleId: string) => {
    setBusy(true);
    setResult(null);
    setWrong(null);
    try {
      const r = await puzzleApi.get(puzzleId);
      setPuzzle(r.data.puzzle);
      setMode('single');
      setErr('');
    } catch (e) {
      console.warn('[puzzle] load single failed', e);
      setErr(friendlyPuzzleError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void loadTraining(); void loadProgress(); }, [loadTraining, loadProgress]);

  // 题面局面（不含玩家的正解棋子）。
  const base = useMemo(
    () => (puzzle ? buildStateFromMoves(puzzle.boardSize as BoardSize, puzzle.moves).state : null),
    [puzzle],
  );
  const solvedMove = puzzle?.solvedMove ?? null;
  const solved = solvedMove !== null;
  // 显示局面：答对后是 baseState + 玩家下的那一步（这一步必须真的留在棋盘上）。
  const displayState = useMemo(() => {
    if (!base) return null;
    if (!solvedMove) return base;
    const res = applyMove(base, solvedMove.row, solvedMove.col);
    return res.rejected ? base : res.state;
  }, [base, solvedMove]);
  // 时间线与棋盘永远同一个局面：ANSWERING 用题面，SOLVED 用题面+正解。
  const timeline = useMemo(() => (displayState ? timelineOf(displayState) : null), [displayState]);
  const copy = timeline ? timelineCopy(timeline) : null;
  const complete = session?.phase === 'COMPLETE';
  const isLastPuzzle = !!session && session.total > 0 && session.currentIndex + 1 >= session.total;

  // 答错的短暂标记：只标记那一格，900ms 后消失；题面本身不变（不落子）。
  useEffect(() => {
    if (!wrong) return;
    const sel = '.go-point[data-row="' + wrong.row + '"][data-col="' + wrong.col + '"]';
    const el = document.querySelector(sel);
    el?.classList.add('rv-flash-wrong');
    const t = setTimeout(() => { el?.classList.remove('rv-flash-wrong'); setWrong(null); }, 900);
    return () => { clearTimeout(t); el?.classList.remove('rv-flash-wrong'); };
  }, [wrong]);

  const submit = useCallback(async (row: number, col: number) => {
    if (!puzzle || busy || solved) return;
    setBusy(true);
    try {
      seq.current += 1;
      const attemptId = 'ui-' + puzzle.puzzleId + '-' + Date.now().toString(36) + '-' + seq.current;
      const r = await puzzleApi.attempt(puzzle.puzzleId, attemptId, row, col);
      setResult(r.data);
      await loadProgress();
      if (r.data.verdict === 'CORRECT') {
        // 保存并显示的是**玩家选择的**这一步（服务端回执里带回来）。
        const mv = r.data.daily?.solvedMove ?? { row, col, seat: puzzle.actorSeat };
        setPuzzle((p) => (p ? { ...p, solvedMove: mv } : p));
        setSession((s) => (s ? { ...s, phase: 'SOLVED', solvedCount: r.data.daily?.solvedCount ?? s.solvedCount } : s));
        setWrong(null);
      } else {
        // 合法但不是答案（或非法落点）：短暂标记后恢复题面，不显示答案。
        setWrong({ row, col });
      }
      setErr('');
    } catch (e) {
      console.warn('[puzzle] attempt failed', e);
      setErr(friendlyPuzzleError(e));
    } finally {
      setBusy(false);
    }
  }, [puzzle, busy, solved, loadProgress]);

  const nextPuzzle = useCallback(async () => {
    if (!session || complete) return;
    setBusy(true);
    try {
      const r = await puzzleApi.next(session.currentIndex);
      setSession(r.data.session);
      setPuzzle(r.data.puzzle);
      setResult(null);
      setWrong(null);
      setErr('');
    } catch (e) {
      console.warn('[puzzle] next failed', e);
      setErr(friendlyPuzzleError(e));
      void loadTraining(); // 409 之后把状态拉回服务器真相
    } finally {
      setBusy(false);
    }
  }, [session, complete, loadTraining]);

  return (
    <main className="rv-page" data-testid="puzzle-page">
      <div className="rv-page-head">
        <h1>每日训练</h1>
        <p className="muted" data-testid="puzzle-position">
          {mode === 'single' ? '错题重练' : session ? '第 ' + session.position + ' / ' + session.total + ' 题' : '正在准备今天的训练…'}
          {bank && <> · 今日题库 {bank.total} 道</>}
        </p>
      </div>
      {err && <p role="alert" className="rv-alert" data-testid="puzzle-error">{err}</p>}

      {complete && (
        <div className="panel" data-testid="puzzle-complete">
          <div className="panel-title">今日训练完成</div>
          <p>今天的 {session?.total ?? 0} 道题已经全部做完（{session?.solvedCount ?? 0} / {session?.total ?? 0}）。明天会有新的训练。</p>
        </div>
      )}

      {!complete && puzzle && displayState && (
        <div className="rv-puzzle-layout">
          <div className="rv-col-board rv-puzzle-board">
            <ReviewBoard
              state={displayState}
              showNumbers={false}
              disabled={solved || busy}
              onCellClick={(r, c) => void submit(r, c)}
            />
          </div>
          <aside className="rv-col-aside">
            <div className="panel rv-puzzle-info" data-testid="puzzle-info">
              <div className="rv-row">
                <span className="rv-tag" data-testid="puzzle-type">{ACCEPTANCE_LABEL[puzzle.acceptanceType] ?? puzzle.acceptanceType}</span>
                <span className="muted" data-testid="puzzle-round">第 {puzzle.round} 轮 · {playerName(puzzle.actorSeat)}行棋</span>
              </div>
            </div>

            {timeline && copy && (
              <div className="panel" data-testid="puzzle-timeline" data-round={copy.round} data-eligible={copy.eligible ?? 'none'} data-phase={solved ? 'SOLVED' : 'ANSWERING'}>
                <div className="panel-title">胜权时间线</div>
                <p data-testid="puzzle-timeline-current">{copy.current}</p>
                <p className="muted" data-testid="puzzle-timeline-next">{copy.next}</p>
                <VictoryTrack state={displayState} ended={false} thinking={false} />
              </div>
            )}

            {solved && (
              <div className="panel rv-verdict" data-testid="puzzle-verdict-panel">
                <div className="panel-title">判定</div>
                <p className="rv-verdict rv-verdict-correct" data-testid="puzzle-verdict">正确</p>
                <p className="muted" data-testid="puzzle-solved-note">你的这一步已经留在棋盘上（{playerName(solvedMove!.seat as 'A' | 'B' | 'C')}）。</p>
                {result?.explanation && (
                  <p className="rv-explain" data-testid="puzzle-explanation">
                    {explainPuzzle(result.explanation.messageKey, result.explanation.args)}
                  </p>
                )}
              </div>
            )}

            {!solved && wrong && (
              <div className="panel rv-verdict" data-testid="puzzle-wrong-panel">
                <p className="rv-verdict rv-verdict-incorrect" data-testid="puzzle-feedback">再想想</p>
                <p className="muted">这一手不是题目要的答案，题面已经恢复，可以继续试。</p>
              </div>
            )}

            {!solved && !wrong && result && result.verdict !== 'CORRECT' && (
              <div className="panel rv-verdict" data-testid="puzzle-wrong-panel">
                <p className="rv-verdict rv-verdict-incorrect" data-testid="puzzle-feedback">{VERDICT_LABEL[result.verdict] ?? result.verdict}</p>
                <p className="muted">再想想。题面没有改变。</p>
              </div>
            )}

            <div className="panel" data-testid="puzzle-today">
              <div className="panel-title">今日进度</div>
              <p data-testid="puzzle-today-progress">{session?.solvedCount ?? 0} / {session?.total ?? 0}</p>
              {mode === 'session' ? (
                <>
                  <button
                    className="btn primary wide"
                    data-testid="puzzle-next"
                    disabled={!solved || busy || complete}
                    onClick={() => void nextPuzzle()}
                  >
                    {complete ? '今日训练完成' : isLastPuzzle ? '完成今日训练' : '下一题'}
                  </button>
                  {!solved && <p className="muted" data-testid="puzzle-next-hint">答对当前题目后才能进入下一题。</p>}
                </>
              ) : (
                <button className="btn wide" data-testid="back-to-training" onClick={() => void loadTraining()} disabled={busy}>返回今日训练</button>
              )}
            </div>

            <div className="panel rv-progress" data-testid="puzzle-progress">
              <div className="panel-title">我的进度</div>
              <p data-testid="progress-line">
                已解出 {progress?.solved ?? 0} · 待解 {progress?.failed ?? 0} · 累计尝试 {progress?.totalAttempts ?? 0} / 题库 {progress?.totalPublished ?? 0}
              </p>
              {progress && progress.wrong.length > 0 && (
                <ul className="rv-wrong" data-testid="wrong-list">
                  {progress.wrong.map((w) => (
                    <li key={w.puzzleId}>
                      <span>{ACCEPTANCE_LABEL[w.acceptanceType ?? ''] ?? '题目'}</span>
                      <span className="muted">{w.attempts} 次未解</span>
                      <button className="linklike" data-testid="retry-puzzle" onClick={() => void loadSingle(w.puzzleId)} disabled={busy}>重练</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
