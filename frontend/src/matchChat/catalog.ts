import type { Player } from '../../../shared/src/game/types';

export type MatchChatMode = 'vsai' | 'local' | 'online' | 'invite';
export type AIProfile = 'terra' | 'sol' | 'astra';

export interface ChatPlayer {
  name: string;
  kind: 'human' | 'ai';
  profile?: AIProfile;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  seq: number;
  at: number;
  seat: Player;
  name: string;
  authorKind: 'human' | 'ai';
  kind: 'text' | 'sticker';
  text?: string;
  stickerId?: string;
  rewritten?: boolean;
  clientMessageId: string;
}

export interface ChatDraft {
  kind: 'text' | 'sticker';
  text?: string;
  stickerId?: string;
  rewritten?: boolean;
  clientMessageId: string;
}

export interface ChatTransport {
  send(draft: ChatDraft, context: { roomId: string; localSeat?: Player }): Promise<{ message: ChatMessage }>;
  rewrite(input: { text: string; style: string }): Promise<{ text: string; mode: string }>;
}

export interface MatchModel {
  roomId: string;
  mode: MatchChatMode;
  round: number;
  turn: Player;
  boardSize: 13 | 17;
  mySeat?: Player;
  localSeat?: Player;
  environment: 'website';
  ended?: boolean;
  players: Record<Player, ChatPlayer>;
}

export const MODE_LABELS: Record<MatchChatMode, string> = {
  vsai: '人机对战',
  local: '本地对局',
  online: '在线匹配',
  invite: '好友邀请',
};

export const EMOJIS: ReadonlyArray<string> = [
  '😎', '😂', '🤔', '👏', '🔥', '😏', '🤝', '🙈', '💪', '🎯', '🍵', '✨',
];

export const STICKERS: ReadonlyArray<{ id: string; emoji: string; text: string }> = [
  { id: 'challenge', emoji: '😎', text: '放马过来' },
  { id: 'think', emoji: '🤔', text: '让我想想' },
  { id: 'nice', emoji: '👏', text: '这步漂亮' },
  { id: 'hype', emoji: '🔥', text: '开始认真' },
  { id: 'tea', emoji: '🍵', text: '先喝口茶' },
  { id: 'oops', emoji: '🙈', text: '大意了' },
  { id: 'gg', emoji: '🤝', text: '好棋好局' },
  { id: 'plot', emoji: '😏', text: '我有计划' },
];

export const BANTER_LINES: ReadonlyArray<string> = [
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

export class BanterDeck {
  private readonly cooldownMs: number;
  private readonly maxPerBot: number;
  private readonly rooms = new Map<string, { last: number; index: number; counts: Record<Player, number> }>();

  constructor({ cooldownMs = 20_000, maxPerBot = 6 }: { cooldownMs?: number; maxPerBot?: number } = {}) {
    this.cooldownMs = cooldownMs;
    this.maxPerBot = maxPerBot;
  }

  next({ roomId, seat, now = Date.now(), enabled = true }: {
    roomId: string; seat: Player; now?: number; enabled?: boolean;
  }): string | null {
    if (!enabled) return null;
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

export function validateChatDraft(draft: ChatDraft): {
  clientMessageId: string;
  kind: 'text' | 'sticker';
  text?: string;
  stickerId?: string;
  rewritten?: boolean;
} {
  if (!draft || !/^[A-Za-z0-9_-]{1,96}$/.test(draft.clientMessageId || '')) {
    throw new Error('INVALID_MESSAGE_ID');
  }
  if (draft.kind === 'sticker') {
    const sticker = STICKERS.find((s) => s.id === draft.stickerId);
    if (!sticker) throw new Error('INVALID_STICKER');
    return {
      clientMessageId: draft.clientMessageId,
      kind: 'sticker',
      stickerId: draft.stickerId,
    };
  }
  if (draft.kind !== 'text' || typeof draft.text !== 'string') throw new Error('INVALID_TEXT');
  const text = draft.text.trim();
  if (!text || [...text].length > 280 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    throw new Error('INVALID_TEXT');
  }
  return {
    clientMessageId: draft.clientMessageId,
    kind: 'text',
    text,
    rewritten: draft.rewritten === true,
  };
}

export class LocalChatService {
  private readonly rooms = new Map<string, { seq: number; messages: ChatMessage[]; last: Map<string, number> }>();

  constructor(
    private readonly options: {
      clock?: () => number;
      idFactory?: () => string;
      minGapMs?: number;
      maxPerMinute?: number;
    } = {},
  ) {}

  send(roomId: string, seat: Player, name: string, draft: ChatDraft): ChatMessage {
    const payload = validateChatDraft(draft);
    const now = this.options.clock?.() ?? Date.now();
    const room = this.rooms.get(roomId) ?? { seq: 0, messages: [], last: new Map<string, number>() };
    this.rooms.set(roomId, room);
    const key = `${seat}|${payload.clientMessageId}`;
    const duplicate = room.messages.find((m) => m.seat === seat && m.clientMessageId === payload.clientMessageId);
    if (duplicate) return duplicate;
    if (now - (room.last.get(key) ?? -Infinity) < (this.options.minGapMs ?? 1500)) {
      throw new Error('RATE_LIMIT');
    }
    const recent = room.messages.filter((m) => m.seat === seat && now - m.at < 60_000).length;
    if (recent >= (this.options.maxPerMinute ?? 20)) throw new Error('RATE_LIMIT');
    const message: ChatMessage = {
      id: this.options.idFactory?.() ?? `${roomId}-${seat}-${payload.clientMessageId}`,
      roomId,
      seq: ++room.seq,
      at: now,
      seat,
      name,
      authorKind: 'human',
      ...payload,
    };
    room.messages.push(message);
    room.last.set(key, now);
    return message;
  }

  list(roomId: string, after = 0): ChatMessage[] {
    return [...(this.rooms.get(roomId)?.messages ?? [])].filter((m) => m.seq > after);
  }
}
