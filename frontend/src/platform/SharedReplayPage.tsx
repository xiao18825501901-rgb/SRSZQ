/**
 * 分享链接的只读页面（R06）：按 token 读取**去标识**视图。
 *
 * 这个页面不登录也能看，因此它只使用后端返回的脱敏数据：座位字母、棋色、坐标、
 * 已证实的解释，没有用户名、邮箱、内部 ID。撤销或过期后后端返回 410，这里如实显示。
 */
import { useEffect, useMemo, useState } from 'react';
import type { BoardSize } from '../../../shared/src/game/types';
import { API_BASE, type KeyMove } from '../api';
import { KeyMoveList, MoveTimeline, ReviewBoard, ReviewLayout, buildStateFromMoves } from './ReviewParts';
import { END_REASON_LABEL, formatTime } from './reviewCopy';

interface SharedView {
  demo: boolean;
  rulesetVersion: string;
  mode: string;
  boardSize: number;
  endReason: string;
  settledAt: number;
  status: string;
  winnerSeat: string | null;
  seatLabels: Record<string, string>;
  seats: Array<{ seat: string; label: string; kind: string; outcome: string; ratingDelta: number }>;
  moveCount: number;
  moves: Array<{ ply: number; seat: 'A' | 'B' | 'C'; row: number; col: number; round: number }>;
  keyMoves: KeyMove[];
  finalHash: string;
  replayOk: boolean;
  analysisMode: string;
  createdAt: number;
  expiresAt: number;
  views: number;
}

export function SharedReplayPage({ token }: { token: string }) {
  const [shared, setShared] = useState<SharedView | null>(null);
  const [err, setErr] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/shared/${encodeURIComponent(token)}`);
        const data = (await res.json()) as { ok: boolean; shared?: SharedView; error?: string };
        if (!alive) return;
        if (!res.ok || !data.shared) {
          setErr(res.status === 410 ? `这个分享链接已经不可用（${data.error === 'revoked' ? '已被创建者撤销' : '已过期'}）。` : (data.error ?? `HTTP ${res.status}`));
          return;
        }
        setShared(data.shared);
        setCursor(data.shared.moveCount);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [token]);

  const shown = useMemo(
    () => (shared ? shared.moves.slice(0, cursor).map((m) => ({ row: m.row, col: m.col })) : []),
    [shared, cursor],
  );
  const rebuilt = useMemo(
    () => (shared ? buildStateFromMoves(shared.boardSize as BoardSize, shown) : null),
    [shared, shown],
  );

  if (err) {
    return (
      <main className="rv-page" data-testid="shared-page">
        <div className="rv-page-head"><h1>分享的棋局</h1></div>
        <p className="rv-alert" data-testid="shared-error">{err}</p>
      </main>
    );
  }
  if (!shared || !rebuilt) {
    return <main className="rv-page" data-testid="shared-page"><p className="muted" data-testid="shared-loading">正在读取…</p></main>;
  }

  return (
    <main className="rv-page" data-testid="shared-page">
      <div className="rv-page-head">
        <h1>分享的棋局</h1>
        <p className="muted" data-testid="shared-meta">
          {shared.boardSize} 路 · {END_REASON_LABEL[shared.endReason] ?? shared.endReason} · 终局于 {formatTime(shared.settledAt)} · 浏览 {shared.views} 次
          {shared.demo && <span className="rv-demo" data-testid="shared-demo">DEMO（含合成/演示账号）</span>}
        </p>
      </div>
      <ReviewLayout
        timeline={<MoveTimeline moves={shared.moves} cursor={cursor} onCursor={setCursor} keyPlies={shared.keyMoves.map((k) => k.ply)} label={`时间线 · 共 ${shared.moveCount} 手`} />}
        board={<ReviewBoard state={rebuilt.state} showNumbers disabled onCellClick={() => undefined} />}
        aside={(
          <div className="rv-aside-stack">
            <div className="panel rv-summary" data-testid="shared-seats">
              <div className="panel-title">座位与结果</div>
              <ul className="rv-seats">
                {shared.seats.map((s) => (
                  <li key={s.seat} data-testid={`shared-seat-${s.seat}`}>
                    <span>{s.label}</span>
                    <span className="muted">{s.outcome} · {s.ratingDelta > 0 ? `+${s.ratingDelta}` : s.ratingDelta} · {s.kind === 'ai' ? 'AI' : '玩家'}</span>
                  </li>
                ))}
              </ul>
              <p className="muted">重放摘要 {shared.finalHash} · 重放校验 {String(shared.replayOk)}</p>
            </div>
            <KeyMoveList moves={shared.keyMoves} />
          </div>
        )}
      />
    </main>
  );
}