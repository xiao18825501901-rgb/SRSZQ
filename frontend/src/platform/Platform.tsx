/** SRSZQ.com 平台外壳：Landing / Auth / Lobby / 排行 / 好友 / 教学 / 各对局模式入口 */
import { useCallback, useEffect, useState } from 'react';
import type { Player } from '../../../shared/src/game/types';
import type { AILevel, SeatConfigs } from '../../../shared/src/ai/types';
import { PLAYERS } from '../../../shared/src/game/types';
import App from '../App';
import { authApi, clearAuth, getCachedUser, getToken, setAuth, type PublicUser } from '../api';
import { gameLink, resetSocket } from '../ws';
import { useRoute } from '../router';
import { OnlinePage } from './OnlinePage';

/** 星级 → 内部档位（用户只与 ★ 交互） */
export const STAR_LEVELS: AILevel[] = ['random', 'tactical', 'selfish', '3ply', 'maxn'];
const STARS = ['★', '★★', '★★★', '★★★★', '★★★★★'];

export function useSession(): { user: PublicUser | null; applyAuth: (token: string, user: PublicUser) => void; refresh: () => Promise<void> } {
  const [user, setUser] = useState<PublicUser | null>(() => getCachedUser());
  const applyAuth = useCallback((token: string, u: PublicUser) => {
    setAuth(token, u);
    setUser(u);
  }, []);
  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try {
      const { data } = await authApi.me();
      setAuth(getToken() ?? '', data.user);
      setUser(data.user);
    } catch {
      /* token 失效 → 保持现状 */
    }
  }, []);
  return { user, applyAuth, refresh };
}

export function Platform() {
  const route = useRoute();
  const { user, applyAuth, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 全局 GameLink：登录后连接 WS；任何页面收到 game.start（含好友接受开局）→ 自动进入对局页
  const navPath = route.path;
  useEffect(() => {
    if (!user) return;
    gameLink.attach();
    const off = gameLink.subscribe(() => {
      if (gameLink.phase === 'game' && gameLink.game && navPath !== '/online') {
        route.navigate('/online');
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, navPath]);

  const doAuth = async (mode: 'login' | 'register', email: string, username: string, password: string) => {
    setBusy(true);
    setErr('');
    try {
      const { data } = mode === 'register' ? await authApi.register(email, username, password) : await authApi.login(username || email, password);
      applyAuth(data.token, data.user);
      route.navigate(data.user.tutorialCompleted ? '/lobby' : '/tutorial');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      /* ignore */
    }
    clearAuth();
    resetSocket();
    route.navigate('/');
  };

  // 页头导航（登录态）
  const nav = (
    <div className="pf-nav">
      <span className="pf-brand">SRSZQ</span>
      <div className="pf-nav-links">
        {user ? (
          <>
            <button className="btn ghost" onClick={() => route.navigate('/lobby')}>大厅</button>
            <button className="btn ghost" onClick={() => route.navigate('/ranking')}>排行榜</button>
            <button className="btn ghost" onClick={() => route.navigate('/friends')}>好友</button>
            <span className="pf-user" title={user.username}>
              <img className="pf-avatar" src={user.avatar} alt="" />
              {user.username} · {user.rating}
              <span className={`pf-dot ${user.onlineStatus}`} />
            </span>
            <button className="btn" onClick={logout}>退出</button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={() => route.navigate('/ranking')}>排行榜</button>
            <button className="btn primary" onClick={() => route.navigate('/auth')}>登录 / 注册</button>
          </>
        )}
      </div>
    </div>
  );

  const { path } = route;
  if (path === '/auth') {
    return (
      <div className="pf-page">
        {nav}
        <AuthCard busy={busy} err={err} onAuth={doAuth} />
      </div>
    );
  }
  if (path === '/ranking') {
    return (
      <div className="pf-page">
        {nav}
        <RankingPage onBack={() => (user ? route.navigate('/lobby') : route.navigate('/'))} />
      </div>
    );
  }
  if (path === '/friends') {
    if (!user) return <RedirectTo to="/auth" />;
    return (
      <div className="pf-page">
        {nav}
        <FriendsPage />
      </div>
    );
  }
  if (path === '/lobby') {
    if (!user) return <RedirectTo to="/auth" />;
    if (!user.tutorialCompleted) return <RedirectTo to="/tutorial" />;
    return (
      <div className="pf-page">
        {nav}
        <Lobby user={user} />
      </div>
    );
  }
  if (path === '/tutorial') {
    if (!user) return <RedirectTo to="/auth" />;
    return (
      <TutorialPage
        user={user}
        applyAuth={applyAuth}
        onDone={() => route.navigate('/lobby')}
        onExit={() => route.navigate('/lobby')}
      />
    );
  }
  if (path === '/online') {
    if (!user) return <RedirectTo to="/auth" />;
    // 教学门禁适用于在线匹配/人机；好友邀请开局的进行中对局不受限
    const inInviteGame = gameLink.phase === 'game' || gameLink.phase === 'end';
    if (!user.tutorialCompleted && !inInviteGame) return <RedirectTo to="/tutorial" />;
    return (
      <div className="pf-page pf-full">
        {nav}
        <OnlinePage user={user} onExit={() => route.navigate('/lobby')} />
      </div>
    );
  }
  if (path === '/local' || path === '/vsai' || path === '/tutgame') {
    // 本地对局 / 人机模式复用本地引擎视图（在线模式走 OnlinePage）
    return <LocalHost mode={path === '/local' ? 'local' : 'vsai'} user={user} onExit={() => route.navigate(user ? '/lobby' : '/')} />;
  }
  // 默认：Landing
  return (
    <div className="pf-page">
      {nav}
      <Landing user={user} />
    </div>
  );
}

function RedirectTo({ to }: { to: string }) {
  useEffect(() => {
    window.location.hash = `#${to}`;
  }, [to]);
  return <div className="pf-page pf-center">跳转中…</div>;
}

/* ---------------- Landing ---------------- */
function Landing({ user }: { user: PublicUser | null }) {
  const route = useRoute();
  const go = (to: string) => route.navigate(to);
  return (
    <div className="landing">
      <section className="hero">
        <h1>SRSZQ</h1>
        <p className="hero-sub">Three Player Strategy Game · 三人四子棋在线平台</p>
        <p className="hero-desc">
          三名玩家在 13×13 / 17×17 棋盘轮流落子；Round 1–5 无人可胜，Round 6 起按 C → B → A 循环授予胜权 ——
          只有持胜权的玩家凭本手连成四子才算获胜。在线匹配、AI 陪练、好友邀请、排行榜，全球同台。
        </p>
        <div className="hero-actions">
          {user ? (
            <>
              <button className="btn primary big" onClick={() => go('/online')}>Play Online</button>
              <button className="btn big" onClick={() => go('/vsai')}>Play With AI</button>
              <button className="btn big" onClick={() => go('/local')}>Local Match</button>
            </>
          ) : (
            <>
              <button className="btn primary big" onClick={() => go('/auth')}>注册并开始</button>
              <button className="btn big" onClick={() => go('/local')}>先试试本地对局</button>
              <button className="btn big" onClick={() => go('/ranking')}>排行榜</button>
            </>
          )}
        </div>
      </section>
      <section className="rules-teaser">
        <h2>规则速览</h2>
        <ol>
          <li>玩家 A（红）→ B（绿）→ C（白）轮流落子，一个 Round = 三人各下一手。</li>
          <li>Round 1–5：无人拥有胜权，任何形成自己 ≥4 连的落子都是禁手。</li>
          <li>Round ≥ 6：胜权按 C → B → A 循环；持胜权的玩家本手连成 ≥4 才获胜。</li>
          <li>棋盘 13×13 / 17×17；胜利只由当前落子触发，不存在“储存四连”。</li>
        </ol>
      </section>
    </div>
  );
}

/* ---------------- Auth ---------------- */
function AuthCard(props: { busy: boolean; err: string; onAuth: (mode: 'login' | 'register', email: string, username: string, password: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const route = useRoute();
  return (
    <div className="auth-card">
      <h2>{mode === 'register' ? '注册 SRSZQ' : '登录 SRSZQ'}</h2>
      <div className="auth-tabs">
        <button className={`btn ${mode === 'register' ? 'primary' : ''}`} onClick={() => setMode('register')}>注册</button>
        <button className={`btn ${mode === 'login' ? 'primary' : ''}`} onClick={() => setMode('login')}>登录</button>
      </div>
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          props.onAuth(mode, email, username, password);
        }}
      >
        {mode === 'register' && (
          <label>
            邮箱
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
        )}
        <label>
          {mode === 'register' ? '用户名' : '账号（用户名或邮箱）'}
          <input required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="2-16 位字母/数字/下划线/中文" />
        </label>
        <label>
          密码
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" />
        </label>
        {props.err && <p className="error-text">{props.err}</p>}
        <button className="btn primary big" disabled={props.busy} type="submit">
          {props.busy ? '处理中…' : mode === 'register' ? '注册并开始' : '登录'}
        </button>
      </form>
      <button className="btn ghost" onClick={() => route.navigate('/')}>← 返回首页</button>
    </div>
  );
}

/* ---------------- Lobby ---------------- */
function Lobby({ user }: { user: PublicUser }) {
  const route = useRoute();
  const [status, setStatus] = useState('online');
  const { refresh } = useSession();
  useEffect(() => {
    setStatus(user.onlineStatus);
    void refresh();
  }, [user, refresh]);
  return (
    <div className="lobby">
      <div className="lobby-user">
        <img className="pf-avatar big" src={user.avatar} alt="" />
        <div>
          <h2>{user.username}</h2>
          <p>
            Rating {user.rating} · 状态 <span className={`pf-dot ${status}`} /> {status}
          </p>
        </div>
      </div>
      <div className="lobby-cards">
        <button className="mode-card accent" onClick={() => route.navigate('/online')}>
          <strong>Online Match</strong>
          <span>匹配 3 名真人；不足时 AI 补位（60 秒）。只有在线对局计入排行。</span>
        </button>
        <button className="mode-card" onClick={() => route.navigate('/vsai')}>
          <strong>Human vs AI</strong>
          <span>选择 1–2 个 AI 座位与 ★ 难度陪练（不计排行）。</span>
        </button>
        <button className="mode-card" onClick={() => route.navigate('/local')}>
          <strong>Local Match</strong>
          <span>同一设备三名玩家轮流对弈（无需联网）。</span>
        </button>
        <button className="mode-card" onClick={() => route.navigate('/friends')}>
          <strong>好友邀请</strong>
          <span>邀请好友接受后立即开局（2 人 + AI 补位）。</span>
        </button>
      </div>
    </div>
  );
}

/* ---------------- Ranking ---------------- */
function RankingPage({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Array<any>>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    authApi
      .ranking(20)
      .then(({ data }) => setRows(data.ranking))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <div className="panel pf-panel">
      <div className="panel-title">排行榜（仅 Online Match 计分）</div>
      {err && <p className="error-text">{err}</p>}
      <table className="pf-table">
        <thead>
          <tr>
            <th>#</th>
            <th>玩家</th>
            <th>Rating</th>
            <th>胜/场</th>
            <th>胜率</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td>{i + 1}</td>
              <td>
                <img className="pf-avatar" src={r.avatar} alt="" /> {r.username}
              </td>
              <td>{r.rating}</td>
              <td>
                {r.wins}/{r.games}
              </td>
              <td>{r.games > 0 ? `${Math.round(r.winRate * 100)}%` : '—'}</td>
              <td>
                <span className={`pf-dot ${r.onlineStatus}`} /> {r.onlineStatus}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn ghost" onClick={onBack}>← 返回</button>
    </div>
  );
}

/* ---------------- Friends & Invitations ---------------- */
function FriendsPage() {
  const [friends, setFriends] = useState<Array<any>>([]);
  const [invs, setInvs] = useState<Array<any>>([]);
  const [toUser, setToUser] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => {
    void authApi.friends().then(({ data }) => setFriends(data.friends));
    void authApi.invitations().then(({ data }) => setInvs(data.invitations));
  };
  useEffect(load, []);
  const invite = async () => {
    setMsg('');
    try {
      await authApi.invite(toUser.trim());
      setMsg(`已向 ${toUser.trim()} 发送邀请（接受后自动开局）。`);
      setToUser('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const act = async (id: string, accept: boolean) => {
    try {
      if (accept) await authApi.acceptInvite(id);
      else await authApi.rejectInvite(id);
      setMsg(accept ? '已接受：对局即将开始…' : '已拒绝');
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="pf-panel-wrap">
      <div className="panel pf-panel">
        <div className="panel-title">好友与邀请</div>
        <div className="friend-invite">
          <input value={toUser} onChange={(e) => setToUser(e.target.value)} placeholder="输入对方用户名邀请对战" />
          <button className="btn primary" onClick={invite}>Invite</button>
        </div>
        {msg && <p className="muted">{msg}</p>}
        <h4>待处理邀请</h4>
        {invs.length === 0 && <p className="muted">暂无邀请</p>}
        {invs.map((iv) => (
          <div key={iv.id} className="friend-row">
            <span>{iv.senderName} 邀请你对战</span>
            <button className="btn primary" onClick={() => act(iv.id, true)}>接受</button>
            <button className="btn" onClick={() => act(iv.id, false)}>拒绝</button>
          </div>
        ))}
        <h4>好友（{friends.length}）</h4>
        {friends.map((f) => (
          <div key={f.id} className="friend-row">
            <img className="pf-avatar" src={f.avatar} alt="" />
            <span>{f.username}</span>
            <span className={`pf-dot ${f.onlineStatus}`} />
            <span className="muted">{f.onlineStatus}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Tutorial ---------------- */
const TUTORIAL_ROUNDS = 3;
/** 教学 AI 内部档位（UI 只见 ★）；人类座位每局轮换 */
const TUTORIAL_AI: Array<[Player, AILevel]> = [
  ['B', 'random'],
  ['C', 'tactical'],
  ['A', 'selfish'],
];

function TutorialPage({
  user,
  applyAuth,
  onDone,
  onExit,
}: {
  user: PublicUser;
  applyAuth: (token: string, user: PublicUser) => void;
  onDone: () => void;
  onExit: () => void;
}) {
  const [round, setRound] = useState(0);
  const [lastResult, setLastResult] = useState('');
  const [finished, setFinished] = useState(false);

  if (user.tutorialCompleted) {
    return (
      <div className="pf-page pf-center">
        <h2>教学已完成 ✓</h2>
        <button className="btn primary" onClick={onDone}>进入大厅</button>
      </div>
    );
  }

  const buildSeats = (r: number): SeatConfigs => {
    const [aiSeat, level] = TUTORIAL_AI[r % TUTORIAL_ROUNDS];
    const seats: SeatConfigs = { A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'human' } };
    seats[aiSeat] = { kind: 'ai', level };
    return seats;
  };

  if (finished) {
    return (
      <div className="pf-page pf-center">
        <h2>教学完成！🎉</h2>
        <p className="muted">你已经与 AI 完成了 3 局练习（胜负不影响积分）。</p>
        <button
          className="btn primary big"
          onClick={async () => {
            try {
              const { data } = await authApi.completeTutorial();
              applyAuth(getToken() ?? '', data.user);
            } catch {
              /* 后端异常时仍放行到大厅（本地已完成教学） */
            }
            onDone();
          }}
        >
          进入大厅
        </button>
      </div>
    );
  }

  const handleEnd = (winner: Player | null) => {
    setLastResult(winner ? `第 ${round + 1} 局结束：玩家 ${winner} 获胜` : `第 ${round + 1} 局结束：和棋`);
    setTimeout(() => {
      if (round + 1 >= TUTORIAL_ROUNDS) {
        setFinished(true);
      } else {
        setRound((r) => r + 1);
        setLastResult('');
      }
    }, 1500);
  };

  return (
    <div className="pf-page">
      <div className="pf-nav">
        <span className="pf-brand">SRSZQ · 新手教学</span>
        <span className="muted">
          第 {round + 1} / {TUTORIAL_ROUNDS} 局（AI 难度随进度提升，仅显示 ★）
        </span>
        <button className="btn ghost" onClick={onExit}>返回</button>
      </div>
      {lastResult && <div className="notice info">{lastResult}</div>}
      <App
        key={`tut-${round}`}
        presetSeats={buildSeats(round)}
        hostTitle={`新手教学 ${round + 1}/${TUTORIAL_ROUNDS} · 与 AI 练习`}
        onGameEnd={handleEnd}
        onExit={onExit}
        embedded
      />
    </div>
  );
}

/* ---------------- 本地 / 人机宿主 ---------------- */
function LocalHost({ mode, user, onExit }: { mode: 'local' | 'vsai'; user: PublicUser | null; onExit: () => void }) {
  const route = useRoute();
  const [cfg, setCfg] = useState<SeatConfigs | null>(null);

  if (mode === 'vsai' && user && !user.tutorialCompleted) {
    return (
      <div className="pf-page pf-center">
        <p>请先完成新手教学再开始 AI 对战。</p>
        <button className="btn primary" onClick={() => route.navigate('/tutorial')}>去教学</button>
      </div>
    );
  }

  if (mode === 'vsai' && !cfg) {
    return <VsAiPicker onStart={setCfg} onBack={onExit} />;
  }

  const seats: SeatConfigs =
    cfg ?? { A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'human' } };
  const title = mode === 'local' ? '本地对局 Local Match' : 'Human vs AI · 人机对局';
  return (
    <App
      key={mode === 'local' ? 'local' : `vsai-${JSON.stringify(cfg)}`}
      presetSeats={seats}
      hostTitle={title}
      onExit={onExit}
    />
  );
}

function VsAiPicker({ onStart, onBack }: { onStart: (s: SeatConfigs) => void; onBack: () => void }) {
  const [humans, setHumans] = useState<Player[]>(['A']);
  const [starsMap, setStarsMap] = useState<Partial<Record<Player, number>>>({ B: 3 });
  const toggleHuman = (p: Player) => {
    setHumans((prev) => {
      const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
      // 至少 1 人类
      return next.length === 0 ? prev : next;
    });
  };
  const start = () => {
    const seats = {} as SeatConfigs;
    for (const p of PLAYERS) {
      seats[p] = humans.includes(p) ? { kind: 'human' } : { kind: 'ai', level: STAR_LEVELS[(starsMap[p] ?? 3) - 1] };
    }
    onStart(seats);
  };
  return (
    <div className="pf-panel-wrap">
      <div className="panel pf-panel">
        <div className="panel-title">Human vs AI · 座位与难度</div>
        <p className="muted">每局 0–2 个 AI、至少 1 名人类。AI 难度只以 ★ 显示。</p>
        {PLAYERS.map((p) => {
          const isHuman = humans.includes(p);
          return (
            <div key={p} className="friend-row">
              <label>
                <input type="checkbox" checked={isHuman} onChange={() => toggleHuman(p)} /> 玩家 {p} = 人类
              </label>
              {!isHuman && (
                <select
                  value={starsMap[p] ?? 3}
                  onChange={(e) => setStarsMap((m) => ({ ...m, [p]: Number(e.target.value) }))}
                >
                  {STARS.map((s, i) => (
                    <option key={i + 1} value={i + 1}>
                      AI {s}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        <div className="btn-row">
          <button className="btn ghost" onClick={onBack}>返回</button>
          <button className="btn primary" onClick={start}>开始对局</button>
        </div>
      </div>
    </div>
  );
}

export default Platform;
