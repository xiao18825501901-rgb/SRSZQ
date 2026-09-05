import type { Player, Schedule } from '../game/types';
import { SCHEDULE_DESCRIPTIONS, SCHEDULE_LABELS, SCHEDULES } from '../game/types';

interface Props {
  onClose: () => void;
  schedule: Schedule;
}

export function RulesModal({ onClose, schedule }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rules" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>规则说明</h2>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ol className="rules-list">
            <li>共 3 名玩家：A（红）、B（绿）、C（白），固定行动顺序 A → B → C → A → …</li>
            <li>一个 Round = A、B、C 各行动一次（A→B→C）。</li>
            <li>Round 1–3：没有任何玩家拥有胜权，任何会形成自己 ≥4 连的落子均非法。</li>
            <li>从 Round 4 起进入所选资格周期，只有「当前玩家 == 胜权玩家」才可能凭本手获胜。</li>
            <li>非资格玩家形成自己 ≥4 连的落子是禁手（非法，无法点击）。</li>
            <li>资格玩家当前落子使包含新棋子的线形成 ≥4 → 立即获胜。</li>
            <li>方向：水平、垂直、主对角线 ＼、副对角线 ／ 都算。</li>
            <li>≥4 即胜：4 连、5 连、6 连……同样成立。</li>
            <li>轮到某玩家但无任何合法落子 → 自动 Pass（不落子、不能获胜、回合照常消耗）。</li>
            <li>棋盘填满且无人获胜 → 和棋（DRAW）。</li>
            <li>不存在「提前储存四连、等以后有资格再自动赢」——胜利只能由当前合法落子即时触发。</li>
          </ol>
          <h3>当前资格顺序：{schedule}</h3>
          <p>
            {schedule}：{SCHEDULE_LABELS[schedule]}
          </p>
          <p className="muted">{SCHEDULE_DESCRIPTIONS[schedule]}</p>
          <table className="rule-table">
            <thead>
              <tr><th>Round</th><th>胜权玩家（{schedule}）</th></tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((r) => {
                const cycle: Record<Schedule, Player[] | null> = {
                  CBA: r >= 4 ? ['C', 'B', 'A'] : null,
                  CBACC: r >= 4 ? ['C', 'B', 'A', 'C', 'C'] : null,
                  BAC: r >= 4 ? ['B', 'A', 'C'] : null,
                };
                const c = cycle[schedule];
                const eligible = c ? c[(r - 4) % c.length] : null;
                return (
                  <tr key={r}>
                    <td>R{r}</td>
                    <td>{eligible ?? '无人（禁止成四）'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">
            可选资格顺序：{SCHEDULES.map((s) => `${s}（${SCHEDULE_LABELS[s]}）`).join('　')}
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
