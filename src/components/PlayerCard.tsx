import type { Player } from '../game/types';
import { PLAYER_COLORS, PLAYER_LABELS } from '../game/types';
import { AI_LEVEL_STARS, type SeatConfig } from '../ai/types';

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
  const level = seat?.kind === 'ai' ? seat.level ?? 'random' : null;
  return (
    <div className={`player-card ${isCurrent ? 'current' : ''} ${hasEligible ? 'eligible' : ''} ${isAI ? 'ai-seat' : ''}`}>
      <div className="player-head">
        <span className="player-badge" style={{ backgroundColor: player === 'C' ? '#F7F7F7' : PLAYER_COLORS[player], color: player === 'C' ? '#333' : '#fff' }}>
          {player}
        </span>
        <div className="player-name">
          <strong>玩家 {player}</strong>
          <span className={`player-sub ${isAI ? 'ai-tag' : 'human-tag'} ${thinking ? 'thinking' : ''}`}>
            {isAI ? (
              <>
                {thinking ? '🤔 THINKING…' : '🤖 AI'} · {level ? AI_LEVEL_STARS[level] : ''}
              </>
            ) : (
              <>HUMAN · 人类</>
            )}
          </span>
        </div>
        {hasEligible && !gameOver && <span className="win-right">🏆 WIN RIGHT</span>}
      </div>
      <div className="player-stats">
        <span>棋子：{stoneCount}</span>
        <span>当前胜权：{hasEligible ? '是' : '否'}</span>
        <span>禁手点：{forbiddenCount}</span>
        {winningPointCount > 0 && <span>胜点：{winningPointCount}</span>}
      </div>
      <div className="player-sub muted">
        {PLAYER_LABELS[player]}
        {isAI && !thinking && ' · AI 自动行动，点击棋盘无效'}
        {!isAI && isCurrent && !gameOver && !thinking && ' · 轮到你落子'}
      </div>
    </div>
  );
}
