/** SRSZQ.com 平台外壳：Landing / Auth / Lobby / 排行 / 好友 / 教学 / 各对局模式入口 */
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { Player } from '../../../shared/src/game/types';
import { PLAYERS, PLAYER_COLORS } from '../../../shared/src/game/types';
import { AI_LEVELS, AI_LEVEL_STARS, type AILevel, type SeatConfigs } from '../../../shared/src/ai/types';
import App from '../App';
import type { CoachContext } from '../App';
import { HowToPlayContent, RulesQuickView } from '../components/HowToPlay';
import { aiDisplayName, createTutorialAssignment, humanSeatOf, tutorialRoleLines, type TutorialAssignment } from './tutorialModel';
import { localHumanCount, resolveLocalSeats, type LocalDraft } from './localGameModel';
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
            <button className="ds-btn ghost small" onClick={() => route.navigate('/rules')}>怎么玩</button>
            <button className="ds-btn ghost small" onClick={() => route.navigate('/ranking')}>排行榜</button>
            <button className="ds-btn ghost small" onClick={() => route.navigate('/friends')}>好友</button>
            <span className="pf-user" title={user.username}>
              <img className="pf-avatar" src={user.avatar} alt="" />
              {user.username}
              <b style={{ color: '#a8cdf0' }}>{user.rating}</b>
              <span className={`pf-dot ${user.onlineStatus}`} />
            </span>
            <button className="ds-btn small" onClick={logout}>退出</button>
          </>
        ) : (
          <>
            <button className="ds-btn ghost small" onClick={() => route.navigate('/rules')}>怎么玩</button>
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
  if (path === '/rules') {
    return (
      <div className="pf-page rules-page">
        {nav}
        <HowToPlayContent
          onBack={() => route.navigate(user ? '/lobby' : '/')}
          onStartTutorial={user && !user.tutorialCompleted ? () => route.navigate('/tutorial') : undefined}
        />
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
    <div className="mini-board" dangerouslySetInnerHTML={{ __html: cells.join('') }} />
  );
}

/** 棋盘右下角的行/列身份小图例 */
function PlayerKey() {
  return (
    <div className="land-key">
      <span><i className="k-a" />A 红</span>
      <span><i className="k-b" />B 绿</span>
      <span><i className="k-c" />C 白</span>
    </div>
  );
}

function Landing({ user }: { user: PublicUser | null }) {
  const route = useRoute();
  const go = (to: string) => route.navigate(to);
  return (
    <PageMotion>
      <section className="land-hero">
        <div className="land-copy">
          <h1 className="land-h1">三人四子棋</h1>
          <p className="land-sub">Three-Player Connect Four · 一张棋盘，三人轮流落子</p>
          <p className="land-desc">
            连成四子就能赢？这里不是。Round 6 起，胜权按 C → B → A 轮流授予——只有持胜权的人，
            才能凭自己的本手连成 ≥4 获胜；没有胜权时，连成四子的位置是禁手。
          </p>
          <div className="hero-actions">
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
          <p className="land-more">
            第一次玩？<button className="linklike" onClick={() => go('/rules')}>先看「三人四子棋怎么玩」</button>
            ，一分钟讲清胜权规则。
          </p>
        </div>
        <figure className="land-board">
          <MiniBoardPreview />
          <PlayerKey />
          <figcaption>示意图 · 13×13 正式棋盘（完整规则见「怎么玩」）</figcaption>
        </figure>
      </section>

      {/* 第一层规则：above the fold 速览（登录后的大厅同样提供该入口） */}
      <section className="land-rules" aria-labelledby="howto-heading">
        <div className="land-rules-head">
          <h2 id="howto-heading">三人四子棋怎么玩 · 规则速览</h2>
          <Btn variant="ghost" size="small" onClick={() => go('/rules')}>查看完整规则</Btn>
        </div>
        <RulesQuickView />
        {!user && (
          <div className="land-rules-cta">
            <Btn variant="primary" onClick={() => go('/auth')}>注册并开始新手教程</Btn>
            <span className="muted">三局教学：你在 A 座，两名 AI 对手随局搭配。</span>
          </div>
        )}
      </section>

      <section className="land-modes" aria-label="对局模式">
        <div className="mode-line">
          <span className="m-icon">在线</span>
          <div>
            <h3>Online Match</h3>
            <p>匹配 3 名真人同台竞技；60 秒不足三人自动 AI 补位，结果计入排行榜。</p>
          </div>
          <Btn variant={user ? 'primary' : 'default'} size="small" onClick={() => go(user ? '/online' : '/auth')}>开始</Btn>
        </div>
        <div className="mode-line">
          <span className="m-icon">AI</span>
          <div>
            <h3>Human vs AI</h3>
            <p>1–2 个 AI 对手，难度 ★–★★★★★，用同一套正式规则练手。</p>
          </div>
          <Btn size="small" onClick={() => go('/vsai')}>选择对手</Btn>
        </div>
        <div className="mode-line">
          <span className="m-icon">本地</span>
          <div>
            <h3>Local Match</h3>
            <p>同一设备三人轮流落子，无需账号，随开随玩。</p>
          </div>
          <Btn size="small" onClick={() => go('/local')}>开始对局</Btn>
        </div>
      </section>
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
      <div className="lobby-rules-link">
        <span>
          <b>三人四子棋怎么玩？</b>
          <span className="muted"> · 胜权规则一分钟讲清</span>
        </span>
        <Btn variant="ghost" size="small" onClick={() => route.navigate('/rules')}>规则速览与胜权说明</Btn>
      </div>
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
              <td><b style={{ color: '#a8cdf0' }}>{r.rating}</b></td>
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
const SEAT_COLOR_NAME: Record<Player, string> = { A: '红', B: '绿', C: '白' };

/** 教程教练：根据对局上下文给一行轻量教学提示（progressive/contextual，不弹窗轰炸） */
function makeTutorialCoach(seats: TutorialAssignment) {
  const names: Partial<Record<Player, string>> = {};
  for (const p of PLAYERS) {
    const s = seats[p];
    if (s.kind === 'ai') names[p] = aiDisplayName(s.level ?? 'random');
  }
  return (ctx: CoachContext): string => {
    const { state, round, current, eligible, currentIsAI, thinking } = ctx;
    if (state.status !== 'playing') return '';
    if (currentIsAI) {
      return thinking
        ? `对手 ${current}（AI · ${names[current] ?? ''}）正在思考……`
        : `对手 ${current}（AI · ${names[current] ?? ''}）行动中。`;
    }
    if (round <= 5) {
      const extra =
        round === 5
          ? '下一轮（Round 6）起 C 将获得胜权。'
          : round <= 2
            ? '先落子开阔地带，多留自己的棋型空间。'
            : '留意对手的活三，并提前为自己的胜权轮布局。';
      return `轮到你了（玩家 ${current}）。Round ${round} 暂无胜权——谁都不能靠这一手获胜，会连成 ≥4 的位置是禁手 ✕。${extra}`;
    }
    if (eligible === current) {
      return `轮到你了（玩家 ${current}）——本回合胜权就是你：这一手若能连成 ≥4（横/竖/斜），立即获胜！`;
    }
    return `轮到你了（玩家 ${current}）。本回合胜权：${eligible}——留意 ${eligible} 的连线威胁，也为自己后面的胜权轮布局。`;
  };
}

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
  const route = useRoute();
  const [round, setRound] = useState(0);
  const [lastResult, setLastResult] = useState('');
  const [finished, setFinished] = useState(false);
  // 教程 session 初始化：一次确定真人座位 + 两名 AI 难度（immutable；重渲染不改变）
  const [assignment] = useState<TutorialAssignment>(() => createTutorialAssignment());
  const roles = tutorialRoleLines(assignment);
  const humanSeat = humanSeatOf(assignment);
  const coach = makeTutorialCoach(assignment);
  const assignmentKey = `${assignment.A.kind}:${assignment.B.kind === 'ai' ? assignment.B.level : 'h'}:${assignment.C.kind === 'ai' ? assignment.C.level : 'h'}`;

  if (user.tutorialCompleted) {
    return (
      <div className="pf-page pf-center">
        <h2>教学已完成 ✓</h2>
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={onDone}>进入大厅</button>
          <button className="btn" onClick={() => route.navigate('/rules')}>规则速览与胜权说明</button>
        </div>
      </div>
    );
  }

  if (finished) {
    const opponents = roles.filter((r) => r.role === '对手').map((r) => r.detail).join('、');
    return (
      <div className="pf-page pf-center">
        <h2>教学完成！🎉</h2>
        <p className="muted">三局 1 真人 + 2 AI 练习已完成（胜负不影响积分）。本局你在 {humanSeat} 座，对手：{opponents}。</p>
        <div className="btn-row" style={{ justifyContent: 'center' }}>
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
          <button className="btn" onClick={() => route.navigate('/rules')}>规则速览</button>
        </div>
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
    <div className="pf-page tutorial-page">
      <div className="pf-nav">
        <span className="pf-brand">新手教学 · 三人四子棋</span>
        <span className="muted">
          第 {round + 1} / {TUTORIAL_ROUNDS} 局 · 你在 {humanSeat} 座（执{SEAT_COLOR_NAME[humanSeat]}）
        </span>
        <button className="btn ghost" onClick={() => route.navigate('/rules')}>规则速览</button>
        <button className="btn ghost" onClick={onExit}>返回</button>
      </div>

      <section className="tut-identity" aria-label="本局身份">
        {roles.map((r) => (
          <div key={r.seat} className={`tut-role ${r.role === '你' ? 'you' : 'ai'}`}>
            <span className="tut-role-tag">
              {r.role === '你' ? '你' : `对手`} · 玩家 {r.seat}
            </span>
            <b>{r.detail}</b>
            <span className="muted">{r.role === '你' ? `执${SEAT_COLOR_NAME[r.seat]} · 每次轮到你时由你落子` : '自动行动，与你使用同一套正式规则'}</span>
          </div>
        ))}
        <div className="tut-identity-note">真人座位与两名 AI 难度都在本局开始时随机确定；重开教程会重新随机。</div>
      </section>

      {round === 0 && (
        <details className="tut-rules" open>
          <summary>规则速览 · 一分钟看懂胜权（可收起）</summary>
          <RulesQuickView />
          <div style={{ marginTop: 10 }}>
            <button className="btn ghost tiny" onClick={() => route.navigate('/rules')}>查看完整规则与胜权详解 →</button>
          </div>
        </details>
      )}

      {lastResult && <div className="notice info">{lastResult}</div>}
      <App
        key={`tut-${round}-${assignmentKey}`}
        presetSeats={assignment}
        hostTitle={`新手教学 ${round + 1}/${TUTORIAL_ROUNDS} · 1 真人 + 2 AI`}
        coach={coach}
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

  if (mode === 'local' && !cfg) {
    return <LocalSetup onStart={setCfg} onBack={onExit} />;
  }

  const seats: SeatConfigs =
    cfg ?? { A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'human' } };
  const title = mode === 'local' ? '本地对局 Local Match' : 'Human vs AI · 人机对局';
  return (
    <App
      key={mode === 'local' ? `local-${JSON.stringify(cfg)}` : `vsai-${JSON.stringify(cfg)}`}
      presetSeats={seats}
      hostTitle={title}
      onExit={onExit}
    />
  );
}

/* ---------------- 本地对局设置（Guest 可用：A/B/C 每座选 真人/AI + AI 难度） ---------------- */
function LocalSetup({ onStart, onBack }: { onStart: (s: SeatConfigs) => void; onBack: () => void }) {
  const [draft, setDraft] = useState<LocalDraft>({
    A: { kind: 'human' },
    B: { kind: 'human' },
    C: { kind: 'human' },
  });
  const humanCount = localHumanCount(draft);

  const setKind = (p: Player, kind: 'human' | 'ai') => {
    setDraft((d) => ({ ...d, [p]: kind === 'ai' ? { kind: 'ai', level: 'auto' } : { kind: 'human' } }));
  };
  const setLevel = (p: Player, level: AILevel | 'auto') => {
    setDraft((d) => ({ ...d, [p]: { kind: 'ai', level } }));
  };

  const start = () => {
    // 随机难度在 game initialization 时解析一次（此后稳定）
    onStart(resolveLocalSeats(draft));
  };

  return (
    <div className="pf-panel-wrap">
      <div className="panel pf-panel local-setup">
        <div className="panel-title">本地对局 · 座位与 AI 设置</div>
        <p className="muted">无需账号即可开玩。为 A/B/C 三个座位选择真人或 AI；AI 难度可选随机或 1★–5★（随机在开局时确定）。</p>
        {PLAYERS.map((p) => {
          const d = draft[p];
          const isAI = d.kind === 'ai';
          return (
            <div key={p} className={`seat-row ${isAI ? 'is-ai' : ''}`}>
              <span className="seat-badge" style={{ backgroundColor: p === 'C' ? '#F1F3F6' : PLAYER_COLORS[p], color: p === 'C' ? '#333' : '#fff' }}>
                {p}
              </span>
              <span className="seat-name">玩家 {p}</span>
              <select className="seat-select" value={d.kind} onChange={(e) => setKind(p, e.target.value as 'human' | 'ai')}>
                <option value="human">真人</option>
                <option value="ai">AI</option>
              </select>
              {isAI && (
                <select className="seat-select" value={d.level} onChange={(e) => setLevel(p, e.target.value as AILevel | 'auto')}>
                  <option value="auto">随机</option>
                  {AI_LEVELS.map((l) => (
                    <option key={l} value={l}>AI {AI_LEVEL_STARS[l]}</option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        <p className="muted">{humanCount === 0 ? '⚠️ 至少保留一名真人玩家。' : `${humanCount} 名真人 + ${3 - humanCount} 个 AI。`}</p>
        <div className="btn-row">
          <button className="btn ghost" onClick={onBack}>返回</button>
          <button className="btn primary" disabled={humanCount === 0} onClick={start}>开始对局</button>
        </div>
      </div>
    </div>
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
