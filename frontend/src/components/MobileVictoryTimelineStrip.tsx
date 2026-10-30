import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
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
const rightLabel = (player: Player | null): string => player ?? tx("无");
export function MobileVictoryTimelineStrip({ qualification, state, mySeat, seats }: Props) {
    useLocale();
    const view = useMemo(() => resolveView(qualification, state), [qualification, state]);
    if (!view)
        return null;
    const rows = rowsFromView(view).slice(0, 6);
    const next = view.upcoming[0] ?? null;
    const mine = nextVictoryFor(view, mySeat);
    const turn = currentPlayerOf(state);
    return (<section className="mobile-victory-strip" aria-label="Mobile Victory Timeline" data-testid="mobile-victory-timeline">
      <header className="mvt-head">
        <strong>R{view.currentRound} · TURN {turn}</strong>
        <span>{tx("当前胜权 ")}<b className={`mvt-right ${view.currentEligible?.toLowerCase() ?? 'none'}`}>{rightLabel(view.currentEligible)}</b>
        </span>
      </header>

      <div className="mvt-track" role="list" aria-label={tx("当前及未来胜权轮次")}>
        {rows.map((row) => (<div key={row.round} role="listitem" className={`mvt-node ${row.isNow ? 'current' : ''} ${row.isNext ? 'next' : ''} right-${row.player?.toLowerCase() ?? 'none'}`} aria-current={row.isNow ? 'step' : undefined}>
            <span className="mvt-dot" aria-hidden="true"/>
            <span className="mvt-round">R{row.round}</span>
            <b>{rightLabel(row.player)}</b>
          </div>))}
      </div>

      <footer className="mvt-foot">
        <span>NEXT · {next ? `R${next.round} ${rightLabel(next.player)}` : '—'}</span>
        <strong>
          {mine?.round === view.currentRound
            ? tx("你({p0})现在拥有胜权", { p0: mySeat }) : mine
            ? tx("你({p0})下一次胜权\uFF1AR{p1}", { p0: mySeat, p1: mine.round }) : tx("你({p0})的下一次胜权尚未进入窗口", { p0: mySeat })}
        </strong>
        <span className="sr-only">{tx("座位信息\uFF1A{p0}", { p0: (['A', 'B', 'C'] as Player[]).map((seat) => `${seat} ${seats[seat].kind}`).join('，') })}</span>
      </footer>
    </section>);
}
