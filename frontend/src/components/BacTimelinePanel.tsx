/** BAC Qualification Timeline Panel —— 现代竞技风格资格时间线（Design System 视觉）。
 *  数据：view 由调用方提供 —— Online/邀请（服务器 WS payload，权威）或
 *  本地/人机（共享引擎 qualificationFromState，同一规则源）。前端不自行推导规则。
 *  展示：CURRENT（当前轮谁持胜权）+ 未来 8 轮（NEXT）窗口；R1-5 显示 VICTORY LOCKED；
 *  玩家视角：Your Victory Window / 他人持权防守提示。移动端可折叠，不遮挡棋盘。 */
import { useEffect, useMemo, useState } from 'react';
import type { GameState, Player } from '../../../shared/src/game/types';
import { ELIGIBLE_ORDER, ELIGIBLE_START_ROUND } from '../../../shared/src/game/types';
import type { QualificationView } from '../../../shared/src/game/qualification';
import { rowsFromView, resolveView, perspectiveLines, seatName, nextWindowHint, type SeatLite } from './bacTimelineModel';

interface Props {
  /** 服务器权威视图（Online Match 必传）；缺省时回退到共享引擎计算 */
  qualification?: QualificationView | null;
  /** 本地/人机模式的引擎状态（在线时也可作为回退） */
  state?: GameState | null;
  /** 自己的座位（Online Match 视角文案用） */
  mySeat?: Player | null;
  seats?: Record<Player, SeatLite> | null;
  ended?: boolean;
  winner?: Player | null;
}

function PlayerOrb({ seat, size = 30 }: { seat: Player | null; size?: number }) {
  if (!seat) {
    return (
      <span
        className="bac-orb none"
        style={{ width: size, height: size, lineHeight: `${size}px`, fontSize: size * 0.42 }}
        title="无人拥有胜权"
      >
        无
      </span>
    );
  }
  return (
    <span
      className={`bac-orb ${seat.toLowerCase()}`}
      style={{ width: size, height: size, lineHeight: `${size}px`, fontSize: size * 0.48 }}
    >
      {seat}
    </span>
  );
}

export function BacTimelinePanel({ qualification, state, mySeat = null, seats = null, ended = false, winner = null }: Props) {
  const view = useMemo(() => resolveView(qualification, state), [qualification, state]);
  const [open, setOpen] = useState(() => (typeof window !== 'undefined' ? window.matchMedia('(min-width: 900px)').matches : true));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 900px)');
    const on = () => setOpen(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  if (!view) return null;
  const rows = rowsFromView(view);
  const eligible = view.currentEligible;
  const locked = eligible === null;
  const perspective = perspectiveLines(mySeat, eligible, seats);
  const hint = locked ? nextWindowHint(view) : null;
  const elName = eligible ? seatName(eligible, seats, mySeat) : '';

  return (
    <section className="bac-panel">
      <header className="bac-head">
        <div>
          <h3 className="bac-title">BAC Victory Timeline</h3>
          <p className="bac-sub">
            胜权资格 · Round {ELIGIBLE_START_ROUND} 起 {ELIGIBLE_ORDER.join(' → ')} 循环
          </p>
        </div>
        {ended && <span className="bac-tag ended">ENDED</span>}
      </header>

      <div className={`bac-now ${locked ? 'locked' : ''} ${perspective?.yours ? 'yours' : ''}`}>
        <div className="bac-now-flag">CURRENT · ROUND {view.currentRound}</div>
        <div className="bac-now-body">
          <PlayerOrb seat={eligible} size={44} />
          <div className="bac-now-info">
            <div className="bac-holder-line">
              {locked ? (
                <>
                  <b>No one</b>
                  <span className="bac-pill">VICTORY LOCKED</span>
                </>
              ) : (
                <>
                  <b className={`holder-${eligible!.toLowerCase()}`}>{elName}</b>
                  <span className="bac-pill win">Victory Right</span>
                </>
              )}
            </div>
            <div className="bac-now-note">
              {locked
                ? hint
                  ? `下次胜权窗口：Round ${hint.round} · ${hint.player}`
                  : 'Round 1–5：无人拥有胜权，成四即禁手'
                : eligible === mySeat
                  ? 'You can legally win on your turn.'
                  : 'Forming 4+ is forbidden for others.'}
            </div>
          </div>
        </div>
        {perspective && (
          <div className={`bac-window ${perspective.yours ? 'yours' : ''}`}>
            {perspective.yours && <span className="bac-window-star">★ YOUR VICTORY WINDOW</span>}
            <span className="bac-window-en">{perspective.en}</span>
            <span className="bac-window-zh">{perspective.zh}</span>
          </div>
        )}
        {ended && winner && (
          <div className="bac-ended-note">对局结束 · 胜者 {winner}</div>
        )}
      </div>

      <div className="bac-next-head">
        <span>NEXT · FUTURE {rows.length - 1} ROUNDS</span>
        <button type="button" className="bac-collapse-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? '收起 ▴' : '展开 ▾'}
        </button>
      </div>

      <div className={`bac-rows ${open ? 'open' : ''}`}>
        {rows.map((r) => {
          const isYou = mySeat != null && r.player === mySeat;
          return (
            <div key={r.round} className={`bac-row ${r.isNow ? 'now' : ''} ${r.isNext ? 'next' : ''} ${isYou ? 'you' : ''}`}>
              <span className="bac-rno">R{r.round}</span>
              {r.isNow ? (
                <span className="bac-flag now">NOW</span>
              ) : r.isNext ? (
                <span className="bac-flag next">NEXT</span>
              ) : (
                <span className="bac-flag blank" />
              )}
              <PlayerOrb seat={r.player} size={24} />
              <span className="bac-pname">{r.player ? seatName(r.player, seats, mySeat) : '无人'}</span>
              {isYou && <span className="bac-you">YOU</span>}
            </div>
          );
        })}
      </div>

      <footer className="bac-foot">
        Round 1–5 无人拥有胜权（任何 ≥4 连落子都是禁手）；持胜权者凭本手成四即胜。资格按 Round 自动推进，与服务器/引擎实时同步。
      </footer>
    </section>
  );
}
