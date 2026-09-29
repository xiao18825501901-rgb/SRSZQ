/**
 * 复盘/题库共用部件（R09）。
 *
 * 布局口径按验收矩阵 R09：手机端**时间线在上、棋盘居中、操作在下**；桌面端棋盘在左、信息在右。
 * 棋色沿用既有红绿白（白棋在棋盘上有描边，仍可辨认），不新造一套视觉语言。
 */
import { useMemo, type ReactNode } from 'react';
import type { BoardSize, GameState } from '../../../shared/src/game/types';
import { applyMove, createInitialState } from '../../../shared/src/game/rules';
import { Board } from '../components/Board';
import type { KeyMove, ReplayMove } from '../api';
import { certaintyNote, explainKeyMove, keyMoveTitle } from './reviewCopy';

export const SEAT_DOT: Record<string, string> = { A: 'dot-a', B: 'dot-b', C: 'dot-c' };

/** 用真实引擎把落子序列重建成局面；任何一手被引擎拒绝都会被计数并暴露出来。 */
export function buildStateFromMoves(boardSize: BoardSize, moves: Array<{ row: number; col: number }>): { state: GameState; rejected: number } {
  let state = createInitialState(boardSize);
  let rejected = 0;
  for (const m of moves) {
    const res = applyMove(state, m.row, m.col);
    if (res.rejected) { rejected += 1; continue; }
    state = res.state;
  }
  return { state, rejected };
}

export function MoveTimeline({ moves, cursor, onCursor, keyPlies, label }: {
  moves: ReplayMove[];
  cursor: number;
  onCursor: (n: number) => void;
  keyPlies?: number[];
  label?: string;
}) {
  const key = new Set(keyPlies ?? []);
  return (
    <div className="rv-timeline panel" data-testid="move-timeline">
      <div className="rv-timeline-head">
        <span className="panel-title">{label ?? '时间线'}</span>
        <span className="muted" data-testid="timeline-count">第 {cursor} / {moves.length} 手</span>
      </div>
      <ol className="rv-timeline-list">
        {moves.map((m, i) => (
          <li key={m.ply}>
            <button
              type="button"
              className={`rv-ply ${i + 1 === cursor ? 'current' : ''} ${key.has(m.ply) ? 'key' : ''}`}
              data-testid={`ply-${m.ply}`}
              data-key={key.has(m.ply) ? '1' : '0'}
              onClick={() => onCursor(i + 1)}
            >
              <span className={`rv-dot ${SEAT_DOT[m.seat] ?? ''}`} aria-hidden="true" />
              <span className="rv-ply-no">{m.ply}</span>
              <span className="rv-ply-rc">({m.row + 1}, {m.col + 1})</span>
              <span className="rv-ply-round">R{m.round}</span>
              {key.has(m.ply) && <span className="rv-ply-key">关键</span>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function KeyMoveList({ moves }: { moves: KeyMove[] }) {
  if (moves.length === 0) {
    return (
      <div className="rv-keys panel" data-testid="key-moves">
        <div className="panel-title">关键片段</div>
        <p className="muted" data-testid="key-moves-empty">本局没有可证明的一步关键着，因此不给解释（而不是编一个）。</p>
      </div>
    );
  }
  return (
    <div className="rv-keys panel" data-testid="key-moves">
      <div className="panel-title">关键片段 · {moves.length} 段</div>
      <ul className="rv-key-list">
        {moves.map((km) => (
          <li key={km.ply} className="rv-key" data-testid={`key-move-${km.type}`}>
            <div className="rv-key-head">
              <span className="rv-key-type">{keyMoveTitle(km.type)}</span>
              <span className="rv-key-ply">第 {km.ply} 手</span>
            </div>
            <p className="rv-key-text">{explainKeyMove(km)}</p>
            {km.points.length > 1 && (
              <p className="muted rv-key-points">
                已证明的点：{km.points.map((c) => `(${c.row + 1}, ${c.col + 1})`).join('、')}（任何一个都算对）
              </p>
            )}
            {km.defenseWindow && (
              <p className="muted rv-key-window" data-testid={`defense-window-${km.ply}`}>
                威胁窗口：第 {km.defenseWindow.openedAtPly} 手出现 → 第 {km.defenseWindow.resolvedAtPly ?? '终局未兑现'} 手被占掉，
                窗口内共 {km.defenseWindow.actions.length} 手（含三方、跨轮）。
              </p>
            )}
            <p className="rv-key-meta">{certaintyNote(km)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 手机端顺序：时间线 → 棋盘 → 操作；桌面端：棋盘 | 侧栏。 */
export function ReviewLayout({ timeline, board, aside }: { timeline: ReactNode; board: ReactNode; aside: ReactNode }) {
  return (
    <div className="rv-layout">
      <div className="rv-col-timeline">{timeline}</div>
      <div className="rv-col-board" data-testid="board-column">{board}</div>
      <aside className="rv-col-aside">{aside}</aside>
    </div>
  );
}

export function ReviewBoard({ state, showNumbers, disabled, onCellClick }: {
  state: GameState; showNumbers?: boolean; disabled?: boolean; onCellClick: (r: number, c: number) => void;
}) {
  return (
    <Board
      state={state}
      showLegal={false}
      showWinning={false}
      showNumbers={showNumbers}
      disabled={disabled}
      onCellClick={onCellClick}
    />
  );
}

export function useReplayState(boardSize: BoardSize, moves: Array<{ row: number; col: number }>) {
  return useMemo(() => buildStateFromMoves(boardSize, moves), [boardSize, moves]);
}