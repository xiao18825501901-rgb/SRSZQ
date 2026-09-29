/**
 * 历史与复盘页（R01/R02/R03/R04/R06 的前端面）。
 *
 * 棋盘用与后端同一份 shared 引擎重建（服务端已经逐手重放校验并把摘要显示出来），
 * 关键片段只展示引擎证明得了的事实，措辞见 reviewCopy.ts。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BoardSize } from '../../../shared/src/game/types';
import { reviewApi, type HistoryItem, type ReplayView } from '../api';
import { KeyMoveList, MoveTimeline, ReviewBoard, ReviewLayout, buildStateFromMoves } from './ReviewParts';
import { END_REASON_LABEL, OUTCOME_LABEL, formatTime } from './reviewCopy';

const PAGE = 10;

function outcomeClass(o: string): string {
  if (o === 'WIN') return 'out-win';
  if (o === 'LOSS') return 'out-loss';
  return 'out-other';
}

export function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<ReplayView | null>(null);
  const [cursor, setCursor] = useState(0);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p0: number) => {
    try {
      const r = await reviewApi.history(PAGE, p0 * PAGE);
      setItems(r.data.history);
      setTotal(r.data.total);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(page); }, [load, page]);

  const open = useCallback(async (gameId: string) => {
    setBusy(true);
    setNotice('');
    try {
      const r = await reviewApi.replay(gameId);
      setView(r.data.replay);
      setCursor(r.data.replay.moveCount);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const shown = useMemo(
    () => (view ? view.moves.slice(0, cursor).map((m) => ({ row: m.row, col: m.col })) : []),
    [view, cursor],
  );
  const rebuilt = useMemo(
    () => (view ? buildStateFromMoves(view.boardSize as BoardSize, shown) : null),
    [view, shown],
  );

  const makeShare = useCallback(async () => {
    if (!view) return;
    setBusy(true);
    try {
      const r = await reviewApi.share(view.gameId);
      const url = `${window.location.origin}${window.location.pathname}#/s/${r.data.share.token}`;
      setNotice(`分享链接已生成（7 天后失效）：${url}`);
      const fresh = await reviewApi.replay(view.gameId);
      setView(fresh.data.replay);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [view]);

  const revoke = useCallback(async (token: string) => {
    setBusy(true);
    try {
      await reviewApi.revoke(token);
      setNotice('已撤销：之后任何人访问该链接都会得到 410。');
      if (view) {
        const fresh = await reviewApi.replay(view.gameId);
        setView(fresh.data.replay);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [view]);

  const list = (
    <div className="rv-table-wrap panel">
      <table className="rv-table" data-testid="history-table">
        <thead>
          <tr><th>时间</th><th>结果</th><th>模式</th><th>棋盘</th><th>终局原因</th><th>手数</th><th>分差</th><th /></tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td colSpan={8} className="muted" data-testid="history-empty">还没有已结算的对局。</td></tr>
          )}
          {items.map((it) => (
            <tr key={it.gameId} data-testid="history-row">
              <td>{formatTime(it.settledAt)}</td>
              <td>
                <span className={`rv-out ${outcomeClass(it.outcome)}`}>{OUTCOME_LABEL[it.outcome] ?? it.outcome}</span>
                <span className="muted">（{it.seat} 座）</span>
              </td>
              <td>{it.mode === 'online' ? '在线' : it.mode}</td>
              <td>{it.boardSize} 路</td>
              <td>{END_REASON_LABEL[it.endReason] ?? it.endReason}</td>
              <td>{it.moveCount}</td>
              <td>{it.ratingDelta > 0 ? `+${it.ratingDelta}` : it.ratingDelta}</td>
              <td><button className="btn" data-testid="open-replay" onClick={() => void open(it.gameId)} disabled={busy}>复盘</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rv-pager">
        <button className="btn" onClick={() => setPage((x) => Math.max(0, x - 1))} disabled={page === 0 || busy}>上一页</button>
        <span className="muted" data-testid="history-total">共 {total} 局 · 第 {page + 1} 页</span>
        <button className="btn" onClick={() => setPage((x) => x + 1)} disabled={(page + 1) * PAGE >= total || busy}>下一页</button>
      </div>
    </div>
  );

  const detail = view && rebuilt && (
    <ReviewLayout
      timeline={(
        <MoveTimeline
          moves={view.moves}
          cursor={cursor}
          onCursor={setCursor}
          keyPlies={view.keyMoves.map((k) => k.ply)}
          label={`时间线 · 共 ${view.moveCount} 手`}
        />
      )}
      board={(
        <div className="rv-board-stack">
          <ReviewBoard state={rebuilt.state} showNumbers disabled onCellClick={() => undefined} />
          <div className="rv-scrub" data-testid="replay-scrub">
            <input
              type="range"
              min={0}
              max={view.moveCount}
              value={cursor}
              aria-label="复盘进度"
              onChange={(e) => setCursor(Number(e.target.value))}
            />
            <div className="rv-scrub-row">
              <button className="btn" onClick={() => setCursor((c) => Math.max(0, c - 1))}>上一手</button>
              <button className="btn" onClick={() => setCursor((c) => Math.min(view.moveCount, c + 1))}>下一手</button>
              <button className="btn" onClick={() => setCursor(view.moveCount)}>终局</button>
            </div>
            {rebuilt.rejected > 0 && <p className="rv-alert">有 {rebuilt.rejected} 手在当前局面下非法（不会静默当作合法）。</p>}
          </div>
        </div>
      )}
      aside={(
        <div className="rv-aside-stack">
          <div className="panel rv-summary" data-testid="replay-summary">
            <div className="panel-title">本局</div>
            <p>
              结果 <span className={`rv-out ${outcomeClass(view.myOutcome)}`}>{OUTCOME_LABEL[view.myOutcome] ?? view.myOutcome}</span>
              <span className="muted"> · {view.mySeat} 座 · 分差 {view.myRatingDelta}</span>
            </p>
            <p className="muted">重放摘要 {view.finalHash}</p>
            <p className="muted">与服务器快照一致：{String(view.hashMatches)} · 分析口径 {view.analysisMode}</p>
            <div className="rv-btnrow">
              <button className="btn" onClick={() => { setView(null); setNotice(''); }} disabled={busy} data-testid="close-replay">返回列表</button>
              <button className="btn primary" onClick={() => void makeShare()} disabled={busy} data-testid="create-share">生成分享链接</button>
            </div>
            {view.shares.length > 0 && (
              <ul className="rv-shares" data-testid="share-list">
                {view.shares.map((s) => (
                  <li key={s.token}>
                    <code>#/s/{s.token.slice(0, 8)}…</code>
                    <span className="muted">{s.revokedAt ? '已撤销' : `有效至 ${formatTime(s.expiresAt)}`} · 浏览 {s.views}</span>
                    {!s.revokedAt && <button className="linklike" onClick={() => void revoke(s.token)} disabled={busy}>撤销</button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <KeyMoveList moves={view.keyMoves} />
        </div>
      )}
    />
  );

  return (
    <main className="rv-page" data-testid="history-page">
      <div className="rv-page-head">
        <h1>历史与复盘</h1>
        <p className="muted">本人各模式的终局都可读；棋谱由服务端逐手重放校验过，摘要可以直接对照。</p>
      </div>
      {err && <p role="alert" className="rv-alert" data-testid="history-error">{err}</p>}
      {notice && <p className="rv-notice" data-testid="history-notice">{notice}</p>}
      {view ? detail : list}
    </main>
  );
}