import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
import type { Player } from '../../../shared/src/game/types';
import { AI_LEVELS, AI_LEVEL_STARS, type AILevel, type SeatConfigs } from '../../../shared/src/ai/types';
import { canSetAISeat, countAI, isAISeat, seatLevel } from '../../../shared/src/ai/seats';
import { PLAYER_COLOR_NAMES } from '../playerPresentation';
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
    if (c === 'human')
        return tx("人类 HUMAN");
    return `AI ${AI_LEVEL_STARS[c]}`;
}
/**
 * SRSZQ AI 座位设置（正式规则 v2：一套资格规则）。
 * 每座位 6 选 1：人类 / AI★~★★★★★（星级对应概率计策画像）。
 * 约束：至少 1 人类，至多 2 AI（禁止三 AI 对弈）。
 */
export function SeatSetup({ seats, disabled, onChange }: Props) {
    useLocale();
    const aiCount = countAI(seats);
    return (<div className="setup-block seat-setup">
      <div className="setup-label">{tx("AI 座位 \u00B7 Seat Mode")}</div>
      <div className="seat-rows">
        {(['A', 'B', 'C'] as Player[]).map((p) => {
            const isAI = isAISeat(seats, p);
            const value: SeatChoice = isAI ? seatLevel(seats, p) : 'human';
            return (<div key={p} className={`seat-row seat-${p.toLowerCase()} ${isAI ? 'is-ai' : ''}`}>
              <span className="seat-badge">
                {p}
              </span>
              <span className="seat-name">{tx("玩家 ")}{p}
                <span className="muted"> · {PLAYER_COLOR_NAMES[p]}</span>
              </span>
              <select className="seat-select" aria-label={tx("玩家 {p0} 的座位类型与 AI 难度", { p0: p })} disabled={disabled} value={value} onChange={(e) => onChange(p, e.target.value === 'human' ? 'human' : Number(e.target.value) as AILevel)}>
                {CHOICES.map((c) => {
                    // 当前已是 AI 的座位可自由换档；人类座位想变 AI 需 <2 AI
                    const blocked = c !== 'human' && !isAI && !canSetAISeat(seats, p);
                    return (<option key={c} value={c} disabled={blocked}>
                      {choiceLabel(c)}
                      {blocked ? tx("\uFF08已达 2 AI 上限\uFF09") : ''}
                    </option>);
                })}
              </select>
            </div>);
        })}
      </div>
      <p className="muted">{tx("当前\uFF1A{p0}。 规则要求至少 1 名人类玩家\uFF08最多 2 个 AI\uFF09。AI 与人类共享同一套引擎规则\uFF1A无资格成四 = 禁手\uFF0C 获得胜权的回合成四 = 获胜\uFF1BAI 永远只落引擎判定的合法点。", { p0: aiCount === 0 ? tx("全人类对弈\uFF08默认\uFF09") : tx("{p0} 个 AI 座位 \u00B7 {p1} 个人类座位", { p0: aiCount, p1: 3 - aiCount }) })}</p>
    </div>);
}
