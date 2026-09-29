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
import { ACCEPTANCE_LABEL, explainPuzzle } from './reviewCopy';

const VERDICT_LABEL: Record<string, string> = {
  CORRECT: '正确', INCORRECT: '不对', ILLEGAL: '这一手不合法', OPEN: '开放研究题',
};

export function PuzzlePage() {
  const [puzzle, setPuzzle] = useState<PuzzleView | null>(null);
  const [bank, setBank] = useState<{ total: number; byType: Record<string, number>; solverVersion: string } | null>(null);
  const [progress, setProgress] = useState<PuzzleProgress | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const loadProgress = useCallback(async () => {
    try {
      const r = await puzzleApi.progress();
      setProgress(r.data.progress);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadPuzzle = useCallback(async (puzzleId?: string) => {
    setBusy(true);
    setResult(null);
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
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void loadPuzzle(); void loadProgress(); }, [loadPuzzle, loadProgress]);

  const built = useMemo(
    () => (puzzle ? buildStateFromMoves(puzzle.boardSize as BoardSize, puzzle.moves) : null),
    [puzzle],
  );

  const submit = useCallback(async (row: number, col: number) => {
    if (!puzzle || busy) return;
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
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [puzzle, busy, loadProgress]);

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
            <ReviewBoard state={built.state} disabled={busy || result?.verdict === 'CORRECT'} onCellClick={(r, c) => void submit(r, c)} />
            <p className="muted rv-hint">点一个空交叉点落子。答案提交后由服务端用完整答案集判定。</p>
          </div>
          <aside className="rv-col-aside">
            <div className="panel rv-puzzle-info" data-testid="puzzle-info">
              <div className="rv-row">
                <span className="rv-tag" data-testid="puzzle-type">{ACCEPTANCE_LABEL[puzzle.acceptanceType] ?? puzzle.acceptanceType}</span>
                <span className="muted" data-testid="puzzle-round">第 {puzzle.round} 轮 · {puzzle.actorSeat} 座行棋</span>
              </div>
              <p className="muted" data-testid="puzzle-status">
                我的状态：{puzzle.myStatus === 'SOLVED' ? '已解出' : puzzle.myStatus === 'FAILED' ? '还没解出' : '未作答'} · 已尝试 {puzzle.myAttempts} 次
              </p>
              <p className="muted">起始局面 {puzzle.startMoves} 手 · {puzzle.boardSize} 路 · 来源 {puzzle.sourceKind}</p>
            </div>

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