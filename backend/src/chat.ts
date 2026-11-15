import type { Player } from '../../shared/src/game/types';
import { createHash } from 'node:crypto';

export type ChatAuthorKind = 'human' | 'ai';
export type ChatMessageKind = 'text' | 'sticker';

export interface ChatMessage {
  id: string;
  roomId: string;
  seq: number;
  at: number;
  seat: Player;
  actorId: string;
  name: string;
  authorKind: ChatAuthorKind;
  kind: ChatMessageKind;
  text?: string;
  stickerId?: string;
  rewritten?: boolean;
  clientMessageId: string;
}

export interface ChatAppendInput {
  roomId: string;
  seat: Player;
  actorId: string;
  name: string;
  authorKind: ChatAuthorKind;
  draft: {
    kind: ChatMessageKind;
    text?: string;
    stickerId?: string;
    rewritten?: boolean;
    clientMessageId: string;
  };
  now?: number;
  messageId?: string;
  ttlMs?: number;
}

export const STICKER_IDS = new Set([
  'challenge', 'think', 'nice', 'hype', 'tea', 'oops', 'gg', 'plot',
]);

const okId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);

export function validateChatDraft(draft: unknown): ChatAppendInput['draft'] {
  if (!draft || typeof draft !== 'object') throw new ChatError('INVALID_DRAFT');
  const value = draft as Record<string, unknown>;
  if (!okId(value.clientMessageId)) throw new ChatError('INVALID_MESSAGE_ID');
  if (value.kind === 'sticker') {
    if (!STICKER_IDS.has(String(value.stickerId))) throw new ChatError('INVALID_STICKER');
    return {
      clientMessageId: value.clientMessageId,
      kind: 'sticker',
      stickerId: String(value.stickerId),
    };
  }
  if (value.kind !== 'text' || typeof value.text !== 'string') throw new ChatError('INVALID_TEXT');
  const text = value.text.trim();
  if (!text || [...text].length > 280 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    throw new ChatError('INVALID_TEXT');
  }
  return {
    clientMessageId: value.clientMessageId,
    kind: 'text',
    text,
    ...(value.rewritten === true ? { rewritten: true } : {}),
  };
}

export function chatPayloadDigest(draft: ChatAppendInput['draft']): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: draft.kind,
      text: draft.text ?? null,
      stickerId: draft.stickerId ?? null,
      rewritten: draft.rewritten === true,
    }))
    .digest('hex');
}

export class ChatError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const BANTER_LINES: readonly string[] = [
  '这片棋盘还挺宽，来和我争一争中路？😎',
  '你的进攻故事，我准备好接下一章了。📖',
  '轮到你出招了，让这盘棋热闹起来！🔥',
  '别光看风景，棋盘正等着你的大场面。⛰️',
  '我先摆好阵势，就看你怎么破局。🎯',
  '这步轮到你，敢不敢给局面加点速度？⚡',
  '我已经坐稳了，精彩的进攻尽管来。🪑',
  '防守我会，接你的奇招我更期待。🤔',
  '这一局的主角还没定，下一手争一下？✨',
  '棋盘这么大，总该有你大胆落子的地方。🧭',
  '你的想法很有意思，再往前走一步试试？👀',
  '先别急着鼓掌，我还留着下一回合。😏',
  '三人棋局，热闹才刚开场。🎬',
  '来点让我认真思考的招数吧。🧠',
  '我这边准备好了，欢迎正面过招。🤝',
  '这阵风吹得刚好，适合来场进攻。🍃',
  '稳健很好看，精彩也值得一试。🎨',
  '我就站在棋盘这一边，等你的好棋。🏁',
  '别让这局太安静，下一手交给你。🥁',
  '下棋不是比谁话多——所以请看下一手。😄',
  '这步有点东西，我得认真回应了。👏',
  '中路的风景不错，要来一起争夺吗？🌿',
  '你的进攻让我精神了，继续保持！💪',
  '我把问题放在棋盘上，等你用落子回答。📝',
  '茶可以慢慢喝，机会可要认真看。🍵',
  '这一手先记下，待会儿复盘有话题了。📚',
  '你负责大胆出招，我负责认真接招。🛡️',
  '最后的掌声给谁，现在还不好说。🎉',
  '好戏不怕晚，下一手也能很精彩。🌟',
  '输赢之外，先下出一盘漂亮的棋。🤝',
];

export class ChatBanterDeck {
  private readonly cooldownMs: number;
  private readonly maxPerBot: number;
  private readonly rooms = new Map<string, { last: number; index: number; counts: Record<Player, number> }>();

  constructor({ cooldownMs = 20_000, maxPerBot = 6 }: { cooldownMs?: number; maxPerBot?: number } = {}) {
    this.cooldownMs = cooldownMs;
    this.maxPerBot = maxPerBot;
  }

  next({ roomId, seat, now = Date.now() }: { roomId: string; seat: Player; now?: number }): string | null {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { last: -Infinity, index: 0, counts: { A: 0, B: 0, C: 0 } };
      this.rooms.set(roomId, room);
    }
    if (now - room.last < this.cooldownMs || room.counts[seat] >= this.maxPerBot) return null;
    const line = BANTER_LINES[room.index % BANTER_LINES.length];
    room.index += 1;
    room.last = now;
    room.counts[seat] += 1;
    return line;
  }

  reset(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
