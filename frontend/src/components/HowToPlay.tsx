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

/* ---------------- 引擎同源时间线 ---------------- */

export interface TimelineRow {
  round: number;
  player: Player | null; // 或 null（无人）
  isStart: boolean; // round === ELIGIBLE_START_ROUND
}

/** 由引擎生成的胜权时间线行（from..to 含两端）—— 测试 TEST3 与 engine 一致性用 */
export function victoryTimelineRows(from: number, to: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (let r = from; r <= to; r++) rows.push({ round: r, player: getEligiblePlayer(r), isStart: r === ELIGIBLE_START_ROUND });
  return rows;
}

export function VictoryTimelineTable({ from = 1, to = 14 }: { from?: number; to?: number }) {
  const rows = victoryTimelineRows(from, to);
  return (
    <div className="vline">
      <div className="vline-head">
        <span>Round</span>
        {rows.map((r) => (
          <span key={r.round} className={`vline-rno ${r.isStart ? 'start' : ''}`}>
            {r.round}
          </span>
        ))}
      </div>
      <div className="vline-head">
        <span>胜权</span>
        {rows.map((r) =>
          r.player ? (
            <span key={r.round} className={`vline-chip ${r.isStart ? 'start' : ''}`} style={{ color: PLAYER_COLORS[r.player] }}>
              {r.player}
            </span>
          ) : (
            <span key={r.round} className="vline-chip none">—</span>
          ),
        )}
      </div>
    </div>
  );
}

/* ---------------- 第一层：规则速览 ---------------- */

const QUICK_ITEMS: Array<{ t: string; d: ReactNode }> = [
  {
    t: '三名玩家',
    d: (
      <>
        A（红）· B（绿）· C（白），按 A → B → C 轮流各落一子；一个 Round = 三人各下一手。
      </>
    ),
  },
  {
    t: '棋盘',
    d: <>13×13 或 17×17；先在横、竖、斜任一方向连成 ≥4 子的一方获胜。</>,
  },
  {
    t: '普通四连 ≠ 一定能赢',
    d: (
      <>
        只有当前拥有「胜权」的玩家，才能凭自己的本次落子连成 ≥4 子并获胜。
      </>
    ),
  },
  {
    t: '没有胜权时',
    d: (
      <>
        不能通过落子形成自己的 ≥4 连——那样的位置是禁手，落不下去（会标 ✕）。
      </>
    ),
  },
  {
    t: '胜权怎么给',
    d: (
      <>
        Round 1–5 无人拥有胜权；Round {ELIGIBLE_START_ROUND} 起按 {ELIGIBLE_ORDER.join(' → ')} 循环：
        R{ELIGIBLE_START_ROUND}=C、R{ELIGIBLE_START_ROUND + 1}=B、R{ELIGIBLE_START_ROUND + 2}=A，之后一直循环。
      </>
    ),
  },
  {
    t: '无棋可下',
    d: <>当前玩家没有任何合法落子时自动 Pass；棋盘下满无人获胜则为和棋。</>,
  },
];

export function RulesQuickView() {
  return (
    <ul className="howto-quick">
      {QUICK_ITEMS.map((q) => (
        <li key={q.t}>
          <b>{q.t}</b>
          <span>{q.d}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------- 第二层：胜权详解（七问） ---------------- */

export function VictoryRightSection() {
  return (
    <section className="howto-block" aria-labelledby="vr-heading">
      <h3 id="vr-heading">什么是「胜权」？—— SRSZQ 最关键的一条规则</h3>
      <ol className="howto-qa">
        <li>
          <b>① 什么是胜权？</b>
          <p>
            胜权（Victory Right）是“当前允许凭落子获胜的资格”。普通四子棋里谁先连成四谁赢；
            三人四子棋里不是这样——只有持有胜权的玩家，才能通过自己的本次落子连成 ≥4 并立即获胜。
          </p>
        </li>
        <li>
          <b>② 谁拥有胜权？</b>
          <p>
            Round 1–5：无人拥有。Round 6 起按 C → B → A 循环，一人一轮：R6 是 C、R7 是 B、R8 是 A、
            R9 又回到 C……（{ELIGIBLE_ORDER.join(' → ')} 循环）。
          </p>
        </li>
        <li>
          <b>③ 什么时候变化？</b>
          <p>
            每过完一个 Round（三人各下一手）切换一次。Round 只看“进行到第几轮”，与谁赢过无关。
          </p>
        </li>
        <li>
          <b>④ 有胜权时，连成四子会怎样？</b>
          <p>
            持胜权的玩家在自己回合落子，若这一手使包含新子的横/竖/斜线达到 ≥4，立即获胜（4、5、6 连都算）。
          </p>
        </li>
        <li>
          <b>⑤ 没有胜权时，连成四子会怎样？</b>
          <p>
            不能形成自己的 ≥4 连。这种落点是禁手：引擎判定非法，点击会被拒绝、棋盘上会显示 ✕。
            所以“提前摆好四颗”是摆不出来的。
          </p>
        </li>
        <li>
          <b>⑥ 为什么棋盘上已经有三颗/四颗相连，却可能没有获胜？</b>
          <p>
            因为胜利只能由“当前合法落子”即时触发：过去摆下的连线只是棋型，不构成胜利；
            也不存在“存好四连、等以后有资格了自动赢”。没有胜权时，把第四颗放上去本身就是禁手。
          </p>
        </li>
        <li>
          <b>⑦ 对局中怎么知道当前谁有胜权？</b>
          <p>
            看对局上方的状态栏“本回合胜权”：显示 C / B / A 或“暂无”；右侧 BAC 时间线面板会标出
            当前轮与未来 8 轮的胜权安排。轮到谁、谁有胜权是两条独立信息，分开显示。
          </p>
        </li>
      </ol>
      <div className="howto-vline-wrap">
        <p className="howto-note">胜权时间线（Round 1–14，{ELIGIBLE_START_ROUND} 起进入循环；R 后面的彩色字母 = 该轮胜权玩家）：</p>
        <VictoryTimelineTable from={1} to={14} />
      </div>
    </section>
  );
}

/* ---------------- 完整规则页内容 ---------------- */

export function HowToPlayContent({ onStartTutorial, onBack }: { onStartTutorial?: () => void; onBack?: () => void }) {
  return (
    <div className="howto">
      <header className="howto-head">
        <div>
          <h1>三人四子棋怎么玩</h1>
          <p className="howto-lead">
            三名玩家在同一张棋盘上轮流落子。入门只需记住一句话：
            <b>“只有当前拥有胜权的玩家，才能凭自己的落子连成四子获胜。”</b>
          </p>
        </div>
        {onBack && (
          <Btn variant="ghost" size="small" onClick={onBack}>
            返回
          </Btn>
        )}
      </header>

      <section className="howto-block" aria-labelledby="quick-heading">
        <h2 id="quick-heading">规则速览</h2>
        <RulesQuickView />
      </section>

      <VictoryRightSection />

      <section className="howto-block" aria-labelledby="detail-heading">
        <h2 id="detail-heading">完整规则</h2>
        <ol className="howto-full">
          <li>玩家：A（红）、B（绿）、C（白），行动顺序固定 A → B → C → A → …</li>
          <li>一个 Round = A、B、C 各行动一次。</li>
          <li>Round 1–5：无人拥有胜权；任何会形成自己 ≥4 连的落子都非法（禁手）。</li>
          <li>Round 6 起进入胜权循环；只有「本回合行动者 == 胜权玩家」才可能凭本手获胜。</li>
          <li>胜权玩家落子后，若包含新子的线达到 ≥4（横、竖、＼、／ 都算），立即获胜。</li>
          <li>非胜权玩家不能形成自己的 ≥4 连——这是禁手，点击会被拒绝。</li>
          <li>不存在“提前储存四连”——胜利只能由当前合法落子即时触发。</li>
          <li>轮到某玩家但没有任何合法落子 → 自动 Pass（回合照常消耗）。</li>
          <li>棋盘填满且无人获胜 → 和棋。</li>
          <li>棋盘可选 13×13 与 17×17；在线对局计分只发生在 Online Match。</li>
        </ol>
      </section>

      {onStartTutorial && (
        <div className="howto-cta">
          <Btn variant="primary" size="big" onClick={onStartTutorial}>
            开始新手教程（1 真人 + 2 AI 实战教学）
          </Btn>
          <p className="muted">三局教学：你在 A 座执红先行，两名 AI 对手随机搭配，边打边学。</p>
        </div>
      )}
    </div>
  );
}
