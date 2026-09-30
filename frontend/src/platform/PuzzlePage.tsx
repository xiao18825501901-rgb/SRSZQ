/**
 * 每日一题 / 错题重练（R07/R08 的前端面）。
 *
 * 纪律：未作答前不显示答案，也不显示威胁数量（那是提示）；判题由服务端用完整答案集做，
 * 客户端只负责把局面按 shared 引擎重放出来、把返回的结论如实显示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardSize } from '../../../shared/src/game/types';
import { puzzleApi, type AttemptResult, type PuzzleProgress, type PuzzleView } from '../api';
import { ReviewBoard, buildStateFromMoves } from './ReviewParts';
import { VictoryTrack } from '../components/MatchPanel';
import { clampStep, timelineCopy, timelineOf } from './puzzleTimeline';
import { ACCEPTANCE_LABEL, explainPuzzle } from './reviewCopy';
import { playerName } from '../playerPresentation';

const VERDICT_LABEL: Record<string, string> = {
  CORRECT: '正确', INCORRECT: '不对', ILLEGAL: '这一手不合法', OPEN: '开放研究题',
};

/**
 * 把接口错误翻成用户看得懂的话。
 *
 * 注意：这只改**显示**，不掩盖问题——原始错误仍然打到控制台，便于排查。
 * 根因（题目 id 未解码导致的所有作答 404）已在后端修掉，这里只是别再把
 * “not found / HTTP 500”这类字样直接甩给普通用户。
 */
function friendlyPuzzleError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found|HTTP 404/i.test(msg)) return '题目不存在或已更新，请重新加载今日题目。';
  if (/HTTP 5\d\d|source trajectory missing/i.test(msg)) return '暂时无法判题，请稍后重试。';
  if (/unauthorized|HTTP 401|HTTP 403/i.test(msg)) return '登录状态已过期，请重新登录后再试。';
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) return '提交失败，请检查网络后重试。';
  return msg;
}

export function PuzzlePage() {
  const [puzzle, setPuzzle] = useState<PuzzleView | null>(null);
  const [bank, setBank] = useState<{ total: number; byType: Record<string, number>; solverVersion: string } | null>(null);
  const [progress, setProgress] = useState<PuzzleProgress | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 正在查看第几手：null = 跟随最新局面。上一步/下一步/回到开局都只改这个值，
  // 棋盘与胜权时间线都从它算出来——所以复盘时时间线必然跟着走。
  const [viewStep, setViewStep] = useState<number | null>(null);
  const seq = useRef(0);

  const loadProgress = useCallback(async () => {
    try {
      const r = await puzzleApi.progress();
      setProgress(r.data.progress);
    } catch (e) {
      console.warn('[puzzle] progress failed', e);
      setErr(friendlyPuzzleError(e));
    }
  }, []);

  const loadPuzzle = useCallback(async (puzzleId?: string) => {
    setBusy(true);
    setResult(null);
    setViewStep(null);
    try {
      if (puzzleId) {
        const r = await puzzleApi.get(puzzleId);
        setPuzzle(r.data.puzzle);
      } else {
        const r = await puzzleApi.daily();
        setPuzzle(r.data.puzzle);
        setBank(r.data.bank);
      }
      setErr('');
    } catch (e) {
      console.warn('[puzzle] load failed', e);
      setErr(friendlyPuzzleError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void loadPuzzle(); void loadProgress(); }, [loadPuzzle, loadProgress]);

  const totalSteps = puzzle?.moves.length ?? 0;
  const step = clampStep(viewStep ?? totalSteps, totalSteps);
  const atLive = step >= totalSteps;
  const built = useMemo(
    () => (puzzle ? buildStateFromMoves(puzzle.boardSize as BoardSize, puzzle.moves, step) : null),
    [puzzle, step],
  );
  // 时间线永远由“当前正在查看的局面”算出（同一个共享资格引擎，Online Match 也用这个函数）。
  const timeline = useMemo(() => (built ? timelineOf(built.state) : null), [built]);
  const copy = timeline ? timelineCopy(timeline) : null;

  const submit = useCallback(async (row: number, col: number) => {
    if (!puzzle || busy || !atLive) return;
    setBusy(true);
    try {
      seq.current += 1;
      const attemptId = `ui-${puzzle.puzzleId}-${Date.now().toString(36)}-${seq.current}`;
      const r = await puzzleApi.attempt(puzzle.puzzleId, attemptId, row, col);
      setResult(r.data);
      await loadProgress();
      if (r.data.solved) {
        const fresh = await puzzleApi.get(puzzle.puzzleId);
        setPuzzle(fresh.data.puzzle);
      }
      setErr('');
    } catch (e) {
      console.warn('[puzzle] attempt failed', e);
      setErr(friendlyPuzzleError(e));
    } finally {
      setBusy(false);
    }
  }, [puzzle, busy, loadProgress, atLive]);

  return (
    <main className="rv-page" data-testid="puzzle-page">
      <div className="rv-page-head">
        <h1>每日一题</h1>
        <p className="muted">
          题目来自真实对局的完整轨迹，答案集是穷举证明过的：集合里的任何一个都算对。
          {bank && <> 当前题库 {bank.total} 道 · 判题器 {bank.solverVersion}</>}
        </p>
      </div>
      {err && <p role="alert" className="rv-alert" data-testid="puzzle-error">{err}</p>}

      {puzzle && built && (
        <div className="rv-puzzle-layout">
          <div className="rv-col-board rv-puzzle-board">
            <ReviewBoard state={built.state} disabled={busy || result?.verdict === 'CORRECT' || !atLive} onCellClick={(r, c) => void submit(r, c)} />
            <div className="rv-btnrow" data-testid="puzzle-steps">
              <button className="btn" data-testid="puzzle-step-first" onClick={() => setViewStep(0)} disabled={step === 0}>|‹</button>
              <button className="btn" data-testid="puzzle-step-prev" onClick={() => setViewStep(clampStep(step - 1, totalSteps))} disabled={step === 0}>‹</button>
              <span className="muted" data-testid="puzzle-step-info">第 {step} / {totalSteps} 手</span>
              <button className="btn" data-testid="puzzle-step-next" onClick={() => setViewStep(clampStep(step + 1, totalSteps))} disabled={atLive}>›</button>
              <button className="btn" data-testid="puzzle-step-live" onClick={() => setViewStep(null)} disabled={atLive}>回到当前局面</button>
            </div>
            {!atLive && (
              <p className="rv-notice" data-testid="puzzle-rewound">
                正在查看历史局面（第 {step} / {totalSteps} 手）：回到当前局面后才能落子。
              </p>
            )}
          </div>
          <aside className="rv-col-aside">
            <div className="panel rv-puzzle-info" data-testid="puzzle-info">
              <div className="rv-row">
                <span className="rv-tag" data-testid="puzzle-type">{ACCEPTANCE_LABEL[puzzle.acceptanceType] ?? puzzle.acceptanceType}</span>
                <span className="muted" data-testid="puzzle-round">第 {puzzle.round} 轮 · {playerName(puzzle.actorSeat)}行棋</span>
              </div>
            </div>

            {timeline && copy && (
              <div className="panel" data-testid="puzzle-timeline" data-round={copy.round} data-eligible={copy.eligible ?? 'none'}>
                <div className="panel-title">胜权时间线</div>
                <p data-testid="puzzle-timeline-current">{copy.current}</p>
                <p className="muted" data-testid="puzzle-timeline-next">{copy.next}</p>
                <VictoryTrack state={built.state} ended={false} thinking={false} />
              </div>
            )}

            {result && (
              <div className="panel rv-verdict" data-testid="puzzle-verdict-panel">
                <div className="panel-title">判定</div>
                <p className={`rv-verdict rv-verdict-${result.verdict.toLowerCase()}`} data-testid="puzzle-verdict">
                  {VERDICT_LABEL[result.verdict] ?? result.verdict}
                  <span className="muted"> · 第 {result.attempts} 次尝试{result.duplicate ? '（重发，未重复计数）' : ''}</span>
                </p>
                {result.verdict === 'CORRECT' && <p className="rv-notice">已解出，进度已保存。</p>}
                {result.verdict === 'INCORRECT' && !result.answers && <p className="muted">还能再试。连续 3 次后会直接给出完整答案与解析。</p>}
                {result.explanation && (
                  <p className="rv-explain" data-testid="puzzle-explanation">
                    {explainPuzzle(result.explanation.messageKey, result.explanation.args)}
                  </p>
                )}
                {result.answers && (
                  <p className="muted" data-testid="puzzle-answers">
                    已证明的答案 {result.answerCount} 个：{result.answers.map((c) => `(${c.row + 1}, ${c.col + 1})`).join('、')}
                  </p>
                )}
              </div>
            )}

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
                      <button className="linklike" data-testid="retry-puzzle" onClick={() => void loadPuzzle(w.puzzleId)} disabled={busy}>重练</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="rv-btnrow">
                <button className="btn" data-testid="back-to-daily" onClick={() => void loadPuzzle()} disabled={busy}>回到今日题目</button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}