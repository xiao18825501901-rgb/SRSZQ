/** Incremental product shell; uses the existing auth, WebSocket, tutorial and AI services. */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { BoardSize } from '../../../shared/src/game/types';
import { PLAYERS } from '../../../shared/src/game/types';
import type { AILevel, SeatConfigs, MatchPolicyContext } from '../../../shared/src/ai/types';
import { countAI, countHuman } from '../../../shared/src/ai/seats';
import { createTutorialAssignment, humanSeatOf } from './tutorialModel';
import { authApi, clearAuth, getCachedUser, getToken, setAuth, type PublicUser } from '../api';
import { gameLink, resetSocket } from '../ws';
import { useRoute } from '../router';
import App from '../App';
import { Board } from '../components/Board';
import { HowToPlayContent, RulesQuickView } from '../components/HowToPlay';
import { ColorChip } from '../components/MatchPanel';
import { ModeArtwork } from '../components/ModeArtwork';
import { OnlinePage } from './OnlinePage';
import { HERO_GAME } from '../data/heroGame';
import { colorName, playerName } from '../playerPresentation';

export const STAR_LEVELS: AILevel[]=[1,2,3,4,5];
export function useSession(){
 const [user,setUser]=useState<PublicUser|null>(()=>getCachedUser());
 const applyAuth=useCallback((token:string,u:PublicUser)=>{setAuth(token,u);setUser(u)},[]);
 const refresh=useCallback(async()=>{if(!getToken())return;try{const {data}=await authApi.me();applyAuth(getToken()??'',data.user)}catch{}},[applyAuth]);
 return {user,applyAuth,refresh,clear:()=>setUser(null)};
}
export function Platform(){
 const route=useRoute(),{user,applyAuth,refresh,clear}=useSession();
 const [busy,setBusy]=useState(false),[err,setErr]=useState(''),[,render]=useState(0);
 useEffect(()=>{void refresh()},[refresh]);
 useEffect(()=>gameLink.subscribe(()=>render(x=>x+1)),[]);
 useEffect(()=>{if(!user)return;gameLink.attach();const off=gameLink.subscribe(()=>{
   if(gameLink.phase==='game'&&gameLink.game&&route.path!=='/online')route.navigate('/online');
 });return off;},[user?.id,route.path]);
 const auth=async(mode:'login'|'register',email:string,name:string,pwd:string)=>{setBusy(true);setErr('');try{
  const {data}=mode==='register'?await authApi.register(email,name,pwd):await authApi.login(name||email,pwd);
  applyAuth(data.token,data.user);route.navigate(data.user.tutorialCompleted?'/lobby':'/tutorial');
 }catch(e){setErr(e instanceof Error?e.message:String(e))}finally{setBusy(false)}};
 const logout=async()=>{try{await authApi.logout()}catch{}clearAuth();resetSocket();clear();route.navigate('/')};
 const nav=<header className="site-nav"><button className="brand" onClick={()=>route.navigate(user?'/lobby':'/')}>三人四子棋</button><nav aria-label="网站导航">
  {user&&<button className={route.path==='/lobby'?'nav-active':''} onClick={()=>route.navigate('/lobby')}>大厅</button>}
  <button className={route.path==='/rules'?'nav-active':''} onClick={()=>route.navigate('/rules')}>怎么玩</button>
  <button className={route.path==='/ranking'?'nav-active':''} onClick={()=>route.navigate('/ranking')}>排行榜</button>
  {user?<><button className={route.path==='/friends'?'nav-active':''} onClick={()=>route.navigate('/friends')}>好友</button><span className="nav-rating" aria-label={`积分 ${user.rating}`}>{user.rating}<small>分</small></span><button className="nav-auth" onClick={logout}>退出</button></>:<button className="nav-auth" onClick={()=>route.navigate('/auth')}>登录 / 注册</button>}
 </nav></header>;
 const wrap=(child:ReactNode,noNav=false)=><div className={`site-page ${noNav?'immersive':''}`}>{!noNav&&nav}{child}</div>;
 const {path}=route;
 if(path==='/auth')return wrap(<AuthCard busy={busy} err={err} onAuth={auth}/>);
 if(path==='/rules')return wrap(<HowToPlayContent onBack={()=>route.navigate(user?'/lobby':'/')} onStartTutorial={user&&!user.tutorialCompleted?()=>route.navigate('/tutorial'):undefined}/>);
 if(path==='/ranking')return wrap(<RankingPage onBack={()=>route.navigate(user?'/lobby':'/')}/>);
 if(path==='/friends')return user?wrap(<FriendsPage/>):<RedirectTo to="/auth"/>;
 if(path==='/lobby')return !user?<RedirectTo to="/auth"/>:!user.tutorialCompleted?<RedirectTo to="/tutorial"/>:wrap(<Lobby/>);
 if(path==='/tutorial')return user?wrap(<TutorialPage user={user} applyAuth={applyAuth} onDone={()=>route.navigate('/lobby')}/>):<RedirectTo to="/auth"/>;
 if(path==='/online'){
  if(!user)return <RedirectTo to="/auth"/>;
  if(!user.tutorialCompleted&&gameLink.phase!=='game'&&gameLink.phase!=='end')return <RedirectTo to="/tutorial"/>;
  return wrap(<OnlinePage user={user} onExit={()=>route.navigate('/lobby')}/>,gameLink.game?.mode==='online'&&(gameLink.phase==='game'||gameLink.phase==='end'));
 }
 if(path==='/local'||path==='/vsai'||path==='/tutgame')return wrap(<LocalHost mode={path==='/local'?'local':'vsai'} user={user} onExit={()=>route.navigate(user?'/lobby':'/')}/>);
 return wrap(<Landing/>);
}
export default Platform;
function RedirectTo({to}:{to:string}){useEffect(()=>{window.location.hash='#'+to},[to]);return <div className="loading-page">正在打开…</div>}
function Landing(){
 const route=useRoute();
 return <main className="welcome-layout">
  <section className="welcome-copy"><h1>三人四子棋</h1>
   <div className="welcome-columns"><div className="welcome-actions">
    <button className="btn primary" onClick={()=>route.navigate('/auth')}>注册并开始 <span>↗</span></button>
    <button className="btn" onClick={()=>route.navigate('/local')}>本地对局 <span>↗</span></button>
    <button className="btn" onClick={()=>route.navigate('/ranking')}>排行榜 <span>↗</span></button>
   </div><ol className="welcome-rules">
    <li><span>01</span><p>最先连成四颗子的玩家赢得游戏</p></li>
    <li><span>02</span><p>三人轮流下完一子为一回合</p></li>
    <li><span>03</span><p>每回合只有一个玩家拥有连成四颗子的资格，称为胜权</p></li>
   </ol></div>
   <p className="welcome-more">胜权怎么来的？前往 <button className="linklike" onClick={()=>route.navigate('/rules')}>怎么玩</button> 查看详细规则。</p>
  </section>
  <figure className="welcome-board"><Board state={HERO_GAME} disabled decorative showLegal={false} showWinning={false} onCellClick={()=>{}}/></figure>
 </main>;
}
function AuthCard({busy,err,onAuth}:{busy:boolean;err:string;onAuth:(m:'login'|'register',e:string,n:string,p:string)=>void}){
 const [mode,setMode]=useState<'login'|'register'>('register'),[email,setEmail]=useState(''),[name,setName]=useState(''),[pwd,setPwd]=useState('');
 return <main className="auth-layout"><div className="auth-ornament"><ColorChip player="A"/><ColorChip player="B"/><ColorChip player="C"/></div><section className="auth-card panel"><h1>{mode==='register'?'初次见面，来下一盘':'欢迎回到棋盘'}</h1>
 <div className="tabs"><button className={mode==='register'?'active':''} onClick={()=>setMode('register')}>注册</button><button className={mode==='login'?'active':''} onClick={()=>setMode('login')}>登录</button></div>
 <form onSubmit={e=>{e.preventDefault();onAuth(mode,email,name,pwd)}}>
 {mode==='register'&&<label className="field"><span>邮箱</span><input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"/></label>}
 <label className="field"><span>{mode==='register'?'用户名':'用户名或邮箱'}</span><input required value={name} onChange={e=>setName(e.target.value)} autoComplete="username" placeholder="你的名字"/></label>
 <label className="field"><span>密码</span><input type="password" minLength={6} required value={pwd} onChange={e=>setPwd(e.target.value)} autoComplete={mode==='register'?'new-password':'current-password'} placeholder="至少 6 位"/></label>
 {err&&<p className="error-text" role="alert">{err}</p>}
 <button className="btn primary wide" disabled={busy}>{busy?'处理中…':mode==='register'?'注册并开始':'登录'}</button>
 </form></section></main>;
}
const MODES=[{key:'online',title:'在线匹配'},{key:'vsai',title:'人机对战'},{key:'local',title:'离线模式'},{key:'friends',title:'好友对弈'}] as const;
function Lobby(){const route=useRoute();return <main className="lobby-grid" aria-label="游戏大厅">{MODES.map(m=><button key={m.key} className="mode-card" onClick={()=>route.navigate('/'+m.key)}><ModeArtwork mode={m.key}/><h1>{m.title}</h1></button>)}</main>}
function Status({value}:{value:string}){const names:Record<string,string>={online:'在线',offline:'离线',playing:'对局中',matching:'匹配中'};return <span className={`status-badge ${value}`}><i/>{names[value]??'离线'}</span>}
function RankingPage({onBack}:{onBack:()=>void}){
 const [rows,setRows]=useState<Array<PublicUser&{wins:number;games:number;winRate:number}>>([]),[page,setPage]=useState(0),[total,setTotal]=useState(0),[err,setErr]=useState('');
 useEffect(()=>{let alive=true;authApi.ranking(50,page*50).then(({data})=>{if(alive){setRows(data.ranking);setTotal(data.total??data.ranking.length)}}).catch(e=>setErr(String(e)));return()=>{alive=false}},[page]);
 return <main className="data-card panel"><div className="page-heading"><h1>排行榜 <small>仅在线匹配计分</small></h1><button className="text-back" onClick={onBack}>返回</button></div>
 {err&&<p role="alert">{err}</p>}<div className="table-scroll"><table className="ranking-table"><thead><tr><th>排名</th><th>玩家</th><th>积分</th><th>胜 / 场</th><th>胜率</th><th>状态</th></tr></thead>
 <tbody>{rows.map((p,i)=><tr key={p.id}><td><span className={`rank-index rank-${page*50+i+1}`}>{page*50+i+1}</span></td><td><span className="avatar-mark">●</span>{p.username}</td><td><b>{p.rating}</b></td><td>{p.wins} / {p.games}</td><td>{Math.round(p.winRate*100)}%</td><td><Status value={p.onlineStatus}/></td></tr>)}</tbody></table></div>
 {!rows.length&&!err&&<p className="empty-state">还没有比赛记录。</p>}
 <div className="pagination"><span>全部 {total} 位玩家</span><button className="btn" disabled={!page} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(total/50))}</span><button className="btn" disabled={(page+1)*50>=total} onClick={()=>setPage(page+1)}>下一页</button></div>
 </main>;
}
function FriendsPage(){
 const [name,setName]=useState(''),[message,setMessage]=useState(''),[friends,setFriends]=useState<PublicUser[]>([]),[invs,setInvs]=useState<Array<{id:string;senderName:string;status:string}>>([]);
 const load=useCallback(async()=>{try{const [f,i]=await Promise.all([authApi.friends(),authApi.invitations()]);setFriends(f.data.friends);setInvs(i.data.invitations.filter(x=>x.status==='pending'))}catch{}},[]);
 useEffect(()=>{void load();const t=setInterval(()=>void load(),3000);return()=>clearInterval(t)},[load]);
 async function invite(){try{await authApi.invite(name.trim());setMessage('邀请已发送，等待好友接受。');setName('');await load()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
 async function answer(id:string,yes:boolean){try{yes?await authApi.acceptInvite(id):await authApi.rejectInvite(id);await load()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
 return <main className="friends-card panel"><div className="page-heading"><h1>好友与邀请</h1><span>{friends.length} 位好友</span></div>
 <form className="invite-form" onSubmit={e=>{e.preventDefault();void invite()}}><input aria-label="受邀好友用户名" placeholder="输入好友用户名" value={name} onChange={e=>setName(e.target.value)}/><button className="btn primary" disabled={!name.trim()}>邀请对弈</button></form>
 {message&&<p className="notice" role="status">{message}</p>}<h2>待处理邀请</h2>{!invs.length&&<p className="empty-state">暂无新邀请</p>}
 {invs.map(iv=><div className="friend-row" key={iv.id}><span className="avatar-mark">●</span><span>{iv.senderName} 邀请你对弈</span><button className="btn primary small" onClick={()=>answer(iv.id,true)}>接受</button><button className="btn small" onClick={()=>answer(iv.id,false)}>拒绝</button></div>)}
 <h2>好友</h2>{!friends.length&&<p className="empty-state">邀请朋友，一起落子。</p>}{friends.map(f=><div className="friend-row" key={f.id}><span className="avatar-mark">●</span><strong>{f.username}</strong><Status value={f.onlineStatus}/><button className="btn small" onClick={()=>{setName(f.username)}}>邀请</button></div>)}
 </main>;
}
function TutorialPage({user,applyAuth,onDone}:{user:PublicUser;applyAuth:(t:string,u:PublicUser)=>void;onDone:()=>void}){
 const [assignment]=useState(()=>createTutorialAssignment());const [started,setStarted]=useState(false),[finished,setFinished]=useState(false),[error,setError]=useState('');
 const human=humanSeatOf(assignment);
 async function finish(){try{const {data}=await authApi.completeTutorial();applyAuth(getToken()??'',data.user);setFinished(true)}catch(e){setError(String(e))}}
 if(finished||user.tutorialCompleted)return <main className="simple-state panel"><div className="result-stones"><ColorChip player="A"/><ColorChip player="B"/><ColorChip player="C"/></div><h1>准备好正式对弈了</h1><p>新手教学已完成。</p><button className="btn primary" onClick={onDone}>进入大厅</button></main>;
 if(!started)return <main className="tutorial-intro panel"><div className="page-heading"><h1>新手教学</h1><span>一盘练习</span></div><RulesQuickView/><p className="muted">你执{colorName(human)}棋，与两位 AI 练习。完整下完一局即可完成教学，输赢都不影响积分。</p><button className="btn primary" onClick={()=>setStarted(true)}>开始练习</button></main>;
 return <>{error&&<p role="alert">{error}</p>}<App hostTitle="新手教学" presetSeats={assignment} onGameEnd={()=>void finish()} onExit={()=>setStarted(false)} coach={c=>c.thinking?'对手正在思考…':c.round<=5?'前五回合无人拥有胜权，先布局。':c.eligible===c.current?'你拥有胜权，本手成四即可获胜。':`本回合${colorName(c.eligible)}棋有胜权。`}/></>;
}
function LocalHost({mode,user,onExit}:{mode:'local'|'vsai';user:PublicUser|null;onExit:()=>void}){
 const route=useRoute();const [config,setConfig]=useState<{seats:SeatConfigs;size:BoardSize}|null>(null);
 if(mode==='vsai'&&user&&!user.tutorialCompleted)return <main className="simple-state panel"><h1>先来一盘新手教学</h1><button className="btn primary" onClick={()=>route.navigate('/tutorial')}>开始教学</button></main>;
 if(!config)return <GameSetup mode={mode} onStart={(seats,size)=>setConfig({seats,size})} onBack={onExit}/>;
 const policy:MatchPolicyContext|undefined=mode==='vsai'&&countHuman(config.seats)===1&&countAI(config.seats)===2?{defenseFastestThreat:true}:undefined;
 return <App key={JSON.stringify(config)} hostTitle={mode==='local'?'离线模式':'人机对战'} initialSize={config.size} presetSeats={config.seats} aiPolicy={policy} onExit={()=>setConfig(null)}/>;
}
function GameSetup({mode,onStart,onBack}:{mode:'local'|'vsai';onStart:(s:SeatConfigs,n:BoardSize)=>void;onBack:()=>void}){
 const [size,setSize]=useState<BoardSize>(13);const [seats,setSeats]=useState<SeatConfigs>(()=>mode==='local'?{A:{kind:'human'},B:{kind:'human'},C:{kind:'human'}}:{A:{kind:'human'},B:{kind:'ai',level:3},C:{kind:'ai',level:3}});
 const humans=countHuman(seats),ais=countAI(seats);
 return <main className="setup-card panel"><div className="page-heading"><h1>{mode==='local'?'离线模式':'人机对战'}</h1><button className="text-back" onClick={onBack}>返回</button></div>
 <h2>棋盘</h2><div className="size-picker">{([13,17] as BoardSize[]).map(n=><button key={n} className={`size-tile ${n===size?'selected':''}`} onClick={()=>setSize(n)}><b>{n}</b><span>路棋盘</span></button>)}</div>
 <h2>玩家</h2><div className="seat-config-list">{PLAYERS.map(p=><div className="seat-config" key={p}><ColorChip player={p}/><strong>{playerName(p)}</strong>
 <select aria-label={`${colorName(p)}棋玩家类型`} value={seats[p].kind==='human'?'human':String(seats[p].level??3)} onChange={e=>setSeats(s=>({...s,[p]:e.target.value==='human'?{kind:'human'}:{kind:'ai',level:Number(e.target.value) as AILevel}}))}>
 <option value="human">真人</option>{STAR_LEVELS.map(l=><option value={l} key={l}>AI {'★'.repeat(l)}</option>)}</select></div>)}</div>
 <div className="setup-bottom"><span>{humans===0?'至少保留一名真人':mode==='vsai'&&ais===0?'请选择 1–2 位 AI 对手':`${humans} 位真人${ais?' · '+ais+' 位 AI':''}`}</span><button className="btn primary" disabled={humans===0||(mode==='vsai'&&ais===0)} onClick={()=>onStart(seats,size)}>开始对局</button></div>
 </main>;
}
