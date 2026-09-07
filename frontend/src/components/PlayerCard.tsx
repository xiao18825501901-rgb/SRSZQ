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
  const isAI = seat?.kind === 'ai';
  const level = seat?.kind === 'ai' ? seat.level ?? 1 : null;
  return (
    <div className={`player-card player-${player.toLowerCase()} ${isCurrent ? 'current' : ''} ${hasEligible ? 'eligible' : ''} ${isAI ? 'ai-seat' : ''}`}>
      <div className="player-head">
        <span className="player-badge">
          {player}
        </span>
        <div className="player-name">
          <strong>玩家 {player}</strong>
          <span className={`player-sub ${isAI ? 'ai-tag' : 'human-tag'} ${thinking ? 'thinking' : ''}`}>
            {isAI ? (
              <>
                {thinking ? 'AI THINKING…' : 'AI'} · {level ? AI_LEVEL_STARS[level] : ''}
              </>
            ) : (
              <>HUMAN · 人类</>
            )}
          </span>
        </div>
        {hasEligible && !gameOver && <span className="win-right">VICTORY RIGHT</span>}
      </div>
      <div className="player-stats">
        <span>棋子：{stoneCount}</span>
        <span>当前胜权：{hasEligible ? '是' : '否'}</span>
        <span>禁手点：{forbiddenCount}</span>
        {winningPointCount > 0 && <span>胜点：{winningPointCount}</span>}
      </div>
      <div className="player-sub muted">
        {PLAYER_COLOR_NAMES[player]}
        {isAI && !thinking && ' · AI 自动行动，点击棋盘无效'}
        {!isAI && isCurrent && !gameOver && !thinking && ' · 轮到你落子'}
      </div>
    </div>
  );
}
