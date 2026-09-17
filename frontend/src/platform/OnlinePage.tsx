import { useEffect, useMemo, useRef, useState } from 'react';
import { replayMoves } from '../../../shared/src/game/rules';
import { currentPlayerOf } from '../../../shared/src/game/legalMoves';
import { Board } from '../components/Board';
import { MatchPanel, PositionHints, ReplayControls, ColorChip } from '../components/MatchPanel';
import { Modal } from '../components/Modal';
import { gameLink } from '../ws';
import { colorName } from '../playerPresentation';

export function OnlinePage({user,onExit}:{user:{username:string};onExit:()=>void}){
 const [,force]=useState(0),[now,setNow]=useState(Date.now()),[confirm,setConfirm]=useState(false);
 const [review,setReview]=useState(false),[cursor,setCursor]=useState(0),[showLegal,setShowLegal]=useState(true),[showWinning,setShowWinning]=useState(false);
 const joined=useRef(false),syncAt=useRef(0);
 useEffect(()=>gameLink.subscribe(()=>force(x=>x+1)),[]);
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),200);return()=>clearInterval(id)},[]);
 useEffect(()=>{gameLink.attach();if(gameLink.phase==='idle'&&!joined.current){joined.current=true;gameLink.joinQueue()}return()=>{if(gameLink.phase==='queue')gameLink.leaveQueue()}},[]);
 const phase=gameLink.phase,g=gameLink.game;
 const remaining=Math.ceil(gameLink.remainingMs()/1000);
 useEffect(()=>{if(phase==='queue'&&remaining===0&&now-syncAt.current>3000){syncAt.current=now;gameLink.syncQueue()}},[phase,remaining,now]);
 const view=useMemo(()=>g?(review?replayMoves(g.state.boardSize,g.state.moves.slice(0,Math.min(cursor,g.state.moves.length))):g.state):null,[g,review,cursor]);
 const exit=()=>{if(phase==='queue')gameLink.leaveQueue();gameLink.reset();onExit()};
 const rematch=()=>{setReview(false);gameLink.reset();gameLink.attach();joined.current=true;gameLink.joinQueue()};
 if(phase==='queue'||phase==='idle')return <main className="matchmaking-card panel">
   <div className="search-stones" aria-label="红、绿、白三个座位"><ColorChip player="A"/><ColorChip player="B"/><ColorChip player="C"/></div>
   <h1>{remaining===0?'正在准备棋盘…':'正在寻找对手'}</h1><p>{user.username} · 当前等待 {gameLink.waiting||1} 人</p>
   <div className="matching-seconds">{remaining}<small>秒</small></div><div className="matching-progress"><span style={{width:`${Math.max(0,remaining/60*100)}%`}}/></div>
   <p className="muted">60 秒内不足 3 名真人时，将由 AI 补位自动开局。</p>
   {gameLink.error&&<p className="error-text" role="alert">{gameLink.error}</p>}
   <button className="btn" onClick={exit}>取消并返回</button>
 </main>;
 if(!g||!view)return <main className="simple-state panel"><h1>对局已结束</h1><button className="btn" onClick={exit}>返回大厅</button></main>;
 const isOnline=g.mode==='online',ended=phase==='end';
 const info=gameLink.endInfo,iWon=info?.winnerSeats.includes(g.mySeat),iLost=info?.loserSeats.includes(g.mySeat);
 const result=info?.reason==='TIMEOUT'?(iLost?'落子超时，本局判负':'对手落子超时，你获胜'):info?.status==='draw'?'本局和棋':info?.reason==='PLAYER_FORFEIT'?(iLost?'已退出，本局判负':'对手退出，你获胜'):info?.reason==='PLAYER_DISCONNECT'?(iLost?'连接中断，本局判负':'对手离线，你获胜'):iWon?'你获胜了':g.state.winner?`${colorName(g.state.winner)}棋获胜`:'对局结束';
 const myTurn=!ended&&g.state.status==='playing'&&currentPlayerOf(g.state)===g.mySeat;
 const ms=gameLink.turnRemainingMs();
 const seconds=ms===null?null:Math.ceil(ms/1000);
 const current=currentPlayerOf(g.state);
 const lostConnection=gameLink.seatStatus?.status==='disconnected'&&now-gameLink.seatStatus.ts<10000;
 return <main className="game-shell online-game" data-testid="online-game">
   <div className="match-layout">
     <div className="match-board-column"><Board state={view} showLegal={!review&&showLegal} showWinning={!review&&showWinning} showNumbers={review}
       disabled={!myTurn||review} onCellClick={(r,c)=>{if(myTurn&&!review)gameLink.move(r,c)}}/>
       {review&&<div className="board-note">复盘视图 · 在线对局仍在继续</div>}
     </div>
     <aside className="match-sidebar"><div className="side-title"><h1>{isOnline?'在线匹配':'好友对弈'}</h1><span>{g.state.boardSize} 路</span></div>
       <MatchPanel state={view} qualification={review?null:g.qualification} seats={g.seats} mySeat={g.mySeat} ended={ended} thinking={!ended&&g.seats[current].kind==='ai'}/>
       <PositionHints state={view} showLegal={showLegal} showWinning={showWinning} onLegal={setShowLegal} onWinning={setShowWinning}/>
       {lostConnection&&!ended&&<div className="notice">对手正在重连…</div>}
       {ended?<section className="result-card" role="status"><h2>{result}</h2><div className="game-actions">{isOnline&&<button className="btn primary" onClick={rematch}>再来一局</button>}<button className="btn" onClick={exit}>返回大厅</button></div></section>:
       <div className="online-controls"><button className="btn danger" onClick={()=>setConfirm(true)}>退出对局</button>{isOnline&&<div className={`turn-clock ${seconds!==null&&seconds<=10?'urgent':''}`} role="timer" aria-label="落子倒计时"><span>{seconds===null?'对手思考':'落子剩余'}</span><b>{seconds===null?'—':seconds}<small>{seconds===null?'':'秒'}</small></b></div>}</div>}
       <ReplayControls active={review} index={cursor} total={g.state.moves.length} onToggle={()=>{if(!review)setCursor(g.state.moves.length);setReview(!review)}} onIndex={setCursor} onReturn={()=>setReview(false)} live={isOnline&&!ended}/>
       {gameLink.error&&<p className="error-text" role="alert">{gameLink.error}</p>}
     </aside>
   </div>
   <Modal open={confirm} title="退出对局？" onClose={()=>setConfirm(false)} footer={<><button className="btn" onClick={()=>setConfirm(false)}>继续对局</button><button className="btn danger" onClick={()=>{setConfirm(false);if(isOnline)gameLink.resign();else{gameLink.leaveInvite();exit()}}}>确认退出</button></>}>
     <p>{isOnline?'主动退出将判负并结束本局。':'退出将结束这盘好友对弈，不影响积分。'}</p>
   </Modal>
 </main>;
}
