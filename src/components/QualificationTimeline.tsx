import type { Schedule } from '../game/types';
import { SCHEDULE_LABELS } from '../game/types';
import { getEligiblePlayer } from '../game/eligibility';
import { PLAYER_COLORS } from '../game/types';

interface Props {
  schedule: Schedule;
  currentRound: number;
  /** 若游戏已结束可以传 null，展示仍以最后轮次为准 */
  highlightRound: number;
}

function EligibleChip({ round, schedule }: { round: number; schedule: Schedule }) {
  const p = getEligiblePlayer(round, schedule);
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
 * 资格时间轴：上一轮 / 当前轮（高亮）/ 未来 5 轮。
 * CBACC 周期较长，此视图帮助玩家看清接下来的胜权归属。
 */
export function QualificationTimeline({ schedule, currentRound, highlightRound }: Props) {
  const from = Math.max(1, currentRound - 1);
  const to = currentRound + 5;
  const rounds: number[] = [];
  for (let r = from; r <= to; r++) rounds.push(r);

  return (
    <div className="timeline">
      <div className="timeline-title">
        资格时间轴 <span className="timeline-schedule">{schedule} · {SCHEDULE_LABELS[schedule]}</span>
      </div>
      <div className="timeline-row">
        {rounds.map((r) => {
          const isNow = r === highlightRound;
          return (
            <div key={r} className={`tl-item ${isNow ? 'now' : ''}`}>
              {isNow && <span className="tl-now-tag">← NOW</span>}
              <EligibleChip round={r} schedule={schedule} />
            </div>
          );
        })}
      </div>
      <div className="timeline-note">Round 1–3 无人拥有胜权；从 R4 起按周期授予。非资格玩家禁手（不可成四连）。</div>
    </div>
  );
}
