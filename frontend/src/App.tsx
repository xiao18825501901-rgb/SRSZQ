import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GameState, Player, BoardSize } from '../../shared/src/game/types';
import type { MatchPolicyContext, SeatConfigs } from '../../shared/src/ai/types';
import { allHumanSeats, countAI, isAISeat } from '../../shared/src/ai/seats';
import { replayMoves } from '../../shared/src/game/rules';
import { useGame } from './hooks/useGame';
import { useAIController } from './hooks/useAIController';
import { Board } from './components/Board';
import { MatchPanel, PositionHints, ReplayControls, type MatchSeat } from './components/MatchPanel';
import { Modal, ConfirmModal } from './components/Modal';
import { RulesQuickView } from './components/HowToPlay';
import { playerName } from './playerPresentation';
export interface CoachContext {state:GameState;round:number;current:Player;eligible:Player|null;currentIsAI:boolean;thinking:boolean;}
export interface PlatformHostProps {
 hostTitle?:string;presetSeats?:SeatConfigs;onExit?:()=>void;onGameEnd?:(winner:Player|null)=>void;
 embedded?:boolean;coach?:(ctx:CoachContext)=>ReactNode;aiPolicy?:MatchPolicyContext;initialSize?:BoardSize;
}
export default function App({hostTitle='离线模式',presetSeats,onExit,onGameEnd,coach,aiPolicy,initialSize=13}:PlatformHostProps={}){
 const game=useGame(initialSize),state=game.state;
 const [seats]=useState(presetSeats??allHumanSeats());
 const [showLegal,setShowLegal]=useState(true),[showWinning,setShowWinning]=useState(false);
 const [review,setReview]=useState(false),[cursor,setCursor]=useState(0);
 const [confirmNew,setConfirmNew]=useState(false),[settings,setSettings]=useState(false),[rules,setRules]=useState(false);
 const [pendingSize,setPendingSize]=useState<BoardSize>(initialSize);
 const [dismissEnd,setDismissEnd]=useState(false),[error,setError]=useState('');
 const ended=useRef(false);
 const ai=useAIController({state,seats,placeStone:game.placeStone,passTurn:game.passTurn,enabled:!review&&!settings&&!confirmNew,policy:aiPolicy});
 useEffect(()=>{if(state.status==='playing'){ended.current=false;setDismissEnd(false)}else if(!ended.current){ended.current=true;onGameEnd?.(state.winner)}},[state.status,state.winner,onGameEnd]);
 const view=useMemo(()=>review?replayMoves(state.boardSize,state.moves.slice(0,Math.min(cursor,state.moves.length))):state,[review,cursor,state]);
 const seatViews=useMemo(()=>Object.fromEntries((['A','B','C'] as Player[]).map(p=>[p,{kind:seats[p].kind,stars:seats[p].level}])) as Record<Player,MatchSeat>,[seats]);
 useEffect(()=>{if(!review&&!settings&&!confirmNew&&state.status==='playing'&&!game.hasLegalMove&&!isAISeat(seats,game.current))game.passTurn()},[state,review,settings,confirmNew,game.hasLegalMove,game.current,game.passTurn,seats]);
 const humanSeats=(['A','B','C'] as Player[]).filter(p=>seats[p].kind==='human');
 const mySeat=humanSeats.length===1?humanSeats[0]:undefined;
 function startNew(){ai.cancelAll();setReview(false);game.newGame(pendingSize);setConfirmNew(false);setSettings(false);setError('');}
 function undo(){ai.cancelAll();setReview(false);if(countAI(seats)){
   let i=state.moves.length-1;while(i>=0&&(state.moves[i].pass||isAISeat(seats,state.moves[i].player)))i--;
   if(i>=0)game.undoN(state.moves.length-i);
 }else game.undo();}
 function toggleReview(){ai.cancelAll();if(!review)setCursor(state.moves.length);setReview(!review);}
 return <main className="game-shell local-game" data-testid="local-game">
   <div className="game-topline"><button className="text-back" onClick={onExit}>‹ 返回</button><span>{hostTitle}</span><span>{state.boardSize} 路</span></div>
   <div className="match-layout">
     <div className="match-board-column"><Board state={view} showLegal={!review&&showLegal} showWinning={!review&&showWinning} showNumbers={review}
       disabled={review||!!ai.thinking||ai.currentIsAI||settings||confirmNew} onCellClick={(r,c)=>{if(!review&&!ai.thinking&&!ai.currentIsAI)game.placeStone(r,c)}}/>
       {review&&<div className="board-note">复盘视图 · 棋子上的数字为落子手数</div>}
     </div>
     <aside className="match-sidebar"><div className="side-title"><h1>{hostTitle}</h1>{review&&<span className="badge">复盘</span>}</div>
       <MatchPanel state={view} seats={seatViews} mySeat={mySeat} thinking={!review&&!!ai.thinking} ended={view.status!=='playing'}/>
       <PositionHints state={view} showLegal={showLegal} showWinning={showWinning} onLegal={setShowLegal} onWinning={setShowWinning}/>
       <div className="game-actions"><button className="btn primary" onClick={()=>{setPendingSize(state.boardSize);setConfirmNew(true)}}>新游戏</button><button className="btn" onClick={undo} disabled={!state.moves.length}>悔棋</button><button className="btn" onClick={()=>{setPendingSize(state.boardSize);setSettings(true)}}>设置</button></div>
       <ReplayControls active={review} index={cursor} total={state.moves.length} onToggle={toggleReview} onIndex={setCursor} onReturn={()=>setReview(false)}/>
       {coach&&<div className="coach-note">{coach({state,round:game.round,current:game.current,eligible:game.eligible,currentIsAI:ai.currentIsAI,thinking:!!ai.thinking})}</div>}
       {error&&<p role="alert">{error}</p>}
       <button className="linklike subtle" onClick={()=>setRules(true)}>胜权怎么来？</button>
     </aside>
   </div>
   <ConfirmModal open={confirmNew} title="开始新游戏？" message="当前棋局将清空，棋盘与对手设置保持不变。" onConfirm={startNew} onCancel={()=>setConfirmNew(false)}/>
   <Modal open={settings} title="棋盘设置" onClose={()=>setSettings(false)} footer={<><button className="btn" onClick={()=>setSettings(false)}>取消</button><button className="btn primary" onClick={startNew}>开始新局</button></>}>
     <div className="size-picker">{([13,17] as BoardSize[]).map(n=><button className={`btn ${pendingSize===n?'selected':''}`} key={n} onClick={()=>setPendingSize(n)}>{n} 路</button>)}</div><p className="muted">更换棋盘会开始一盘新对局。</p>
   </Modal>
   <Modal open={rules} title="胜权规则" onClose={()=>setRules(false)}><RulesQuickView/></Modal>
   <Modal open={state.status!=='playing'&&!dismissEnd&&!review} title={state.winner?`${playerName(state.winner)}获胜`:'和棋'} onClose={()=>setDismissEnd(true)} footer={<><button className="btn" onClick={()=>{setDismissEnd(true);setReview(true);setCursor(state.moves.length)}}>查看棋局</button><button className="btn primary" onClick={startNew}>再来一局</button></>}><p>{state.winner?'本次落子连成四子，对局结束。':'棋盘已满，对局结束。'}</p></Modal>
 </main>;
}
