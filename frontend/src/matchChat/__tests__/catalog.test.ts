import { describe, expect, it } from 'vitest';
import { BanterDeck, BANTER_LINES, EMOJIS, STICKERS } from '../catalog';

describe('match chat catalog', () => {
  it('contains the requested emoji and original sticker sets', () => {
    expect(EMOJIS).toHaveLength(12);
    expect(STICKERS).toHaveLength(8);
    expect(new Set(STICKERS.map((sticker) => sticker.id)).size).toBe(8);
  });

  it('enforces the room cooldown and per-AI game cap', () => {
    const deck = new BanterDeck({ cooldownMs: 20_000, maxPerBot: 6 });
    expect(deck.next({ roomId: 'room-1', seat: 'A', now: -1, enabled: false })).toBeNull();
    const lines: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const line = deck.next({ roomId: 'room-1', seat: 'A', now: index * 20_000 });
      expect(line).toBeTruthy();
      lines.push(line!);
    }
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.every((line) => BANTER_LINES.includes(line))).toBe(true);
    expect(deck.next({ roomId: 'room-1', seat: 'A', now: 120_000 })).toBeNull();
    expect(deck.next({ roomId: 'room-1', seat: 'B', now: 120_001 })).toBeTruthy();
  });

  it('uses one cooldown for the whole room and resets per game', () => {
    const deck = new BanterDeck({ cooldownMs: 20_000, maxPerBot: 6 });
    expect(deck.next({ roomId: 'room-2', seat: 'A', now: 0 })).toBeTruthy();
    expect(deck.next({ roomId: 'room-2', seat: 'B', now: 19_999 })).toBeNull();
    expect(deck.next({ roomId: 'room-2', seat: 'C', now: 20_000 })).toBeTruthy();
    deck.reset('room-2');
    expect(deck.next({ roomId: 'room-2', seat: 'A', now: 20_001 })).toBeTruthy();
  });
});
