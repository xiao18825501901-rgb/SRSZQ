import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
/** 规则 onboarding 内容（两层结构：速览 → 完整规则）与「胜权」详解。
 *  所有规则文案以 shared 引擎为唯一真值：
 *    - shared/src/game/eligibility.ts（R1-5 NONE；R6 起 C→B→A）
 *    - shared/src/game/legalMoves.ts / rules.ts（禁手、本手成四获胜、auto pass）
 *  时间线行由引擎函数生成，杜绝 UI 手写第二套规则。 */
import type { ReactNode } from 'react';
import type { Player } from '../../../shared/src/game/types';
import { ELIGIBLE_ORDER, ELIGIBLE_START_ROUND, PLAYER_COLORS } from '../../../shared/src/game/types';
import { getEligiblePlayer } from '../../../shared/src/game/eligibility';
import { Btn } from '../ui';
import { colorName } from '../playerPresentation';
/* ---------------- 引擎同源时间线 ---------------- */
export interface TimelineRow {
    round: number;
    player: Player | null; // 或 null（无人）
    isStart: boolean; // round === ELIGIBLE_START_ROUND
}
/** 由引擎生成的胜权时间线行（from..to 含两端）—— 测试 TEST3 与 engine 一致性用 */
export function victoryTimelineRows(from: number, to: number): TimelineRow[] {
    const rows: TimelineRow[] = [];
    for (let r = from; r <= to; r++)
        rows.push({ round: r, player: getEligiblePlayer(r), isStart: r === ELIGIBLE_START_ROUND });
    return rows;
}
export function VictoryTimelineTable({ from = 1, to = 14 }: {
    from?: number;
    to?: number;
}) {
    useLocale();
    const rows = victoryTimelineRows(from, to);
    return (<div className="vline">
      <div className="vline-head">
        <span>Round</span>
        {rows.map((r) => (<span key={r.round} className={`vline-rno ${r.isStart ? 'start' : ''}`}>
            {r.round}
          </span>))}
      </div>
      <div className="vline-head">
        <span>{tx("胜权")}</span>
        {rows.map((r) => r.player ? (<span key={r.round} className={`vline-chip ${r.isStart ? 'start' : ''}`} style={{ color: PLAYER_COLORS[r.player] }}>
              {colorName(r.player)}
            </span>) : (<span key={r.round} className="vline-chip none">{tx("无")}</span>))}
      </div>
    </div>);
}
/* ---------------- 第一层：规则速览 ---------------- */
const QUICK_ITEMS: Array<{
    t: string;
    d: ReactNode;
}> = [
    {
        get t() {
            return tx("三名玩家");
        },
        get d() { return (<>{tx("红、绿、白\uFF0C按 红 \u2192 绿 \u2192 白 轮流各落一子\uFF1B一个 Round = 三人各下一手。")}</>); },
    },
    {
        get t() {
            return tx("棋盘");
        },
        get d() { return <>{tx("13\u00D713 或 17\u00D717\uFF1B先在横、竖、斜任一方向连成 \u22654 子的一方获胜。")}</>; },
    },
    {
        get t() {
            return tx("普通四连 \u2260 一定能赢");
        },
        get d() { return (<>{tx("只有当前拥有「胜权」的玩家\uFF0C才能凭自己的本次落子连成 \u22654 子并获胜。")}</>); },
    },
    {
        get t() {
            return tx("没有胜权时");
        },
        get d() { return (<>{tx("不能通过落子形成自己的 \u22654 连\uFF1B那样的位置是禁手\uFF0C落不下去\uFF08会标 \u2715\uFF09。")}</>); },
    },
    {
        get t() {
            return tx("胜权怎么给");
        },
        get d() { return (<>{tx("Round 1\u20135 无人拥有胜权\uFF1BRound {p0} 起按 {p1} 循环\uFF1A 第 {p2} 回合白棋、第 {p3} 回合绿棋、第 {p4} 回合红棋\uFF0C之后一直循环。", { p0: ELIGIBLE_START_ROUND, p1: ELIGIBLE_ORDER.map(colorName).join(' → '), p2: ELIGIBLE_START_ROUND, p3: ELIGIBLE_START_ROUND + 1, p4: ELIGIBLE_START_ROUND + 2 })}</>); },
    },
    {
        get t() {
            return tx("无棋可下");
        },
        get d() { return <>{tx("当前玩家没有任何合法落子时自动 Pass\uFF1B棋盘下满无人获胜则为和棋。")}</>; },
    },
];
export function RulesQuickView() {
    useLocale();
    return (<ul className="howto-quick">
      {QUICK_ITEMS.map((q, i) => (<li key={i}>
          <b>{q.t}</b>
          <span>{q.d}</span>
        </li>))}
    </ul>);
}
/* ---------------- 第二层：胜权详解（七问） ---------------- */
export function VictoryRightSection() {
    useLocale();
    return (<section className="howto-block" aria-labelledby="vr-heading">
      <h3 id="vr-heading">{tx("什么是「胜权」\uFF1F三人四子棋最关键的一条规则")}</h3>
      <ol className="howto-qa">
        <li>
          <b>{tx("\u2460 什么是胜权\uFF1F")}</b>
          <p>{tx("胜权\uFF08Victory Right\uFF09是\u201C当前允许凭落子获胜的资格\u201D。普通四子棋里谁先连成四谁赢\uFF1B 三人四子棋里并非如此\uFF1A只有持有胜权的玩家\uFF0C才能通过自己的本次落子连成 \u22654 并立即获胜。")}</p>
        </li>
        <li>
          <b>{tx("\u2461 谁拥有胜权\uFF1F")}</b>
          <p>{tx("Round 1\u20135\uFF1A无人拥有。Round 6 起按 白 \u2192 绿 \u2192 红 循环\uFF0C一人一轮\uFF1A第 6 回合白棋、第 7 回合绿棋、第 8 回合红棋、 第 9 回合又回到白棋\u2026\u2026\uFF08{p0} 循环\uFF09。", { p0: ELIGIBLE_ORDER.map(colorName).join(' → ') })}</p>
        </li>
        <li>
          <b>{tx("\u2462 什么时候变化\uFF1F")}</b>
          <p>{tx("每过完一个 Round\uFF08三人各下一手\uFF09切换一次。Round 只看\u201C进行到第几轮\u201D\uFF0C与谁赢过无关。")}</p>
        </li>
        <li>
          <b>{tx("\u2463 有胜权时\uFF0C连成四子会怎样\uFF1F")}</b>
          <p>{tx("持胜权的玩家在自己回合落子\uFF0C若这一手使包含新子的横/竖/斜线达到 \u22654\uFF0C立即获胜\uFF084、5、6 连都算\uFF09。")}</p>
        </li>
        <li>
          <b>{tx("\u2464 没有胜权时\uFF0C连成四子会怎样\uFF1F")}</b>
          <p>{tx("不能形成自己的 \u22654 连。这种落点是禁手\uFF1A引擎判定非法\uFF0C点击会被拒绝、棋盘上会显示 \u2715。 所以\u201C提前摆好四颗\u201D是摆不出来的。")}</p>
        </li>
        <li>
          <b>{tx("\u2465 为什么棋盘上已经有三颗/四颗相连\uFF0C却可能没有获胜\uFF1F")}</b>
          <p>{tx("因为胜利只能由\u201C当前合法落子\u201D即时触发\uFF1A过去摆下的连线只是棋型\uFF0C不构成胜利\uFF1B 也不存在\u201C存好四连、等以后有资格了自动赢\u201D。没有胜权时\uFF0C把第四颗放上去本身就是禁手。")}</p>
        </li>
        <li>
          <b>{tx("\u2466 对局中怎么知道当前谁有胜权\uFF1F")}</b>
          <p>{tx("看对局上方的状态栏\u201C本回合胜权\u201D\uFF1A显示白 / 绿 / 红 或\u201C暂无\u201D\uFF1B胜权时间线面板会标出 当前轮与未来 8 轮的胜权安排。轮到谁、谁有胜权是两条独立信息\uFF0C分开显示。")}</p>
        </li>
      </ol>
      <div className="howto-vline-wrap">
        <p className="howto-note">{tx("胜权时间线\uFF08Round 1\u201314\uFF0C{p0} 起进入循环\uFF1B回合数下面的颜色 = 该轮胜权玩家\uFF09\uFF1A", { p0: ELIGIBLE_START_ROUND })}</p>
        <VictoryTimelineTable from={1} to={14}/>
      </div>
    </section>);
}
/* ---------------- 完整规则页内容 ---------------- */
export function HowToPlayContent({ onStartTutorial, onBack }: {
    onStartTutorial?: () => void;
    onBack?: () => void;
}) {
    useLocale();
    return (<div className="howto">
      <header className="howto-head">
        <div>
          <h1>{tx("三人四子棋怎么玩")}</h1>
          <p className="howto-lead">{tx("三名玩家在同一张棋盘上轮流落子。入门只需记住一句话\uFF1A")}<b>{tx("\u201C只有当前拥有胜权的玩家\uFF0C才能凭自己的落子连成四子获胜。\u201D")}</b>
          </p>
        </div>
        {onBack && (<Btn variant="ghost" size="small" onClick={onBack}>{tx("返回")}</Btn>)}
      </header>

      <section className="howto-block" aria-labelledby="quick-heading">
        <h2 id="quick-heading">{tx("规则速览")}</h2>
        <RulesQuickView />
      </section>

      <VictoryRightSection />

      {onStartTutorial && (<div className="howto-cta">
          <Btn variant="primary" size="big" onClick={onStartTutorial}>{tx("开始新手教程\uFF081 真人 + 2 AI 实战教学\uFF09")}</Btn>
          <p className="muted">{tx("一盘教学\uFF1A真人执棋颜色随机\uFF0C两名 AI 对手随机搭配\uFF0C边打边学。")}</p>
        </div>)}
    </div>);
}
