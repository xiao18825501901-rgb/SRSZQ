import { useMemo, useState } from 'react';
import type { GameState, Player } from '../../../shared/src/game/types';
import { currentPlayerIsEligible, eligibleOf, currentPlayerOf } from '../../../shared/src/game/legalMoves';
import { isLegalMove } from '../../../shared/src/game/legalMoves';
import { getWinningPoints } from '../../../shared/src/game/legalMoves';
import { CellView } from './Cell';
import type { CellVisual } from './Cell';

interface Props {
  state: GameState;
  showLegal: boolean;
  showWinning: boolean;
  onCellClick: (row: number, col: number) => void;
}

export function Board({ state, showLegal, showWinning, onCellClick }: Props) {
  const n = state.boardSize;
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ row: number; col: number; legal: boolean; forbidden: boolean; piece: Player | null } | null>(null);

  const current = currentPlayerOf(state);
  const eligible = eligibleOf(state);
  const currentEligible = currentPlayerIsEligible(state);

  const winningMap = useMemo(() => {
    if (!showWinning) return new Map<string, Player[]>();
    const map = new Map<string, Player[]>();
    for (const p of ['A', 'B', 'C'] as Player[]) {
      for (const pt of getWinningPoints(state.board, p)) {
        const key = `${pt.row},${pt.col}`;
        const arr = map.get(key) ?? [];
        arr.push(p);
        map.set(key, arr);
      }
    }
    return map;
  }, [state, showWinning]);

  const dimmed = state.status !== 'playing';
  const winSet = useMemo(() => {
    const s = new Set<string>();
    state.winLine?.forEach((p) => s.add(`${p.row},${p.col}`));
    return s;
  }, [state.winLine]);

  const cells: CellVisual[][] = useMemo(() => {
    const grid: CellVisual[][] = [];
    const lastMoveRec = [...state.moves].reverse().find((m) => !m.pass);
    for (let row = 0; row < n; row++) {
      const line: CellVisual[] = [];
      for (let col = 0; col < n; col++) {
        const piece = state.board[row][col];
        const occupied = piece !== null;
        const legal = !occupied && isLegalMove(state, row, col);
        const forbidden = !occupied && !legal;
        line.push({
          row,
          col,
          piece,
          legal,
          forbidden,
          winningFor: showWinning && !occupied ? (winningMap.get(`${row},${col}`) ?? []) : [],
          isLastMove: !!lastMoveRec && lastMoveRec.row === row && lastMoveRec.col === col,
          inWinLine: winSet.has(`${row},${col}`),
          gameDimmed: dimmed && !winSet.has(`${row},${col}`),
        });
      }
      grid.push(line);
    }
    return grid;
  }, [state, n, dimmed, winSet, winningMap, showWinning]);

  const onHover = (row: number, col: number, on: boolean) => {
    setHover(on ? { row, col } : null);
    if (on) {
      const piece = state.board[row][col];
      setHoverInfo({ row, col, piece, legal: isLegalMove(state, row, col), forbidden: piece === null && !isLegalMove(state, row, col) });
    } else {
      setHoverInfo(null);
    }
  };

  const isHover = (row: number, col: number) => hover?.row === row && hover?.col === col;

  return (
    <div className="board-wrap">
      <div className="board" style={{ '--n': n } as React.CSSProperties}>
        {/* 顶行列标 */}
        <div className="board-corner" />
        {Array.from({ length: n }, (_, c) => (
          <div key={`ct${c}`} className="col-label">
            {c + 1}
          </div>
        ))}
        {cells.map((line, row) => (
          <RowFragment key={row} row={row} cells={line} n={n} isHover={isHover} showLegal={showLegal} showWinning={showWinning} current={current} currentEligible={currentEligible} onHover={onHover} onClick={onCellClick} />
        ))}
      </div>
      <div className="hover-info" aria-live="polite">
        {hoverInfo &&
          (hoverInfo.piece ? (
            <span>
              坐标 ({hoverInfo.row + 1}, {hoverInfo.col + 1}) · 已有棋子 {hoverInfo.piece}
            </span>
          ) : hoverInfo.forbidden ? (
            <span className="text-forbidden">
              ⛔ 坐标 ({hoverInfo.row + 1}, {hoverInfo.col + 1}) 非法：你（{current}）当前没有胜权，此位置会形成四连。
              {currentEligible ? '' : ` 当前胜权：${eligible ?? '无人'}`}
            </span>
          ) : hoverInfo.legal ? (
            <span>
              坐标 ({hoverInfo.row + 1}, {hoverInfo.col + 1}) · {current} 可落子
              {currentEligible ? '（你拥有胜权：成四即胜）' : '（无胜权，不可成四）'}
            </span>
          ) : null)}
      </div>
    </div>
  );
}

function RowFragment(props: {
  row: number;
  cells: CellVisual[];
  n: number;
  isHover: (r: number, c: number) => boolean;
  showLegal: boolean;
  showWinning: boolean;
  current: Player;
  currentEligible: boolean;
  onHover: (r: number, c: number, on: boolean) => void;
  onClick: (r: number, c: number) => void;
}) {
  const { row, cells, n, isHover, showLegal, showWinning, current, currentEligible, onHover, onClick } = props;
  return (
    <>
      <div className="row-label">{row + 1}</div>
      {cells.map((cell) => (
        <CellView
          key={`${row}-${cell.col}`}
          cell={cell}
          hovered={isHover(row, cell.col)}
          showLegal={showLegal}
          showWinning={showWinning}
          currentPlayer={current}
          currentHasEligible={currentEligible}
          onHover={onHover}
          onClick={onClick}
        />
      ))}
      {row === n - 1 && <div className="board-corner" />}
    </>
  );
}
