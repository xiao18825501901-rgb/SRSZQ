import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApi } from './api.js';
import { openDb } from './db.js';
import { BANTER_LINES, ChatBanterDeck, chatPayloadDigest, validateChatDraft } from './chat.js';

function testDb() {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-chat-'));
  return openDb(join(dir, 'chat.sqlite'));
}

async function portOf(server: import('node:http').Server): Promise<number> {
  const address = server.address() as AddressInfo;
  return address.port;
}

async function registerUser(server: import('node:http').Server): Promise<{ token: string; id: string }> {
  const port = await portOf(server);
  const unique = Math.random().toString(36).slice(2, 10);
  const response = await fetch(`http://127.0.0.1:${port}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${unique}@example.com`,
      username: `User${unique}`,
      password: 'secret123',
    }),
  });
  const data = await response.json() as { token: string; user: { id: string } };
  return { token: data.token, id: data.user.id };
}

const draft = {
  kind: 'text' as const,
  text: '这步棋有意思',
  clientMessageId: 'client-1',
};

describe('match chat validation', () => {
  it('rejects forged client ids and oversized text', () => {
    expect(() => validateChatDraft({ kind: 'text', text: 'x', clientMessageId: 'bad id' })).toThrow('INVALID_MESSAGE_ID');
    expect(() => validateChatDraft({ kind: 'text', text: 'x'.repeat(281), clientMessageId: 'ok' })).toThrow('INVALID_TEXT');
  });

  it('accepts text and known stickers only', () => {
    expect(validateChatDraft(draft)).toEqual(draft);
    expect(validateChatDraft({ kind: 'sticker', stickerId: 'gg', clientMessageId: 's1' })).toEqual({
      kind: 'sticker', stickerId: 'gg', clientMessageId: 's1',
    });
    expect(() => validateChatDraft({ kind: 'sticker', stickerId: 'not-a-sticker', clientMessageId: 's2' })).toThrow('INVALID_STICKER');
  });

  it('changes digest when text changes', () => {
    expect(chatPayloadDigest(draft)).not.toEqual(chatPayloadDigest({ ...draft, text: 'different' }));
  });
});

describe('match chat persistence', () => {
  it('persists before broadcast and deduplicates the same client id', () => {
    const db = testDb();
    try {
      const first = db.appendChatMessage({ roomId: 'room-1', seat: 'A', actorId: 'user-1', name: 'Alice', authorKind: 'human', draft });
      expect(first.appended).toBe(true);
      expect(first.message?.seq).toBe(1);
      const second = db.appendChatMessage({ roomId: 'room-1', seat: 'A', actorId: 'user-1', name: 'Alice', authorKind: 'human', draft, now: Date.now() + 1000 });
      expect(second.appended).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(db.listChatMessages('room-1')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('rejects same client id with a different payload and enforces rate limits', () => {
    const db = testDb();
    try {
      db.appendChatMessage({ roomId: 'room-2', seat: 'B', actorId: 'user-2', name: 'Bob', authorKind: 'human', draft });
      expect(() => db.appendChatMessage({
        roomId: 'room-2', seat: 'B', actorId: 'user-2', name: 'Bob', authorKind: 'human',
        draft: { ...draft, text: 'changed' }, now: 1500,
      })).toThrow('IDEMPOTENCY_CONFLICT');
      expect(() => db.appendChatMessage({
        roomId: 'room-2', seat: 'B', actorId: 'user-2', name: 'Bob', authorKind: 'human',
        draft: { ...draft, clientMessageId: 'client-2' }, now: Date.now() + 200,
      })).toThrow('RATE_LIMIT');
      expect(db.listChatMessages('room-2')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('returns only unexpired messages and stores reports', () => {
    const db = testDb();
    try {
      db.appendChatMessage({ roomId: 'room-3', seat: 'C', actorId: 'user-3', name: 'Carol', authorKind: 'human', draft, now: 1, ttlMs: 10 });
      const fresh = db.appendChatMessage({
        roomId: 'room-3', seat: 'C', actorId: 'user-3', name: 'Carol', authorKind: 'human',
        draft: { ...draft, clientMessageId: 'client-2' }, now: Date.now() + 2000,
      });
      expect(fresh.message?.seq).toBe(2);
      expect(db.listChatMessages('room-3').map((m) => m.clientMessageId)).toEqual(['client-2']);
      expect(db.createChatReport({ roomId: 'room-3', messageId: fresh.message!.id, reporterId: 'user-4', reason: 'bad language' }).reportId).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe('authoritative AI banter', () => {
  it('is unique, room-cooldowned, capped per AI and resettable per game', () => {
    const deck = new ChatBanterDeck({ cooldownMs: 20_000, maxPerBot: 6 });
    const lines: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const line = deck.next({ roomId: 'banter-room', seat: 'A', now: index * 20_000 });
      expect(line).toBeTruthy();
      lines.push(line!);
    }
    expect(new Set(lines).size).toBe(6);
    expect(lines.every((line) => BANTER_LINES.includes(line))).toBe(true);
    expect(deck.next({ roomId: 'banter-room', seat: 'A', now: 120_000 })).toBeNull();
    expect(deck.next({ roomId: 'banter-room', seat: 'B', now: 100_001 })).toBeNull();
    expect(deck.next({ roomId: 'banter-room', seat: 'B', now: 120_000 })).toBeTruthy();
    deck.reset('banter-room');
    expect(deck.next({ roomId: 'banter-room', seat: 'A', now: 120_001 })).toBeTruthy();
  });
});

describe('match chat reports', () => {
  it('rejects unauthenticated, cross-room and non-member reports', async () => {
    const db = testDb();
    const { server } = createApi(db);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const port = await portOf(server);
      db.appendChatMessage({ roomId: 'room-report', seat: 'A', actorId: 'actor-1', name: 'Alice', authorKind: 'human', draft });
      db.openLiveGame('room-report', { 'actor-2': 'A' });
      const reporter = await registerUser(server);
      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/match-chat/room-report/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'missing', reason: 'test' }),
      });
      expect(unauthorized.status).toBe(401);
      const wrongMessage = await fetch(`http://127.0.0.1:${port}/api/match-chat/other-room/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${reporter.token}` },
        body: JSON.stringify({ messageId: 'missing', reason: 'test' }),
      });
      expect(wrongMessage.status).toBe(404);
      const outsider = await fetch(`http://127.0.0.1:${port}/api/match-chat/room-report/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${reporter.token}` },
        body: JSON.stringify({ messageId: 'missing', reason: 'test' }),
      });
      expect(outsider.status).toBe(404);
    } finally {
      server.close();
      db.close();
    }
  });
});
