import { useEffect, useRef } from 'react';
import type { GameState } from '../game/types';
import { PLAYER_COLORS } from '../game/types';
import { AI_LEVEL_LABELS, type AIDecision, type SeatConfigs } from '../ai/types';
import { isAISeat, seatLevel } from '../ai/seats';

interface Props {
  state: GameState;
  seats: SeatConfigs;
  /** 各记录索引对应的 AI 决策统计（深度/节点/耗时等，仅搜索类 AI 有值） */
  aiStats?: ReadonlyMap<number, AIDecision>;
  /** 调试模式：追加 depth/nodes/time/tt 等原始统计 */
  debug?: boolean;
}

/** 人类可读的一行日志 */
function describeMove(
  state: GameState,
  i: number,
  seats: SeatConfigs,
  aiStats?: ReadonlyMap<number, AIDecision>,
  debug = false,
): { text: string; cls: string; title?: string } {
  const m = state.moves[i];
  const turnNo = m.turn + 1;
  const aiTag = isAISeat(seats, m.player) ? `🤖AI·${AI_LEVEL_LABELS[seatLevel(seats, m.player)]}` : '';
  const stat = aiStats?.get(i);
  let statTag = '';
  let title: string | undefined;
  if (stat && !m.pass) {
    const parts: string[] = [];
    if (stat.depth !== undefined) parts.push(`d${stat.depth}`);
    if (stat.nodes !== undefined) parts.push(`n${stat.nodes}`);
    if (stat.thinkTimeMs !== undefined) parts.push(`${Math.round(stat.thinkTimeMs)}ms`);
    if (stat.ttHits !== undefined) parts.push(`tt${stat.ttHits}`);
    if (stat.candidates !== undefined) parts.push(`k${stat.candidates}`);
    if (stat.reason) title = stat.reason;
    if (debug && parts.length > 0) statTag = ` [${parts.join(' ')}]`;
  }
  if (m.pass) {
    return {
      text: `Turn ${turnNo} — ${m.player} ${aiTag} PASS — No Legal Move${statTag}`,
      cls: 'pass',
      title,
    };
  }
  if (state.status === 'won' && state.winner === m.player && i === state.moves.length - 1) {
    return {
      text: `R${m.round} ${m.player} ${aiTag} → (${(m.row ?? 0) + 1}, ${(m.col ?? 0) + 1})${statTag}  ${m.player} forms ≥4. ${m.player} wins!`,
      cls: 'win',
      title,
    };
  }
  return {
    text: `Turn ${turnNo} — ${m.player} ${aiTag} → (${(m.row ?? 0) + 1}, ${(m.col ?? 0) + 1})${statTag}`,
    cls: 'move',
    title,
  };
}

export function MoveHistory({ state, seats, aiStats, debug = false }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.moves.length]);

  return (
    <div className="history panel">
      <div className="panel-title">棋局日志 · Move History</div>
      <div className="history-list" ref={boxRef}>
        {state.moves.length === 0 && <div className="history-empty">尚未落子</div>}
        {state.moves.map((m, i) => {
          const { text, cls, title } = describeMove(state, i, seats, aiStats, debug);
          return (
            <div key={i} className={`history-line ${cls}`} title={title}>
              <span className="history-player" style={{ color: PLAYER_COLORS[m.player] }}>
                {m.player}
              </span>
              <span className="history-text">{text.replace(/^[A-C]\s/, '')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
