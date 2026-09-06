import { useMemo } from 'react';
import type { BoardSize, Player } from '../../../shared/src/game/types';
import { BOARD_SIZES, BOARD_SIZE_LABELS } from '../../../shared/src/game/types';
import { currentRoundOf, currentPlayerOf, eligibleOf } from '../../../shared/src/game/legalMoves';
import { getLegalMoves, getWinningPoints, isBoardFull, getForbiddenCells } from '../../../shared/src/game/legalMoves';
import type { GameState } from '../../../shared/src/game/types';

interface Props {
  state: GameState;
}

function emptyCount(state: GameState): number {
  let n = 0;
  for (const row of state.board) for (const c of row) if (c === null) n++;
  return n;
}

/** 折叠调试面板：展示引擎内部状态，对规则研究非常重要 */
export function DebugPanel({ state }: Props) {
  const legalFor = useMemo(
    () =>
      (['A', 'B', 'C'] as Player[]).map((p) => {
        // 该玩家视角的合法落子（假设轮到它）：复制状态切换 turnIndex 到该玩家
        const s: GameState = { ...state, turnIndex: ['A', 'B', 'C'].indexOf(p) === 0 ? 0 : ['A', 'B', 'C'].indexOf(p) };
        return { p, n: getLegalMoves(s).length };
      }),
    [state],
  );
  const winPts = useMemo(
    () => (['A', 'B', 'C'] as Player[]).map((p) => ({ p, n: getWinningPoints(state.board, p).length })),
    [state],
  );
  const current = currentPlayerOf(state);
  const curForbidden = useMemo(() => getForbiddenCells(state).length, [state]);

  return (
    <details className="debug panel">
      <summary className="panel-title">🔬 Debug / Analysis 分析面板</summary>
      <div className="debug-grid">
        <div>
          <div>turnIndex: <b>{state.turnIndex}</b></div>
          <div>round: <b>{currentRoundOf(state)}</b></div>
          <div>currentPlayer: <b>{current}</b></div>
          <div>eligiblePlayer: <b>{eligibleOf(state) ?? 'NONE'}</b></div>
          <div>emptyCells: <b>{emptyCount(state)}</b></div>
          <div>boardFull: <b>{String(isBoardFull(state.board))}</b></div>
          <div>status: <b>{state.status}</b></div>
          <div>winner: <b>{state.winner ?? '无'}</b></div>
        </div>
        <div>
          <div>legalMoves(A): <b>{legalFor.find((x) => x.p === 'A')!.n}</b></div>
          <div>legalMoves(B): <b>{legalFor.find((x) => x.p === 'B')!.n}</b></div>
          <div>legalMoves(C): <b>{legalFor.find((x) => x.p === 'C')!.n}</b></div>
          <div>winningPoints(A): <b>{winPts.find((x) => x.p === 'A')!.n}</b></div>
          <div>winningPoints(B): <b>{winPts.find((x) => x.p === 'B')!.n}</b></div>
          <div>winningPoints(C): <b>{winPts.find((x) => x.p === 'C')!.n}</b></div>
          <div>forbiddenMoves({current}): <b>{curForbidden}</b></div>
        </div>
      </div>
      <div className="muted">
        boardSize={state.boardSize} moves={state.moves.length}
      </div>
    </details>
  );
}

export function SetupOptions(props: {
  size: BoardSize;
  onSize: (s: BoardSize) => void;
  disabled?: boolean;
}) {
  return (
    <div className="setup-options">
      <div className="setup-block">
        <div className="setup-label">BOARD · 棋盘尺寸</div>
        <div className="btn-group">
          {BOARD_SIZES.map((s) => (
            <button key={s} className={`btn ${props.size === s ? 'primary' : ''}`} disabled={props.disabled} onClick={() => props.onSize(s)}>
              {BOARD_SIZE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
