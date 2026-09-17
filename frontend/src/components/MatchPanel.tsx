import type { GameState, Player } from '../../../shared/src/game/types';
import { PLAYERS } from '../../../shared/src/game/types';
import { currentPlayerOf, getWinningPoints } from '../../../shared/src/game/legalMoves';
import { getEligiblePlayer } from '../../../shared/src/game/eligibility';
import type { QualificationView } from '../../../shared/src/game/qualification';
import { qualificationFromState } from '../../../shared/src/game/qualification';
import { colorName, playerName } from '../playerPresentation';

export interface MatchSeat { kind: 'human'|'ai'; username?: string; stars?: number; }
export function ColorChip({player,small=false}:{player:Player|null;small?:boolean}){
 return <span className={`color-chip ${player?'stone-'+player:'stone-none'} ${small?'small':''}`} aria-label={colorName(player)}/>;
}
export function MatchPanel({state,seats,mySeat,qualification,thinking,ended=false}:{state:GameState;seats:Record<Player,MatchSeat>;mySeat?:Player;qualification?:QualificationView|null;thinking?:boolean;ended?:boolean}){
 const current=currentPlayerOf(state);
 const r=state.status!=='playing' ? state.moves.at(-1)?.round??1 : Math.floor(state.turnIndex/3)+1;
 const q=qualification&&qualification.currentRound===r?qualification:qualificationFromState({...state,turnIndex:(r-1)*3});
 const who=q.currentEligible;
 const schedule=[{round:r,player:who},...q.upcoming.slice(0,5)];
 let nextMine=r+1;if(mySeat){while(getEligiblePlayer(nextMine)!==mySeat)nextMine++;}
 return <>
   <section className="seat-strip" aria-label="落子顺序：红、绿、白">
     {PLAYERS.map(p=><div key={p} className={`compact-seat ${!ended&&p===current?'active':''} ${p===mySeat?'is-you':''}`}>
       <ColorChip player={p}/><div><strong>{playerName(p)}</strong><small>{p===mySeat?'你':seats[p].kind==='ai'?'AI '+ '★'.repeat(seats[p].stars??1):seats[p].username??'真人'}</small></div>
       {!ended&&p===current&&<span className="turn-pin" title="当前落子"/>}
     </div>)}
   </section>
   <section className="victory-track" aria-label="胜权时间线">
     <div className="track-heading"><strong>第 {r} 回合</strong><span>{ended?'对局结束':thinking?'AI 思考中':`轮到${colorName(current)}棋`}</span></div>
     <div className="right-now"><span>当前胜权</span><strong><ColorChip player={who} small/>{who?playerName(who):'无人'}</strong></div>
     <div className="round-track">{schedule.map((x,i)=><div className={`track-stop ${i===0?'now':''}`} key={x.round}>
       <ColorChip player={x.player} small/><b>{x.round}</b><span>{colorName(x.player)}</span>
     </div>)}</div>
     <div className="track-foot"><span>下一回合 · {colorName(q.upcoming[0]?.player)}{q.upcoming[0]?.player?'棋':''}</span>{mySeat&&<span>你的下次胜权：第 {nextMine} 回合</span>}</div>
   </section>
 </>;
}
export function PositionHints({state,showLegal,showWinning,onLegal,onWinning}:{state:GameState;showLegal:boolean;showWinning:boolean;onLegal:(v:boolean)=>void;onWinning:(v:boolean)=>void}){
 const current=currentPlayerOf(state),e=getEligiblePlayer(Math.floor(state.turnIndex/3)+1);
 const forbidden=e===current?0:getWinningPoints(state.board,current).length;
 return <div className="position-hints">
   <label><input type="checkbox" checked={showLegal} onChange={ev=>onLegal(ev.target.checked)}/>落点／禁手 <span>{forbidden}</span></label>
   <label><input type="checkbox" checked={showWinning} onChange={ev=>onWinning(ev.target.checked)}/>胜点</label>
   {showWinning&&<div className="winning-key">{PLAYERS.map(p=><span key={p}><ColorChip player={p} small/>{getWinningPoints(state.board,p).length}</span>)}</div>}
 </div>;
}
export function ReplayControls({active,index,total,onToggle,onIndex,onReturn,live=false}:{active:boolean;index:number;total:number;onToggle:()=>void;onIndex:(i:number)=>void;onReturn:()=>void;live?:boolean}){
 return <section className="replay-control"><button className={`btn ${active?'selected':''}`} onClick={onToggle} aria-pressed={active}>棋局日志</button>
 {active&&<div className="replay-tools"><div className="replay-status"><span>复盘 · 第 {index} / {total} 步</span>{live&&<small>在线计时继续</small>}</div><div className="replay-buttons">
 <button className="btn icon-btn" aria-label="回到开局" onClick={()=>onIndex(0)} disabled={index===0}>|‹</button>
 <button className="btn icon-btn" aria-label="上一手" onClick={()=>onIndex(index-1)} disabled={index===0}>‹</button>
 <button className="btn icon-btn" aria-label="下一手" onClick={()=>onIndex(index+1)} disabled={index>=total}>›</button>
 <button className="btn" onClick={onReturn}>返回对局</button>
 </div><input type="range" aria-label="复盘进度" min={0} max={total} value={index} onChange={e=>onIndex(Number(e.target.value))}/></div>}
 </section>;
}
