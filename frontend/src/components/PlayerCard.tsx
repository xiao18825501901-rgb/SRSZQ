import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
import type { Player } from '../../../shared/src/game/types';
import { AI_LEVEL_STARS, type SeatConfig } from '../../../shared/src/ai/types';
import { PLAYER_COLOR_NAMES } from '../playerPresentation';
interface Props {
    player: Player;
    stoneCount: number;
    isCurrent: boolean;
    hasEligible: boolean;
    forbiddenCount: number;
    winningPointCount: number;
    gameOver: boolean;
    seat?: SeatConfig;
    thinking?: boolean;
}
export function PlayerCard({ player, stoneCount, isCurrent, hasEligible, forbiddenCount, winningPointCount, gameOver, seat, thinking }: Props) {
    useLocale();
    const isAI = seat?.kind === 'ai';
    const level = seat?.kind === 'ai' ? seat.level ?? 1 : null;
    return (<div className={`player-card player-${player.toLowerCase()} ${isCurrent ? 'current' : ''} ${hasEligible ? 'eligible' : ''} ${isAI ? 'ai-seat' : ''}`}>
      <div className="player-head">
        <span className="player-badge">
          {player}
        </span>
        <div className="player-name">
          <strong>{tx("玩家 {p0}", { p0: player })}</strong>
          <span className={`player-sub ${isAI ? 'ai-tag' : 'human-tag'} ${thinking ? 'thinking' : ''}`}>
            {isAI ? (<>
                {thinking ? 'AI THINKING…' : 'AI'} · {level ? AI_LEVEL_STARS[level] : ''}
              </>) : (<>{tx("HUMAN \u00B7 人类")}</>)}
          </span>
        </div>
        {hasEligible && !gameOver && <span className="win-right">VICTORY RIGHT</span>}
      </div>
      <div className="player-stats">
        <span>{tx("棋子\uFF1A{p0}", { p0: stoneCount })}</span>
        <span>{tx("当前胜权\uFF1A{p0}", { p0: hasEligible ? tx("是") : tx("否") })}</span>
        <span>{tx("禁手点\uFF1A{p0}", { p0: forbiddenCount })}</span>
        {winningPointCount > 0 && <span>{tx("胜点\uFF1A{p0}", { p0: winningPointCount })}</span>}
      </div>
      <div className="player-sub muted">
        {PLAYER_COLOR_NAMES[player]}
        {isAI && !thinking && tx(" \u00B7 AI 自动行动\uFF0C点击棋盘无效")}
        {!isAI && isCurrent && !gameOver && !thinking && tx(" \u00B7 轮到你落子")}
      </div>
    </div>);
}
