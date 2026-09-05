/** SRSZQ.com 平台外壳：Landing / Auth / Lobby / 排行 / 好友 / 教学 / 各对局模式入口 */
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { Player } from '../../../shared/src/game/types';
import type { AILevel, SeatConfigs } from '../../../shared/src/ai/types';
import { PLAYERS } from '../../../shared/src/game/types';
import App from '../App';
import { authApi, clearAuth, getCachedUser, getToken, setAuth, type PublicUser } from '../api';
import { gameLink, resetSocket } from '../ws';
import { useRoute } from '../router';
import { Btn, Card, PageMotion } from '../ui';
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

  // 页头导航（登录态）—— glass nav
  const nav = (
    <div className="glass-nav">
      <span className="pf-brand" style={{ cursor: 'pointer' }} onClick={() => route.navigate('/')}>
        SRSZQ
      </span>
      <div className="pf-nav-links">
        {user ? (
          <>
            <button className="ds-btn ghost small" onClick={() => route.navigate('/lobby')}>大厅</button>
            <button className="ds-btn ghost small" onClick={() => route.navigate('/ranking')}>排行榜</button>
            <button className="ds-btn ghost small" onClick={() => route.navigate('/friends')}>好友</button>
            <span className="pf-user" title={user.username}>
              <img className="pf-avatar" src={user.avatar} alt="" />
              {user.username}
              <b style={{ color: '#b79cff' }}>{user.rating}</b>
              <span className={`pf-dot ${user.onlineStatus}`} />
            </span>
            <button className="ds-btn small" onClick={logout}>退出</button>
          </>
        ) : (
          <>
            <button className="ds-btn ghost small" onClick={() => route.navigate('/ranking')}>排行榜</button>
            <button className="ds-btn primary small" onClick={() => route.navigate('/auth')}>登录 / 注册</button>
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
const MINI_A = [[2, 4], [5, 7], [9, 3], [7, 8], [4, 9], [8, 2], [6, 5], [3, 10], [10, 4]];
const MINI_B = [[1, 6], [4, 3], [8, 7], [5, 10], [9, 6], [3, 4], [7, 2], [2, 9], [10, 7]];
const MINI_C = [[6, 8], [2, 3], [9, 9], [4, 6], [7, 4], [3, 7], [8, 5], [1, 2], [5, 5]];

function MiniBoardPreview() {
  const n = 13;
  const cells: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const key = `${r}-${c}`;
      const cls = MINI_A.some(([rr, cc]) => `${rr}-${cc}` === key) ? 'a' : MINI_B.some(([rr, cc]) => `${rr}-${cc}` === key) ? 'b' : MINI_C.some(([rr, cc]) => `${rr}-${cc}` === key) ? 'c' : '';
      cells.push(`<i class="${cls}"></i>`);
    }
  }
  return (
    <div
      className="mini-board fade-in"
      style={{ animationDelay: '.25s' }}
      dangerouslySetInnerHTML={{ __html: cells.join('') }}
    />
  );
}

function Landing({ user }: { user: PublicUser | null }) {
  const route = useRoute();
  const go = (to: string) => route.navigate(to);
  return (
    <PageMotion>
      <section className="hero2">
        <span className="orb o1" />
        <span className="orb o2" />
        <span className="orb o3" />
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <span className="eyebrow">正式规则 v2 · 13×13 / 17×17 · BAC C→B→A</span>
          <h1>
            Three Player <span className="grad">Strategy Battle</span>
          </h1>
          <p className="tagline">Think. Predict. Dominate.</p>
          <div className="cta-row">
            {user ? (
              <>
                <Btn variant="primary" size="big" onClick={() => go('/online')}>Play Online</Btn>
                <Btn size="big" onClick={() => go('/vsai')}>Play With AI</Btn>
                <Btn size="big" onClick={() => go('/local')}>Local Match</Btn>
              </>
            ) : (
              <>
                <Btn variant="primary" size="big" onClick={() => go('/auth')}>注册并开始</Btn>
                <Btn size="big" onClick={() => go('/local')}>先试试本地对局</Btn>
                <Btn size="big" onClick={() => go('/ranking')}>排行榜</Btn>
              </>
            )}
          </div>
        </motion.div>
        <MiniBoardPreview />
      </section>

      <section className="features">
        <Card hoverable className="feature">
          <span className="f-icon">🌐</span>
          <h3>Online Match · 在线竞技</h3>
          <p>匹配 3 名真人同台竞技；60 秒不足三人自动 AI 补位。对局结果计入全球排行榜（Elo 式评分）。</p>
        </Card>
        <Card hoverable className="feature stars">
          <span className="f-icon">🤖</span>
          <h3>AI 陪练 · 五档难度</h3>
          <p>从新手到高手：AI 难度只以星级呈现——</p>
          <ul>
            {['★ 稳健入门', '★★ 战术应对', '★★★ 资格博弈', '★★★★ 回合级推演', '★★★★★ 深度最优求解'].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </Card>
        <Card hoverable className="feature">
          <span className="f-icon">👥</span>
          <h3>好友邀请 · 即邀即战</h3>
          <p>邀请 1 位好友：真人 + 真人 + AI 立即开局；邀请 2 位好友：全部接受后组成纯真人三人局。</p>
        </Card>
        <Card hoverable className="feature">
          <span className="f-icon">🏆</span>
          <h3>排行榜 · 在线计分</h3>
          <p>只有 Online Match 影响 Rating；人机与教学对局不计分，保证公平竞技。</p>
        </Card>
      </section>

      <section className="rules-strip ds-card">
        <div className="rs-item">
          <b>Round 1–5</b>
          <span>无人拥有胜权：任何形成 ≥4 连的落子都是禁手。</span>
        </div>
        <div className="rs-item">
          <b>Round 6 起</b>
          <span>胜权按 C → B → A 循环授予（R6=C · R7=B · R8=A）。</span>
        </div>
        <div className="rs-item">
          <b>胜利条件</b>
          <span>持胜权的玩家凭本手连成 ≥4 即胜——不存在“储存四连”。</span>
        </div>
        <div className="rs-item">
          <b>无合法步</b>
          <span>自动 Pass；棋盘 13×13 / 17×17，一局约 15–40 分钟。</span>
        </div>
      </section>
      <div style={{ textAlign: 'center', padding: '18px 0 40px' }}>
        <Btn variant="ghost" onClick={() => go('/ranking')}>查看排行榜 →</Btn>
      </div>
    </PageMotion>
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
    <div className="auth-shell">
      <Card className="auth-card2 fade-in">
        <h2>{mode === 'register' ? '注册 SRSZQ' : '登录 SRSZQ'}</h2>
        <p className="sub">{mode === 'register' ? '注册后完成 3 局教学即可进入在线对战。' : '登录继续你的 SRSZQ 征程。'}</p>
        <div className="auth-tabs">
          <Btn variant={mode === 'register' ? 'primary' : 'ghost'} onClick={() => setMode('register')}>注册</Btn>
          <Btn variant={mode === 'login' ? 'primary' : 'ghost'} onClick={() => setMode('login')}>登录</Btn>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            props.onAuth(mode, email, username, password);
          }}
        >
          {mode === 'register' && (
            <label className="field">
              <span>邮箱</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
          )}
          <label className="field">
            <span>{mode === 'register' ? '用户名' : '账号（用户名或邮箱）'}</span>
            <input required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="2-16 位字母/数字/下划线/中文" />
          </label>
          <label className="field">
            <span>密码</span>
            <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" />
          </label>
          {props.err && <p className="error-text">{props.err}</p>}
          <Btn variant="primary" size="big" disabled={props.busy} className="ds-block" style={{ width: '100%' }} type="submit">
            {props.busy ? '处理中…' : mode === 'register' ? '注册并开始' : '登录'}
          </Btn>
        </form>
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <Btn variant="ghost" size="small" onClick={() => route.navigate('/')}>← 返回首页</Btn>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Lobby（大型 Feature Cards） ---------------- */
const LOBBIES = [
  {
    key: 'online',
    icon: '🌐',
    title: 'Online Match',
    desc: '匹配 3 名真人同台竞技；等待超过 60 秒自动 AI 补位（1 人 → 2 AI，2 人 → 1 AI），绝不让你空等。结果计入全球排行榜。',
    meta: '真人在线 · 计分',
    accent: true,
    cta: '开始匹配',
  },
  {
    key: 'vsai',
    icon: '🤖',
    title: 'Human vs AI',
    desc: '选择 1–2 个 AI 座位，难度从 ★ 到 ★★★★★ 自由调整。适合练手、研究 BAC 资格博弈与新战术。',
    meta: '本地引擎 · ★难度 · 不计分',
    accent: false,
    cta: '选择对手',
  },
  {
    key: 'local',
    icon: '🎲',
    title: 'Local Match',
    desc: '同一设备三名玩家轮流对弈：完整规则引擎、悔棋、自动 Pass、导入导出，随开随玩。',
    meta: '离线 · 无需账号',
    accent: false,
    cta: '开始对局',
  },
  {
    key: 'friends',
    icon: '👥',
    title: '好友邀请',
    desc: '邀请 1 位好友立即成局（真人+真人+AI）；邀请 2 位好友并全部接受，组成纯真人三人局。',
    meta: '实时状态 · 在线好友',
    accent: false,
    cta: '邀请好友',
  },
];

function Lobby({ user }: { user: PublicUser }) {
  const route = useRoute();
  return (
    <PageMotion>
      <div className="lobby-user">
        <img className="pf-avatar big" src={user.avatar} alt="" />
        <div>
          <h2 style={{ margin: 0 }}>{user.username}</h2>
          <div className="pf-user" style={{ marginTop: 4 }}>
            <span className="ds-badge">Rating {user.rating}</span>
            <StatusBadgeView status={user.onlineStatus as any} />
          </div>
        </div>
      </div>
      <div className="lobby2">
        {LOBBIES.map((m, i) => (
          <motion.button
            key={m.key}
            className={`ds-card hoverable fcard ${m.accent ? 'accent' : ''}`}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 * i, duration: 0.3, ease: 'easeOut' }}
            whileHover={{ y: -5 }}
            onClick={() => route.navigate(`/${m.key === 'friends' ? 'friends' : m.key}`)}
          >
            <span className="fc-icon">{m.icon}</span>
            <h3>{m.title}</h3>
            <p className="fc-desc">{m.desc}</p>
            <span className="fc-meta">{m.meta}</span>
            <span className={`ds-btn ${m.accent ? 'primary' : ''} fc-btn`}>{m.cta}</span>
          </motion.button>
        ))}
      </div>
    </PageMotion>
  );
}

function StatusBadgeView({ status }: { status: 'online' | 'offline' | 'playing' | 'matching' }) {
  const map = { online: '在线', offline: '离线', playing: '对局中', matching: '匹配中' } as const;
  return (
    <span className={`ds-badge ${status}`}>
      <span className="pf-dot" />
      {map[status] ?? status}
    </span>
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
    <div className="ds-card ds-panel fade-in">
      <div className="head">
        <span className="ds-title">排行榜 · 仅 Online Match 计分</span>
        <Btn variant="ghost" size="small" onClick={onBack}>← 返回</Btn>
      </div>
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
              <td><span className="rank-no">{i + 1}</span></td>
              <td>
                <img className="pf-avatar" src={r.avatar} alt="" /> {r.username}
              </td>
              <td><b style={{ color: '#b79cff' }}>{r.rating}</b></td>
              <td>
                {r.wins}/{r.games}
              </td>
              <td>{r.games > 0 ? `${Math.round(r.winRate * 100)}%` : '—'}</td>
              <td>
                <StatusBadgeView status={r.onlineStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <div className="ds-card ds-panel fade-in">
        <div className="head">
          <span className="ds-title">好友与邀请 · Friends & Invites</span>
        </div>
        <div className="friend-invite">
          <input value={toUser} onChange={(e) => setToUser(e.target.value)} placeholder="输入对方用户名邀请对战" />
          <Btn variant="primary" onClick={invite}>Invite</Btn>
        </div>
        {msg && <p className="muted">{msg}</p>}
        <h4>待处理邀请</h4>
        {invs.length === 0 && <p className="muted">暂无邀请</p>}
        {invs.map((iv) => (
          <div key={iv.id} className="friend-row">
            <span>{iv.senderName} 邀请你对战</span>
            <Btn variant="primary" size="small" onClick={() => act(iv.id, true)}>接受</Btn>
            <Btn size="small" onClick={() => act(iv.id, false)}>拒绝</Btn>
          </div>
        ))}
        <h4>好友（{friends.length}）</h4>
        {friends.map((f) => (
          <div key={f.id} className="friend-row">
            <img className="pf-avatar" src={f.avatar} alt="" />
            <span>{f.username}</span>
            <StatusBadgeView status={f.onlineStatus} />
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
