import type { Player } from '../../../shared/src/game/types';
import { PLAYER_COLORS, PLAYER_LABELS } from '../../../shared/src/game/types';
import { AI_LEVELS, AI_LEVEL_STARS, type AILevel, type SeatConfigs } from '../../../shared/src/ai/types';
import { canSetAISeat, countAI, isAISeat, seatLevel } from '../../../shared/src/ai/seats';

/** 每座位可选值：人类 + 五档 AI = 每座位六种选择 */
export type SeatChoice = 'human' | AILevel;

interface Props {
  seats: SeatConfigs;
  disabled?: boolean;
  onChange: (player: Player, choice: SeatChoice) => void;
}

const CHOICES: SeatChoice[] = ['human', ...AI_LEVELS];

/** 平台规范：AI 只以星级呈现，绝不向用户显示真实档位名 */
function choiceLabel(c: SeatChoice): string {
  if (c === 'human') return '人类 HUMAN';
  return `AI ${AI_LEVEL_STARS[c]}`;
}

/**
 * SRSZQ AI 座位设置（正式规则 v2：一套资格规则）。
 * 每座位 6 选 1：人类 / AI★~★★★★★（内部映射 Random…MaxN）。
 * 约束：至少 1 人类，至多 2 AI（禁止三 AI 对弈）。
 */
export function SeatSetup({ seats, disabled, onChange }: Props) {
  const aiCount = countAI(seats);
  return (
    <div className="setup-block seat-setup">
      <div className="setup-label">AI 座位 · Seat Mode</div>
      <div className="seat-rows">
        {(['A', 'B', 'C'] as Player[]).map((p) => {
          const isAI = isAISeat(seats, p);
          const value: SeatChoice = isAI ? seatLevel(seats, p) : 'human';
          return (
            <div key={p} className={`seat-row ${isAI ? 'is-ai' : ''}`}>
              <span className="seat-badge" style={{ backgroundColor: p === 'C' ? '#F7F7F7' : PLAYER_COLORS[p], color: p === 'C' ? '#333' : '#fff' }}>
                {p}
              </span>
              <span className="seat-name">
                玩家 {p}
                <span className="muted"> · {PLAYER_LABELS[p]}</span>
              </span>
              <select
                className="seat-select"
                disabled={disabled}
                value={value}
                onChange={(e) => onChange(p, e.target.value as SeatChoice)}
              >
                {CHOICES.map((c) => {
                  // 当前已是 AI 的座位可自由换档；人类座位想变 AI 需 <2 AI
                  const blocked = c !== 'human' && !isAI && !canSetAISeat(seats, p);
                  return (
                    <option key={c} value={c} disabled={blocked}>
                      {choiceLabel(c)}
                      {blocked ? '（已达 2 AI 上限）' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          );
        })}
      </div>
      <p className="muted">
        当前：{aiCount === 0 ? '全人类对弈（默认）' : `${aiCount} 个 AI 座位 · ${3 - aiCount} 个人类座位`}。
        规则要求至少 1 名人类玩家（最多 2 个 AI）。AI 与人类共享同一套引擎规则：无资格成四 = 禁手，
        获得胜权的回合成四 = 获胜；AI 永远只落引擎判定的合法点。
      </p>
    </div>
  );
}
