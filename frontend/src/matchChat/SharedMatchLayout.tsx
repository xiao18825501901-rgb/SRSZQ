import type { ReactNode } from 'react';
import type { Player } from '../../../shared/src/game/types';
import type { MatchModel } from './catalog';

export interface SharedMatchLayoutProps {
  model: MatchModel;
  timeline: ReactNode;
  board: ReactNode;
  chat: ReactNode;
  toolbar?: ReactNode;
  overlays?: ReactNode;
}

/**
 * One authoritative shell for the four product match modes. It never owns game
 * rules; the host passes its real Board and existing action controls.
 */
export function SharedMatchLayout({ model, timeline, board, chat, toolbar, overlays }: SharedMatchLayoutProps) {
  return (
    <main
      className="four-mode-shell"
      data-mode={model.mode}
      data-board-size={model.boardSize}
      data-testid={`four-mode-${model.mode}`}
    >
      <div className="four-mode-columns">
        <aside className="four-mode-timeline" aria-label="胜权轮次">
          {timeline}
        </aside>
        <section className="four-mode-board-column" aria-label="对局棋盘">
          <div className="four-mode-board">{board}</div>
          {toolbar && <div className="four-mode-toolbar">{toolbar}</div>}
        </section>
        <aside className="four-mode-chat-column" aria-label="三位玩家和局内聊天">
          {chat}
        </aside>
      </div>
      {overlays}
    </main>
  );
}

export type { Player };
