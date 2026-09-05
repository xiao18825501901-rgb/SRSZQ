import { ELIGIBLE_ORDER, PLAYER_COLORS } from '../game/types';
import { getEligiblePlayer } from '../game/eligibility';

interface Props {
  currentRound: number;
  /** 若游戏已结束可以传 null，展示仍以最后轮次为准 */
  highlightRound: number;
}

function EligibleChip({ round }: { round: number }) {
  const p = getEligiblePlayer(round);
  if (!p) {
    return (
      <span className="tl-chip none">
        R{round} <b>—</b>
      </span>
    );
  }
  return (
    <span className="tl-chip" style={{ borderColor: PLAYER_COLORS[p] }}>
      R{round} <b style={{ color: PLAYER_COLORS[p] }}>{p}</b>
    </span>
  );
}

/**
 * 资格时间轴（正式规则 v2）：上一轮 / 当前轮（高亮）/ 未来轮次。
 * R1-5 无胜权；R6 起按 C → B → A 循环。
 */
export function QualificationTimeline({ currentRound, highlightRound }: Props) {
  const from = Math.max(1, currentRound - 1);
  const to = currentRound + 5;
  const rounds: number[] = [];
  for (let r = from; r <= to; r++) rounds.push(r);

  return (
    <div className="timeline">
      <div className="timeline-title">
        资格时间轴{' '}
        <span className="timeline-schedule">
          R6 起 {ELIGIBLE_ORDER.join(' → ')} 循环
        </span>
      </div>
      <div className="timeline-row">
        {rounds.map((r) => {
          const isNow = r === highlightRound;
          return (
            <div key={r} className={`tl-item ${isNow ? 'now' : ''}`}>
              {isNow && <span className="tl-now-tag">← NOW</span>}
              <EligibleChip round={r} />
            </div>
          );
        })}
      </div>
      <div className="timeline-note">
        Round 1–5 无人拥有胜权；从 R6 起按 C → B → A 循环授予。非资格玩家禁手（不可成四连）。
      </div>
    </div>
  );
}
