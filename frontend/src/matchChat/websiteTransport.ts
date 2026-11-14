import { api } from '../api';
import { gameLink } from '../ws';
import type { ChatDraft, ChatMessage, ChatTransport } from './catalog';

/** Binds the shared UI to the website's authenticated WebSocket and HTTP API. */
export function websiteTransport(): ChatTransport {
  return {
    async send(draft: ChatDraft, context: { roomId: string }): Promise<{ message: ChatMessage }> {
      return new Promise((resolve, reject) => {
        const clientMessageId = draft.clientMessageId;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (action: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          action();
        };
        const unsubscribe = gameLink.subscribe(() => {
          const message = gameLink.chatMessages.find(
            (m) => m.clientMessageId === clientMessageId && m.roomId === context.roomId,
          );
          if (message) {
            finish(() => resolve({ message }));
            return;
          }
          if (gameLink.chatError) {
            const code = gameLink.chatError;
            gameLink.chatError = '';
            finish(() => {
              const error = new Error(code);
              (error as Error & { code?: string }).code = code;
              reject(error);
            });
          }
        });
        timer = setTimeout(() => {
          gameLink.chatError = '';
          finish(() => reject(new Error('CHAT_TIMEOUT')));
        }, 6000);
        gameLink.sendChat(draft);
      });
    },
    async rewrite(input: { text: string; style: string }) {
      const { data } = await api<{ text: string; mode: string }>('POST', '/api/match-chat/rewrite', {
        ...input,
        consent: true,
      });
      return data;
    },
  };
}
