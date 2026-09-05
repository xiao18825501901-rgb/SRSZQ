/** SRSZQ 在线对战页：排队 → 对局（服务器权威状态渲染） → 结算 */
import { useEffect, useRef, useState } from 'react';
import type { Player } from '../../../shared/src/game/types';
import type { GameState } from '../../../shared/src/game/types';
import { Board } from '../components/Board';
import { getSocket } from '../ws';
import { currentPlayerOf } from '../../../shared/src/game/legalMoves';

interface SeatView {
  kind: 'human' | 'ai';
  username?: string;
  stars?: number;
}

export function OnlinePage({ user, onExit }: { user: { id: string; username: string }; onExit: () => void }) {
  const [phase, setPhase] = useState<'queue' | 'game' | 'end'>('queue');
  const [waiting, setWaiting] = useState(0);
  const [gameId, setGameId] = useState('');
  const [seats, setSeats] = useState<Record<Player, SeatView>>();
  const [mySeat, setMySeat] = useState<Player>('A');
  const [state, setState] = useState<GameState | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const joinedRef = useRef(false);

  useEffect(() => {
    const sock = getSocket();
    const off = sock.on((msg) => {
      switch (msg.type) {
        case 'hello': {
          if (!joinedRef.current) {
            joinedRef.current = true;
            sock.send({ type: 'queue.join' });
          }
          break;
        }
        case 'queue.joined':
          setWaiting(msg.waiting ?? 0);
          break;
        case 'queue.left':
          break;
        case 'error':
          setError(String(msg.error ?? 'unknown'));
          if (/tutorial/i.test(String(msg.error ?? ''))) onExit();
          break;
        case 'game.start': {
          setPhase('game');
          setGameId(String(msg.gameId));
          setSeats(msg.seats as Record<Player, SeatView>);
          setMySeat(msg.yourSeat as Player);
          setState(msg.state as GameState);
          setError('');
          break;
        }
        case 'game.state':
          setState(msg.state as GameState);
          break;
        case 'game.end': {
          setPhase('end');
          setResult(msg.status === 'aborted' ? '对局已中止（玩家离开）' : msg.winner ? `玩家 ${msg.winner} 获胜` : '和棋');
          joinedRef.current = false;
          break;
        }
      }
    });
    sock.connect();
    return () => {
      off();
      sock.send({ type: 'queue.leave' });
      joinedRef.current = false;
    };
  }, [onExit]);

  const myTurn = state?.status === 'playing' && currentPlayerOf(state) === mySeat;

  const clickCell = (row: number, col: number) => {
    if (!myTurn) return;
    getSocket().send({ type: 'move', row, col });
  };

  const seatLabel = (p: Player): string => {
    const s = seats?.[p];
    if (!s) return '';
    return s.kind === 'human' ? `玩家 ${p} · ${s.username ?? ''}` : `AI ${'★'.repeat(s.stars ?? 1)}`;
  };

  if (phase === 'queue') {
    return (
      <div className="panel pf-panel pf-center">
        <h2>在线匹配 Online Match</h2>
        <p>
          玩家 {user.username} 正在排队… 当前等待 {waiting || 1} 人（60 秒内不足 3 真人将由 AI 补位）。
        </p>
        <div className="spinner" />
        {error && <p className="error-text">{error}</p>}
        <button className="btn" onClick={onExit}>取消并返回</button>
      </div>
    );
  }

  if (phase === 'end') {
    return (
      <div className="panel pf-panel pf-center">
        <h2>{result}</h2>
        <p className="muted">在线对局结果已计入排行榜。</p>
        <div className="btn-row">
          <button className="btn primary" onClick={() => { setPhase('queue'); joinedRef.current = false; getSocket().send({ type: 'queue.join' }); }}>
            再来一局
          </button>
          <button className="btn" onClick={onExit}>返回大厅</button>
        </div>
      </div>
    );
  }

  return (
    <div className="online-game">
      <div className="pf-nav">
        <span className="pf-brand">SRSZQ · Online</span>
        <span className="muted">
          对局 {gameId.slice(0, 8)} · 你是 玩家 {mySeat}
        </span>
        <button className="btn ghost" onClick={onExit}>离开</button>
      </div>
      <div className="statusbar">
        <div className="status-item">
          <span className="status-label">Round</span>
          <span className="status-value big">{state ? Math.floor(state.turnIndex / 3) + 1 : '—'}</span>
        </div>
        <div className="status-item">
          <span className="status-label">当前回合</span>
          <span className="status-value">{state ? `${currentPlayerOf(state)}${myTurn ? '（轮到你）' : ''}` : '—'}</span>
        </div>
        {(['A', 'B', 'C'] as Player[]).map((p) => (
          <div key={p} className={`status-item ${p === mySeat ? 'mine' : ''}`}>
            <span className="status-label">{p === mySeat ? '你' : p}</span>
            <span className="status-value small">{seatLabel(p)}</span>
          </div>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      {state && (
        <Board state={state} showLegal={myTurn} showWinning={false} onCellClick={clickCell} />
      )}
    </div>
  );
}
