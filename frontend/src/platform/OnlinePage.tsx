/** SRSZQ 在线对战页：排队（倒计时）→ 对局（服务器权威渲染） → 结算。
 *  状态统一来自全局 gameLink（好友邀请开局也会自动进入本页）。 */
import { useEffect, useRef, useState } from 'react';
import type { Player } from '../../../shared/src/game/types';
import { Board } from '../components/Board';
import { gameLink } from '../ws';
import { currentPlayerOf } from '../../../shared/src/game/legalMoves';

export function OnlinePage({ user, onExit }: { user: { username: string }; onExit: () => void }) {
  const [, force] = useState(0);
  const [now, setNow] = useState(Date.now());
  const joinedRef = useRef(false);

  // 跟随全局状态
  useEffect(() => gameLink.subscribe(() => force((x) => x + 1)), []);
  // 倒计时刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const phase = gameLink.phase;
  const remaining = Math.max(0, Math.ceil((gameLink.remainingMs()) / 1000));

  useEffect(() => {
    gameLink.attach();
    // 若是从邀请/大厅被带入的已开对局，无需重新入队
    if (gameLink.phase === 'idle' && !joinedRef.current) {
      joinedRef.current = true;
      gameLink.joinQueue();
    }
    return () => {
      // 离开页面时退出队列（对局中离开视为放弃，由服务端处理）
      if (gameLink.phase === 'queue') gameLink.leaveQueue();
    };
  }, []);

  const exit = () => {
    if (gameLink.phase === 'queue') gameLink.leaveQueue();
    gameLink.reset();
    onExit();
  };

  const myTurn = gameLink.game?.state.status === 'playing' && currentPlayerOf(gameLink.game.state) === gameLink.game.mySeat;

  const clickCell = (row: number, col: number) => {
    if (!myTurn) return;
    gameLink.move(row, col);
  };

  const seatLabel = (p: Player): string => {
    const s = gameLink.game?.seats[p];
    if (!s) return '';
    return s.kind === 'human' ? `玩家 ${p} · ${s.username ?? ''}` : `AI ${'★'.repeat(s.stars ?? 1)}`;
  };

  if (phase === 'queue' || phase === 'idle') {
    const searching = remaining > 40;
    return (
      <div className="panel pf-panel matchmaking-card">
        <div className="mm-icon">{searching ? '🔍' : '⚔️'}</div>
        <h2>{searching ? 'Searching players…' : '即将匹配完成'}</h2>
        <p>
          {user.username} 正在寻找对手 · 当前等待 {gameLink.waiting || 1} 人
        </p>
        <div className="mm-timer">{remaining}s</div>
        <div className="mm-bar">
          <div className="mm-bar-fill" style={{ width: `${Math.max(0, Math.min(100, (remaining / 60) * 100))}%` }} />
        </div>
        <p className="muted">60 秒内不足 3 名真人时，将由 AI 补位自动开局（1 人 → 2 AI，2 人 → 1 AI）。</p>
        {gameLink.error && <p className="error-text">{gameLink.error}</p>}
        <button className="btn" onClick={exit}>取消并返回</button>
      </div>
    );
  }

  if (phase === 'end' || !gameLink.game) {
    return (
      <div className="panel pf-panel matchmaking-card">
        <div className="mm-icon">🏁</div>
        <h2>{gameLink.result}</h2>
        <p className="muted">在线对局结果已计入排行榜。</p>
        <div className="btn-row">
          <button
            className="btn primary"
            onClick={() => {
              gameLink.reset();
              gameLink.attach();
              joinedRef.current = true;
              gameLink.joinQueue();
            }}
          >
            再来一局
          </button>
          <button className="btn" onClick={exit}>返回大厅</button>
        </div>
      </div>
    );
  }

  const g = gameLink.game;
  void now;
  return (
    <div className="online-game">
      <div className="pf-nav">
        <span className="pf-brand">SRSZQ · Online</span>
        <span className="muted">
          {g.mode === 'invite' ? '好友对局' : '在线对局'} · 你是 玩家 {g.mySeat}
        </span>
        <button className="btn ghost" onClick={exit}>离开</button>
      </div>
      <div className="statusbar">
        <div className="status-item">
          <span className="status-label">Round</span>
          <span className="status-value big">{Math.floor(g.state.turnIndex / 3) + 1}</span>
        </div>
        <div className="status-item">
          <span className="status-label">当前回合</span>
          <span className="status-value">{`${currentPlayerOf(g.state)}${myTurn ? '（轮到你）' : ''}`}</span>
        </div>
        {(['A', 'B', 'C'] as Player[]).map((p) => (
          <div key={p} className={`status-item ${p === g.mySeat ? 'mine' : ''}`}>
            <span className="status-label">{p === g.mySeat ? '你' : p}</span>
            <span className="status-value small">{seatLabel(p)}</span>
          </div>
        ))}
      </div>
      {gameLink.error && <p className="error-text">{gameLink.error}</p>}
      <Board state={g.state} showLegal={myTurn} showWinning={false} onCellClick={clickCell} />
    </div>
  );
}
