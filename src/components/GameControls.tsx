interface Props {
  canUndo: boolean;
  hasMoves: boolean;
  showLegal: boolean;
  showWinning: boolean;
  /** 是否有 AI 座位（悔棋语义变化：撤销到上一人类回合） */
  aiMode?: boolean;
  onToggleLegal: (v: boolean) => void;
  onToggleWinning: (v: boolean) => void;
  onNewGame: () => void;
  onUndo: () => void;
  onExport: () => void;
  onImport: () => void;
  onOpenSetup: () => void;
  onOpenRules: () => void;
}

export function GameControls(p: Props) {
  return (
    <div className="controls panel">
      <div className="btn-row">
        <button className="btn primary" onClick={p.onNewGame}>
          新游戏
        </button>
        <button className="btn" onClick={p.onUndo} disabled={!p.canUndo} title={p.aiMode ? '撤销 AI 的落子，回到上一人类回合' : '撤销一步'}>
          {p.aiMode ? '↶ 悔棋到上一人类回合' : '↶ 悔棋'}
        </button>
        <button className="btn" onClick={p.onOpenSetup}>
          设置
        </button>
        <button className="btn" onClick={p.onOpenRules}>
          规则说明
        </button>
      </div>
      <div className="btn-row small">
        <label className="check">
          <input type="checkbox" checked={p.showLegal} onChange={(e) => p.onToggleLegal(e.target.checked)} />
          显示合法落子 / 禁手
        </label>
        <label className="check">
          <input type="checkbox" checked={p.showWinning} onChange={(e) => p.onToggleWinning(e.target.checked)} />
          显示胜点
        </label>
        <button className="btn ghost tiny" onClick={p.onExport} disabled={!p.hasMoves}>
          ⤓ Export JSON
        </button>
        <button className="btn ghost tiny" onClick={p.onImport}>
          ⤒ Import JSON
        </button>
      </div>
    </div>
  );
}
