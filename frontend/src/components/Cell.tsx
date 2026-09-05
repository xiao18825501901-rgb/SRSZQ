import type { Player } from '../../../shared/src/game/types';

export interface CellVisual {
  row: number;
  col: number;
  piece: Player | null;
  /** 当前玩家可合法落子（空格） */
  legal: boolean;
  /** 空位但对当前玩家是禁手（会形成四连且无胜权） */
  forbidden: boolean;
  /** 某玩家的胜点（下一手可成≥4），用于胜点可视化 */
  winningFor: Player[];
  isLastMove: boolean;
  inWinLine: boolean;
  gameDimmed: boolean;
}

interface Props {
  cell: CellVisual;
  hovered: boolean;
  showLegal: boolean;
  showWinning: boolean;
  currentPlayer: Player;
  currentHasEligible: boolean;
  onHover: (row: number, col: number, on: boolean) => void;
  onClick: (row: number, col: number) => void;
}

export function CellView({ cell, hovered, showLegal, showWinning, currentPlayer, currentHasEligible, onHover, onClick }: Props) {
  const { piece, legal, forbidden, winningFor, isLastMove, inWinLine, gameDimmed, row, col } = cell;

  let cls = 'cell';
  if (piece) cls += ' occupied';
  if (legal && !piece) cls += ' legal';
  if (forbidden) cls += ' forbidden';
  if (isLastMove) cls += ' last-move';
  if (inWinLine) cls += ' win-cell';
  if (gameDimmed) cls += ' dimmed';
  if (hovered && legal) cls += ' hover-legal';
  if (hovered && forbidden) cls += ' hover-forbidden';

  const clickable = legal;

  return (
    <div
      className={cls}
      data-row={row}
      data-col={col}
      role="button"
      aria-label={`(${row + 1}, ${col + 1})${piece ? ` ${piece}` : legal ? ' 可落子' : forbidden ? ' 禁手' : ''}`}
      onMouseEnter={() => onHover(row, col, true)}
      onMouseLeave={() => onHover(row, col, false)}
      onClick={() => clickable && onClick(row, col)}
    >
      {/* 网格线背景已由棋盘绘制 */}
      {piece ? (
        <span
          className={`stone stone-${piece} ${inWinLine ? 'stone-win' : ''}`}
          style={{ backgroundColor: piece === 'C' ? '#F7F7F7' : undefined }}
        >
          {piece}
        </span>
      ) : (
        <>
          {/* 合法点提示 */}
          {showLegal && legal && <span className="legal-dot" style={{ background: currentPlayer === 'C' ? '#e8e8ee' : undefined }} />}
          {/* 禁手 X 提示 */}
          {showLegal && forbidden && <span className="forbidden-x">✕</span>}
          {/* 胜点外框 */}
          {showWinning &&
            winningFor.map((p) => (
              <span key={p} className={`win-ring ring-${p}`} data-tip={`${p} 的胜点`} />
            ))}
          {/* hover 半透明预览 */}
          {hovered && legal && !currentHasEligible && (
            <span className="hover-preview" style={{ background: currentPlayer === 'C' ? '#ffffff' : undefined }} />
          )}
          {hovered && legal && currentHasEligible && (
            <span className="hover-preview" style={{ background: currentPlayer === 'C' ? '#ffffff' : undefined }} />
          )}
          {hovered && forbidden && (
            <span className="forbidden-bg" title="非法：你当前没有胜权，此位置会形成四连。" />
          )}
        </>
      )}
    </div>
  );
}
