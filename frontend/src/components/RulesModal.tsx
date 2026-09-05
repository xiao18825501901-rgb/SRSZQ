import { ELIGIBLE_ORDER } from '../../../shared/src/game/types';
import { getEligiblePlayer } from '../../../shared/src/game/eligibility';
import { PLAYER_COLORS } from '../../../shared/src/game/types';

interface Props {
  onClose: () => void;
}

export function RulesModal({ onClose }: Props) {
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
            <li>Round 1–5：没有任何玩家拥有胜权，任何会形成自己 ≥4 连的落子均非法（禁手）。</li>
            <li>从 Round 6 起进入资格循环，只有「当前玩家 == 胜权玩家」才可能凭本手获胜。</li>
            <li>非资格玩家形成自己 ≥4 连的落子是禁手（非法，无法点击）。</li>
            <li>资格玩家当前落子使包含新棋子的线形成 ≥4 → 立即获胜。</li>
            <li>方向：水平、垂直、主对角线 ＼、副对角线 ／ 都算。</li>
            <li>≥4 即胜：4 连、5 连、6 连……同样成立。</li>
            <li>轮到某玩家但无任何合法落子 → 自动 Pass（不落子、不能获胜、回合照常消耗）。</li>
            <li>棋盘填满且无人获胜 → 和棋（DRAW）。</li>
            <li>不存在「提前储存四连、等以后有资格再自动赢」——胜利只能由当前合法落子即时触发。</li>
          </ol>
          <h3>资格循环（正式规则）</h3>
          <p>Round ≥ 6：{ELIGIBLE_ORDER.join(' → ')} 循环。</p>
          <table className="rule-table">
            <thead>
              <tr><th>Round</th><th>胜权玩家</th></tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((r) => {
                const p = getEligiblePlayer(r);
                return (
                  <tr key={r}>
                    <td>R{r}</td>
                    <td>
                      {p ? (
                        <b style={{ color: PLAYER_COLORS[p] }}>{p}</b>
                      ) : (
                        '无人（禁止成四）'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
