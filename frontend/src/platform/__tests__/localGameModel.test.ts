import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../../shared/src/ai/rng';
import { AI_LEVELS } from '../../../../shared/src/ai/types';
import { isLocalDraftValid, localHumanCount, resolveLocalSeats, type LocalDraft } from '../localGameModel';

const seeded = (seed: number) => {
  const r = mulberry32(seed);
  return () => r.next();
};

const allHuman: LocalDraft = { A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'human' } };

describe('Guest Local Game 座位配置模型（L4–L8）', () => {
  it('L4：三真人组合有效且不解析出 AI', () => {
    const seats = resolveLocalSeats(allHuman, seeded(1));
    expect(isLocalDraftValid(allHuman)).toBe(true);
    expect(localHumanCount(allHuman)).toBe(3);
    expect(Object.values(seats).every((s) => s.kind === 'human')).toBe(true);
  });

  it('L5：两真人 + 一 AI 有效', () => {
    const draft: LocalDraft = { A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'ai', level: 2 } };
    const seats = resolveLocalSeats(draft, seeded(2));
    expect(isLocalDraftValid(draft)).toBe(true);
    expect(seats.A.kind).toBe('human');
    expect(seats.B.kind).toBe('human');
    expect(seats.C.kind).toBe('ai');
    expect(seats.C.level).toBe(2);
  });

  it('L6：一真人 + 两 AI 有效', () => {
    const draft: LocalDraft = { A: { kind: 'human' }, B: { kind: 'ai', level: 1 }, C: { kind: 'ai', level: 5 } };
    const seats = resolveLocalSeats(draft, seeded(3));
    expect(isLocalDraftValid(draft)).toBe(true);
    expect(localHumanCount(draft)).toBe(1);
    expect(seats.A.kind).toBe('human');
    expect(seats.B.kind).toBe('ai');
    expect(seats.C.kind).toBe('ai');
    expect(seats.C.level).toBe(5);
  });

  it('L7：AI 难度可选择（固定档解析为同档）', () => {
    for (const lvl of AI_LEVELS) {
      const draft: LocalDraft = { A: { kind: 'human' }, B: { kind: 'ai', level: lvl }, C: { kind: 'human' } };
      const seats = resolveLocalSeats(draft, seeded(4));
      expect(seats.B.level).toBe(lvl);
    }
  });

  it('L8：随机（auto）难度在初始化解析一次；非 auto 档不被改写', () => {
    const draft: LocalDraft = { A: { kind: 'human' }, B: { kind: 'ai', level: 'auto' }, C: { kind: 'human' } };
    const a = resolveLocalSeats(draft, seeded(9));
    const b = resolveLocalSeats(draft, seeded(9));
    expect(a.B.level).toBe(b.B.level);
    expect(AI_LEVELS.includes(a.B.level!)).toBe(true);
  });

  it('禁止 AI-only：三 AI draft 无效', () => {
    const draft: LocalDraft = { A: { kind: 'ai', level: 'auto' }, B: { kind: 'ai', level: 'auto' }, C: { kind: 'ai', level: 'auto' } };
    expect(localHumanCount(draft)).toBe(0);
    expect(isLocalDraftValid(draft)).toBe(false);
  });
});
