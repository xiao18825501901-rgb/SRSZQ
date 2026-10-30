import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
import type { GameState, Player } from '../../../shared/src/game/types';
import { PLAYERS } from '../../../shared/src/game/types';
import { currentPlayerOf, getWinningPoints } from '../../../shared/src/game/legalMoves';
import { getEligiblePlayer } from '../../../shared/src/game/eligibility';
import type { QualificationView } from '../../../shared/src/game/qualification';
import { qualificationFromState } from '../../../shared/src/game/qualification';
import { colorName, playerName } from '../playerPresentation';
import { Btn, IconButton } from '../ui';
export interface MatchSeat {
    kind: 'human' | 'ai';
    username?: string;
    stars?: number;
}
export function ColorChip({ player, small = false }: {
    player: Player | null;
    small?: boolean;
}) {
    useLocale();
    return <span className={`color-chip ${player ? 'stone-' + player : 'stone-none'} ${small ? 'small' : ''}`} aria-label={colorName(player)}/>;
}
/**
 * 胜权时间线（Online Match 与每日一题**共用同一个组件**：规则源与视觉都只有一份）。
 * 规则来自共享资格引擎——优先服务器权威 payload，缺省回退 qualificationFromState。
 * 层级：now（当前，最重）> next（下一轮，次级）> 其余（弱化）。
 */
export function VictoryTrack({ state, mySeat, qualification, ended = false, thinking = false }: {
    state: GameState;
    mySeat?: Player;
    qualification?: QualificationView | null;
    ended?: boolean;
    thinking?: boolean;
}) {
    useLocale();
    const current = currentPlayerOf(state);
    const r = state.status !== 'playing' ? state.moves.at(-1)?.round ?? 1 : Math.floor(state.turnIndex / 3) + 1;
    const q = qualification && qualification.currentRound === r ? qualification : qualificationFromState({ ...state, turnIndex: (r - 1) * 3 });
    const who = q.currentEligible;
    const schedule = [{ round: r, player: who }, ...q.upcoming.slice(0, 5)];
    let nextMine = r + 1;
    if (mySeat) {
        while (getEligiblePlayer(nextMine) !== mySeat)
            nextMine++;
    }
    return <section className="victory-track" aria-label={tx("胜权时间线")} data-round={r} data-eligible={who ?? 'none'}>
  <div className="track-heading"><strong>{tx("第 {p0} 回合", { p0: r })}</strong><span>{ended ? tx("对局结束") : thinking ? tx("AI 思考中") : tx("轮到{p0}棋", { p0: colorName(current) })}</span></div>
  <div className="right-now"><span>{tx("当前胜权")}</span><strong><ColorChip player={who} small/>{who ? playerName(who) : tx("无人")}</strong></div>
  <div className="round-track">{schedule.map((x, i) => <div className={`track-stop ${i === 0 ? 'now' : i === 1 ? 'next' : ''}`} key={x.round}>
    <ColorChip player={x.player} small/><b>{x.round}</b><span>{colorName(x.player)}</span>
  </div>)}</div>
  <div className="track-foot"><span>{tx("下一回合 \u00B7 {p0}{p1}", { p0: colorName(q.upcoming[0]?.player), p1: q.upcoming[0]?.player ? tx("棋") : '' })}</span>{mySeat && <span>{tx("你的下次胜权\uFF1A第 {p0} 回合", { p0: nextMine })}</span>}</div>
 </section>;
}
export function MatchPanel({ state, seats, mySeat, qualification, thinking, ended = false }: {
    state: GameState;
    seats: Record<Player, MatchSeat>;
    mySeat?: Player;
    qualification?: QualificationView | null;
    thinking?: boolean;
    ended?: boolean;
}) {
    useLocale();
    const current = currentPlayerOf(state);
    // 胜权时间线已抽成 VictoryTrack（与每日一题共用）；这里只留落子顺序条。
    return <>
   <section className="seat-strip" aria-label={tx("落子顺序\uFF1A红、绿、白")}>
     {PLAYERS.map(p => <div key={p} className={`compact-seat ${!ended && p === current ? 'active' : ''} ${p === mySeat ? 'is-you' : ''}`}>
       <ColorChip player={p}/><div><strong>{playerName(p)}</strong><small>{p === mySeat ? tx("你") : seats[p].kind === 'ai' ? 'AI ' + '★'.repeat(seats[p].stars ?? 1) : seats[p].username ?? tx("真人")}</small></div>
       {!ended && p === current && <span className="turn-pin" title={tx("当前落子")}/>}
     </div>)}
   </section>
   <VictoryTrack state={state} mySeat={mySeat} qualification={qualification} ended={ended} thinking={thinking}/>
 </>;
}
export function PositionHints({ state, showLegal, showWinning, onLegal, onWinning }: {
    state: GameState;
    showLegal: boolean;
    showWinning: boolean;
    onLegal: (v: boolean) => void;
    onWinning: (v: boolean) => void;
}) {
    useLocale();
    const current = currentPlayerOf(state), e = getEligiblePlayer(Math.floor(state.turnIndex / 3) + 1);
    const forbidden = e === current ? 0 : getWinningPoints(state.board, current).length;
    return <div className="position-hints">
   <label><input type="checkbox" checked={showLegal} onChange={ev => onLegal(ev.target.checked)}/>{tx("落点\uFF0F禁手 ")}<span>{forbidden}</span></label>
   <label><input type="checkbox" checked={showWinning} onChange={ev => onWinning(ev.target.checked)}/>{tx("胜点")}</label>
   {showWinning && <div className="winning-key">{PLAYERS.map(p => <span key={p}><ColorChip player={p} small/>{getWinningPoints(state.board, p).length}</span>)}</div>}
 </div>;
}
export function ReplayControls({ active, index, total, onToggle, onIndex, onReturn, live = false }: {
    active: boolean;
    index: number;
    total: number;
    onToggle: () => void;
    onIndex: (i: number) => void;
    onReturn: () => void;
    live?: boolean;
}) {
    useLocale();
    return <section className="replay-control"><Btn type="button" icon="history" className={active ? 'selected' : ''} onClick={onToggle} aria-pressed={active}>{tx("棋局日志")}</Btn>
 {active && <div className="replay-tools"><div className="replay-status"><span>{tx("复盘 \u00B7 第 {p0} / {p1} 步", { p0: index, p1: total })}</span>{live && <small>{tx("在线计时继续")}</small>}</div><div className="replay-buttons">
 <IconButton icon="first" label={tx("回到开局")} onClick={() => onIndex(0)} disabled={index === 0}/>
 <IconButton icon="chevronLeft" label={tx("上一手")} onClick={() => onIndex(index - 1)} disabled={index === 0}/>
 <IconButton icon="chevronRight" label={tx("下一手")} onClick={() => onIndex(index + 1)} disabled={index >= total}/>
 <Btn type="button" icon="replay" onClick={onReturn}>{tx("返回对局")}</Btn>
 </div><input type="range" aria-label={tx("复盘进度")} min={0} max={total} value={index} onChange={e => onIndex(Number(e.target.value))}/></div>}
 </section>;
}
