/** SRSZQ 在线对战页：排队（倒计时）→ 对局（服务器权威渲染） → 结算。
 *  状态统一来自全局 gameLink（好友邀请开局也会自动进入本页）。
 *
 *  Online Match 离开机制：
 *  - 对局中提供 Leave Match 按钮 → 确认弹窗 → PLAYER_RESIGN → 服务器立即判负结算；
 *  - 关标签/刷新/断网 = 掉线 → 服务器 10s 宽限（DISCONNECTED_TEMPORARY）→ 超时判负；
 *  - 宽限内返回自动恢复本局（queue.join/resume 服务端续局），其他人收到 player.status 提示。
 *  胜负文案由服务器 MATCH_ENDED 的 reason + loser/winner 座位推导（服务器权威）。 */
import { useEffect, useRef, useState } from 'react';
import type { Player } from '../../../shared/src/game/types';
import { PLAYER_COLORS } from '../../../shared/src/game/types';
import { getEligiblePlayer } from '../../../shared/src/game/eligibility';
import { Board } from '../components/Board';
import { BacTimelinePanel } from '../components/BacTimelinePanel';
import { gameLink } from '../ws';
import { currentPlayerOf } from '../../../shared/src/game/legalMoves';
import { Btn } from '../ui';
import { Modal } from '../components/Modal';

export function OnlinePage({ user, onExit }: { user: { username: string }; onExit: () => void }) {
  const [, force] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [confirmLeave, setConfirmLeave] = useState(false);
  const joinedRef = useRef(false);

  // 跟随全局状态
  useEffect(() => gameLink.subscribe(() => force((x) => x + 1)), []);
  // 倒计时刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const phase = gameLink.phase;
  const remaining = Math.max(0, Math.ceil(gameLink.remainingMs() / 1000));

  useEffect(() => {
    gameLink.attach();
    // 若是从邀请/大厅被带入的已开对局，无需重新入队；
    // 掉线宽限内回来 → queue.join 由服务端自动恢复原局
    if (gameLink.phase === 'idle' && !joinedRef.current) {
      joinedRef.current = true;
      gameLink.joinQueue();
    }
    return () => {
      // 离开页面时退出队列（对局中离开需走 Leave Match 确认，见下方按钮）
      if (gameLink.phase === 'queue') gameLink.leaveQueue();
    };
  }, []);

  const exit = () => {
    if (gameLink.phase === 'queue') gameLink.leaveQueue();
    gameLink.reset();
    setConfirmLeave(false);
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

  // 掉线/重连横幅（他人视角提示；掉线宽限期间对局暂停推进）
  const seatEvent = gameLink.seatStatus;
  const banner = seatEvent && gameLink.phase === 'game' ? (
    seatEvent.status === 'disconnected' ? (
      <p className="notice pass">
        {seatLabel(seatEvent.seat)} 掉线了 — {Math.max(1, Math.round((seatEvent.graceMs ?? 10000) / 1000))} 秒内未返回将判负（本局暂停等待）
      </p>
    ) : (
      <p className="notice info">{seatLabel(seatEvent.seat)} 已重连，对局继续</p>
    )
  ) : null;

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
        <p className="muted">对局中离开（含关闭页面/断网超过 10 秒）将判负并计入排行榜。</p>
        {gameLink.error && <p className="error-text">{gameLink.error}</p>}
        <button className="btn" onClick={exit}>取消并返回</button>
      </div>
    );
  }

  if (phase === 'end' || !gameLink.game) {
    const g = gameLink.game;
    const info = gameLink.endInfo;
    const mySeat = g?.mySeat ?? 'A';
    const ranked = g?.mode === 'online';
    let headline = '对局结束';
    let verdict = gameLink.result;
    let detail = '';
    if (info && g) {
      const iLost = info.loserSeats.includes(mySeat);
      const iWon = info.winnerSeats.includes(mySeat);
      if (info.reason === 'PLAYER_FORFEIT' || info.reason === 'PLAYER_DISCONNECT') {
        headline = iLost ? 'You left the match.' : 'Opponent left.';
        verdict = iLost ? 'Result: Loss' : 'You win!';
        detail = info.reason === 'PLAYER_DISCONNECT' && iLost ? 'You did not return within the grace period. This match counts as a loss.' : '';
        if (!iLost) detail = `${seatLabel(info.loserSeats[0] ?? 'A')} left the match.`;
      } else if (info.status === 'draw') {
        headline = '和棋';
        verdict = 'Draw';
      } else if (iWon) {
        headline = '你赢了';
        verdict = `Winner: ${mySeat}`;
        detail = 'You won this match!';
      } else {
        headline = '对局结束';
        verdict = info.winnerSeats.length > 0 ? `玩家 ${info.winnerSeats[0]} 获胜` : 'AI 获胜';
        detail = '';
      }
    }
    return (
      <div className="panel pf-panel matchmaking-card">
        <div className="mm-icon">🏁</div>
        <h2>{headline}</h2>
        <p style={{ fontSize: 20, fontWeight: 700 }}>{verdict}</p>
        {detail && <p className="muted">{detail}</p>}
        {ranked && <p className="muted">在线对局结果已计入排行榜。</p>}
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          {ranked && (
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
          )}
          <button className={ranked ? 'btn' : 'btn primary'} onClick={exit}>返回大厅</button>
        </div>
      </div>
    );
  }

  const g = gameLink.game;
  void now;
  const isOnline = g.mode !== 'invite';
  return (
    <div className="online-game">
      <div className="pf-nav">
        <span className="pf-brand">SRSZQ · Online</span>
        <span className="muted">
          {isOnline ? '在线对局' : '好友对局'} · 你是 玩家 {g.mySeat}
        </span>
        {isOnline ? (
          // Online Match：唯一退出入口 = Leave Match（需确认；判负）
          <Btn variant="danger" size="small" onClick={() => setConfirmLeave(true)} style={{ marginLeft: 'auto' }}>
            Leave Match
          </Btn>
        ) : (
          // 好友局：离开不判负（服务端断线自动跳过/中止）
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={exit}>离开</button>
        )}
      </div>
      <Modal open={confirmLeave} title="Leave Match" onClose={() => setConfirmLeave(false)} footer={
        <>
          <Btn variant="ghost" onClick={() => setConfirmLeave(false)}>Cancel</Btn>
          <Btn variant="danger" onClick={() => { setConfirmLeave(false); gameLink.resign(); }}>Confirm Leave</Btn>
        </>
      }>
        <p style={{ margin: '4px 0 10px', lineHeight: 1.7 }}>
          Are you sure you want to leave? Leaving will count as a loss.
        </p>
        <p className="muted" style={{ lineHeight: 1.7 }}>本局将立即结束并按失败计入你的排行榜记录；其他在线玩家将获得胜利。</p>
      </Modal>
      {banner}
      <div className="statusbar">
        <div className="status-item">
          <span className="status-label">Round</span>
          <span className="status-value big">{Math.floor(g.state.turnIndex / 3) + 1}</span>
        </div>
        <div className="status-item">
          <span className="status-label">当前回合</span>
          <span className="status-value">{`${currentPlayerOf(g.state)}${myTurn ? '（轮到你）' : ''}`}</span>
        </div>
        <div className="status-item">
          <span className="status-label">本回合胜权</span>
          {(() => {
            const q = g.qualification;
            const eligible: Player | null =
              q && q.currentRound === Math.floor(g.state.turnIndex / 3) + 1
                ? q.currentEligible
                : getEligiblePlayer(Math.floor(g.state.turnIndex / 3) + 1);
            return eligible ? (
              <span className="status-value big eligible-badge" style={{ borderColor: PLAYER_COLORS[eligible], color: PLAYER_COLORS[eligible] }}>
                玩家 {eligible}
              </span>
            ) : (
              <span className="status-value none-badge">暂无（R1–5）</span>
            );
          })()}
          <span className="etip">
            <button type="button" className="etip-q" aria-label="什么是胜权">?</button>
            <span className="etip-pop" role="tooltip">
              只有持「胜权」的玩家能凭自己的本手连成 ≥4 获胜。Round 1–5 无人持权；Round 6 起按 C → B → A 循环（R6=C · R7=B · R8=A）。
            </span>
          </span>
        </div>
        {(['A', 'B', 'C'] as Player[]).map((p) => (
          <div key={p} className={`status-item ${p === g.mySeat ? 'mine' : ''}`}>
            <span className="status-label">{p === g.mySeat ? '你' : p}</span>
            <span className="status-value small">{seatLabel(p)}</span>
          </div>
        ))}
      </div>
      <div className="online-layout">
        <section className="online-board-col">
          {gameLink.error && <p className="error-text">{gameLink.error}</p>}
          <Board state={g.state} showLegal={myTurn} showWinning={false} onCellClick={clickCell} />
        </section>
        <aside>
          {/* BAC 资格时间线：视图来自服务器每帧广播的 qualification（权威），断线重连后由 game.start 恢复 */}
          <BacTimelinePanel
            qualification={g.qualification ?? null}
            state={g.state}
            mySeat={g.mySeat}
            seats={g.seats}
            ended={g.state.status !== 'playing'}
            winner={g.state.winner}
          />
        </aside>
      </div>
    </div>
  );
}
