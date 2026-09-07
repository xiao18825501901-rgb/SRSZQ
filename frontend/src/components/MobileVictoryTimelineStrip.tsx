import { useMemo } from 'react';
import type { GameState, Player } from '../../../shared/src/game/types';
import type { QualificationView } from '../../../shared/src/game/qualification';
import { currentPlayerOf } from '../../../shared/src/game/legalMoves';
import { nextVictoryFor, resolveView, rowsFromView, type SeatLite } from './bacTimelineModel';

interface Props {
  qualification?: QualificationView | null;
  state: GameState;
  mySeat: Player;
  seats: Record<Player, SeatLite>;
}

const rightLabel = (player: Player | null): string => player ?? '无';

export function MobileVictoryTimelineStrip({ qualification, state, mySeat, seats }: Props) {
  const view = useMemo(() => resolveView(qualification, state), [qualification, state]);
  if (!view) return null;

  const rows = rowsFromView(view).slice(0, 6);
  const next = view.upcoming[0] ?? null;
  const mine = nextVictoryFor(view, mySeat);
  const turn = currentPlayerOf(state);

  return (
    <section className="mobile-victory-strip" aria-label="Mobile Victory Timeline" data-testid="mobile-victory-timeline">
      <header className="mvt-head">
        <strong>R{view.currentRound} · TURN {turn}</strong>
        <span>
          当前胜权 <b className={`mvt-right ${view.currentEligible?.toLowerCase() ?? 'none'}`}>{rightLabel(view.currentEligible)}</b>
        </span>
      </header>

      <div className="mvt-track" role="list" aria-label="当前及未来胜权轮次">
        {rows.map((row) => (
          <div
            key={row.round}
            role="listitem"
            className={`mvt-node ${row.isNow ? 'current' : ''} ${row.isNext ? 'next' : ''} right-${row.player?.toLowerCase() ?? 'none'}`}
            aria-current={row.isNow ? 'step' : undefined}
          >
            <span className="mvt-dot" aria-hidden="true" />
            <span className="mvt-round">R{row.round}</span>
            <b>{rightLabel(row.player)}</b>
          </div>
        ))}
      </div>

      <footer className="mvt-foot">
        <span>NEXT · {next ? `R${next.round} ${rightLabel(next.player)}` : '—'}</span>
        <strong>
          {mine?.round === view.currentRound
            ? `你(${mySeat})现在拥有胜权`
            : mine
              ? `你(${mySeat})下一次胜权：R${mine.round}`
              : `你(${mySeat})的下一次胜权尚未进入窗口`}
        </strong>
        <span className="sr-only">座位信息：{(['A', 'B', 'C'] as Player[]).map((seat) => `${seat} ${seats[seat].kind}`).join('，')}</span>
      </footer>
    </section>
  );
}
