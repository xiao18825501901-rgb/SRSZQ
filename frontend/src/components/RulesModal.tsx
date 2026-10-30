import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
import { ELIGIBLE_ORDER } from '../../../shared/src/game/types';
import { getEligiblePlayer } from '../../../shared/src/game/eligibility';
import { PLAYER_COLORS } from '../../../shared/src/game/types';
interface Props {
    onClose: () => void;
}
export function RulesModal({ onClose }: Props) {
    useLocale();
    return (<div className="modal-backdrop" onClick={onClose}>
      <div className="modal rules" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{tx("规则说明")}</h2>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ol className="rules-list">
            <li>{tx("共 3 名玩家\uFF1AA\uFF08珊瑚\uFF09、B\uFF08薄荷\uFF09、C\uFF08天空蓝\uFF09\uFF0C固定行动顺序 A \u2192 B \u2192 C \u2192 A \u2192 \u2026")}</li>
            <li>{tx("一个 Round = A、B、C 各行动一次\uFF08A\u2192B\u2192C\uFF09。")}</li>
            <li>{tx("Round 1\u20135\uFF1A没有任何玩家拥有胜权\uFF0C任何会形成自己 \u22654 连的落子均非法\uFF08禁手\uFF09。")}</li>
            <li>{tx("从 Round 6 起进入资格循环\uFF0C只有「当前玩家 == 胜权玩家」才可能凭本手获胜。")}</li>
            <li>{tx("非资格玩家形成自己 \u22654 连的落子是禁手\uFF08非法\uFF0C无法点击\uFF09。")}</li>
            <li>{tx("资格玩家当前落子使包含新棋子的线形成 \u22654 \u2192 立即获胜。")}</li>
            <li>{tx("方向\uFF1A水平、垂直、主对角线 \uFF3C、副对角线 \uFF0F 都算。")}</li>
            <li>{tx("\u22654 即胜\uFF1A4 连、5 连、6 连\u2026\u2026同样成立。")}</li>
            <li>{tx("轮到某玩家但无任何合法落子 \u2192 自动 Pass\uFF08不落子、不能获胜、回合照常消耗\uFF09。")}</li>
            <li>{tx("棋盘填满且无人获胜 \u2192 和棋\uFF08DRAW\uFF09。")}</li>
            <li>{tx("不存在「提前储存四连、等以后有资格再自动赢」\uFF1B胜利只能由当前合法落子即时触发。")}</li>
          </ol>
          <h3>{tx("资格循环\uFF08正式规则\uFF09")}</h3>
          <p>{tx("Round \u2265 6\uFF1A{p0} 循环。", { p0: ELIGIBLE_ORDER.join(' → ') })}</p>
          <table className="rule-table">
            <thead>
              <tr><th>Round</th><th>{tx("胜权玩家")}</th></tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((r) => {
            const p = getEligiblePlayer(r);
            return (<tr key={r}>
                    <td>R{r}</td>
                    <td>
                      {p ? (<b style={{ color: PLAYER_COLORS[p] }}>{p}</b>) : (tx("无人\uFF08禁止成四\uFF09"))}
                    </td>
                  </tr>);
        })}
            </tbody>
          </table>
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>{tx("知道了")}</button>
        </div>
      </div>
    </div>);
}
