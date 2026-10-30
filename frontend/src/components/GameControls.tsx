import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
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
    useLocale();
    return (<div className="controls panel">
      <div className="btn-row">
        <button className="btn primary" onClick={p.onNewGame}>{tx("新游戏")}</button>
        <button className="btn" onClick={p.onUndo} disabled={!p.canUndo} title={p.aiMode ? tx("撤销 AI 的落子\uFF0C回到上一人类回合") : tx("撤销一步")}>
          {p.aiMode ? tx("\u21B6 悔棋到上一人类回合") : tx("\u21B6 悔棋")}
        </button>
        <button className="btn" onClick={p.onOpenSetup}>{tx("设置")}</button>
        <button className="btn" onClick={p.onOpenRules}>{tx("规则说明")}</button>
      </div>
      <div className="btn-row small">
        <label className="check">
          <input type="checkbox" checked={p.showLegal} onChange={(e) => p.onToggleLegal(e.target.checked)}/>{tx("显示合法落子 / 禁手")}</label>
        <label className="check">
          <input type="checkbox" checked={p.showWinning} onChange={(e) => p.onToggleWinning(e.target.checked)}/>{tx("显示胜点")}</label>
        <button className="btn ghost tiny" onClick={p.onExport} disabled={!p.hasMoves}>
          ⤓ Export JSON
        </button>
        <button className="btn ghost tiny" onClick={p.onImport}>
          ⤒ Import JSON
        </button>
      </div>
    </div>);
}
