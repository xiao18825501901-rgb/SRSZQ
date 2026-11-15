import { errorText } from "../i18n/core";
import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
import { useEffect, useMemo, useRef, useState } from 'react';
import { replayMoves } from '../../../shared/src/game/rules';
import { currentPlayerOf } from '../../../shared/src/game/legalMoves';
import { Board } from '../components/Board';
import { MatchPanel, PositionHints, ReplayControls, ColorChip } from '../components/MatchPanel';
import { Modal } from '../components/Modal';
import { gameLink } from '../ws';
import { colorName, playerName } from '../playerPresentation';
import { ratingNoticeOf } from './ratingNotice';
import { Btn } from '../ui';
import { SharedMatchLayout } from '../matchChat/SharedMatchLayout';
import { ChatCard } from '../matchChat/ChatCard';
import { websiteTransport } from '../matchChat/websiteTransport';
import type { ChatPlayer } from '../matchChat/catalog';
import { api } from '../api';

export function OnlinePage({user,onExit}:{user:{username:string};onExit:()=>void}){
 useLocale();

 const [,force]=useState(0),[now,setNow]=useState(Date.now()),[confirm,setConfirm]=useState(false);
 const [review,setReview]=useState(false),[cursor,setCursor]=useState(0),[showLegal,setShowLegal]=useState(true),[showWinning,setShowWinning]=useState(false);
 const [banterEnabled,setBanterEnabled]=useState(true);
 const transport=useRef(websiteTransport()).current;
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
 if(phase==='queue'||phase==='idle'){
   // 只有**真的在队列里**才显示倒计时与进度。
   // 现场（真实浏览器）抓到：被“另一个标签页替换”后 phase 变成 idle，旧写法仍然渲染
   // 倒计时并写着“正在寻找对手”，用户会一直等一个永远不会来的对局。
   const queued=phase==='queue',lostQueue=!queued&&(joined.current||!!gameLink.error);
   return <main className="matchmaking-card panel">
   <div className="search-stones" aria-label={tx("红、绿、白三个座位")}><ColorChip player="A"/><ColorChip player="B"/><ColorChip player="C"/></div>
   <h1>{queued?(remaining===0?tx("正在准备棋盘…"):tx("正在寻找对手")):(lostQueue?tx("连接已断开"):tx("正在连接服务器…"))}</h1>
   <p>{user.username}{queued?tx(" · 当前等待 {p0} 人", {p0: gameLink.waiting||1}):''}</p>
   {queued&&<><div className="matching-seconds">{remaining}<small>{tx("秒")}</small></div><div className="matching-progress"><span style={{width:`${Math.max(0,remaining/(gameLink.timeoutMs/1000)*100)}%`}}/></div>
   <p className="muted">{tx("20 秒内不足 3 名真人时，将由 AI 补位自动开局。")}</p></>}
   {gameLink.error&&<p className="error-text" role="alert">{errorText(gameLink.error)}</p>}
   <Btn icon="close" onClick={exit}>{tx("取消并返回")}</Btn>
 </main>;}
 if(!g||!view)return <main className="simple-state panel"><h1>{tx("对局已结束")}</h1><Btn icon="arrowLeft" onClick={exit}>{tx("返回大厅")}</Btn></main>;
 const isOnline=g.mode==='online',ended=phase==='end';
 const info=gameLink.endInfo,myOutcome=info?.myOutcome??null,iWon=myOutcome==='WIN',iLost=myOutcome==='LOSS',wonByColor=info?.winnerSeat??g.state.winner;
 const result=myOutcome==='VOID'?tx("本局对你不计胜负")
  :(info?.reason==='BOARD_DRAW'||info?.status==='draw'||myOutcome==='DRAW')?tx("本局和棋（双方均不计负）")
  :iWon?tx("你获胜了")
  :info?.reason==='TIMEOUT'?(iLost?tx("落子超时，本局判负"):tx("对手落子超时，你获胜"))
  :info?.reason==='PLAYER_FORFEIT'?(iLost?tx("已退出，本局判负"):tx("对手退出，你获胜"))
  :info?.reason==='PLAYER_DISCONNECT'?(iLost?tx("连接中断，本局判负"):tx("对手离线，你获胜"))
  :iLost?(wonByColor?tx("{p0}棋获胜", {p0: colorName(wonByColor)}):tx("AI 获胜"))
  :(wonByColor?tx("{p0}棋获胜", {p0: colorName(wonByColor)}):tx("对局结束"));
 const myTurn=!ended&&g.state.status==='playing'&&currentPlayerOf(g.state)===g.mySeat;
 const ms=gameLink.turnRemainingMs();
 const seconds=ms===null?null:Math.ceil(ms/1000);
 const current=currentPlayerOf(g.state);
 const lostConnection=gameLink.seatStatus?.status==='disconnected'&&now-gameLink.seatStatus.ts<10000;
 // 开局前就告诉玩家这一局计不计分（规格 4.2：不许赛后静默改政策）。
 const ratingNotice=ratingNoticeOf(g.rating);
 const chatPlayers = (['A', 'B', 'C'] as const).reduce((acc, p) => {
   const seat = g.seats[p];
   const player: ChatPlayer = {
     name: seat.kind === 'human' ? (seat.username ?? playerName(p)) : (seat.stars === 5 ? 'Sol' : seat.stars === 4 ? 'Terra' : `AI ${seat.stars ?? ''}`),
     kind: seat.kind,
   };
   return { ...acc, [p]: player };
 }, {} as Record<'A' | 'B' | 'C', ChatPlayer>);
 const matchModel = {
   roomId: g.gameId,
   mode: isOnline ? 'online' as const : 'invite' as const,
   round: Math.floor(g.state.turnIndex / 3) + 1,
   turn: current,
   boardSize: g.state.boardSize,
   mySeat: g.mySeat,
   environment: 'website' as const,
   ended,
   players: chatPlayers,
 };
 return <SharedMatchLayout
   model={matchModel}
   timeline={<MatchPanel state={view} qualification={review ? null : g.qualification} seats={g.seats} mySeat={g.mySeat} ended={ended} thinking={!ended && g.seats[current].kind === 'ai'}/>}
   board={<>
     <Board state={view} showLegal={!review && showLegal} showWinning={!review && showWinning} showNumbers={review} disabled={!myTurn || review} onCellClick={(r, c) => { if (myTurn && !review)
       gameLink.move(r, c); }}/>
     {review && <div className="board-note">{tx("复盘视图 \u00B7 在线对局仍在继续")}</div>}
   </>}
   chat={<ChatCard
     model={matchModel}
     messages={gameLink.chatMessages}
     transport={transport}
     banterEnabled={banterEnabled}
     onBanterChange={setBanterEnabled}
     onReport={async (messageId) => { await api('POST', `/api/match-chat/${encodeURIComponent(g.gameId)}/reports`, { messageId, reason: 'inappropriate' }); }}
   />}
   toolbar={<>
       <PositionHints state={view} showLegal={showLegal} showWinning={showWinning} onLegal={setShowLegal} onWinning={setShowWinning}/>
       {lostConnection&&!ended&&<div className="notice">{tx("对手正在重连…")}</div>}
       {!ended&&ratingNotice&&<div className="notice" data-testid="rating-notice">{ratingNotice}</div>}
       {ended?<section className="result-card" role="status"><h2>{result}</h2><div className="game-actions">{isOnline&&<Btn variant="primary" icon="replay" onClick={rematch}>{tx("再来一局")}</Btn>}<Btn icon="arrowLeft" onClick={exit}>{tx("返回大厅")}</Btn></div></section>:
       <div className="online-controls"><Btn variant="danger" icon="exit" onClick={()=>setConfirm(true)}>{tx("退出对局")}</Btn>{isOnline&&<div className={`turn-clock ${seconds!==null&&seconds<=10?'urgent':''}`} role="timer" aria-label={tx("落子倒计时")}><span>{seconds===null?tx("对手思考"):tx("落子剩余")}</span><b>{seconds===null?'—':seconds}<small>{seconds===null?'':tx("秒")}</small></b></div>}</div>}
       <ReplayControls active={review} index={cursor} total={g.state.moves.length} onToggle={()=>{if(!review)setCursor(g.state.moves.length);setReview(!review)}} onIndex={setCursor} onReturn={()=>setReview(false)} live={isOnline&&!ended}/>
       {gameLink.error&&<p className="error-text" role="alert">{errorText(gameLink.error)}</p>}
   </>}
   overlays={<>
   <Modal open={confirm} title={tx("退出对局？")} onClose={()=>setConfirm(false)} footer={<><Btn data-dialog-cancel onClick={()=>setConfirm(false)}>{tx("继续对局")}</Btn><Btn variant="danger" icon="exit" onClick={()=>{setConfirm(false);if(isOnline)gameLink.resign();else{gameLink.leaveInvite();exit()}}}>{tx("确认退出")}</Btn></>}>
     <p>{isOnline?tx("主动退出将判负并结束本局。"):tx("退出将结束这盘好友对弈，不影响积分。")}</p>
   </Modal>
   </>}
 />;
}
