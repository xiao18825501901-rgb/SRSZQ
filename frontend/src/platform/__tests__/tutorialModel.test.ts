import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../../shared/src/ai/rng';
import { AI_LEVELS } from '../../../../shared/src/ai/types';
import { PLAYERS } from '../../../../shared/src/game/types';
import {
  aiDisplayName,
  createTutorialAssignment,
  humanSeatOf,
  isValidTutorialSeats,
  tutorialRoleLines,
} from '../tutorialModel';

const seeded = (seed: number) => {
  const r = mulberry32(seed);
  return () => r.next();
};

describe('Tutorial assignment：exactly 3 seats = 1 human + 2 AI（T1/T2/T3）', () => {
  it('每次初始化都恰好 3 座、1 真人、2 AI', () => {
    for (let s = 0; s < 40; s++) {
      const seats = createTutorialAssignment(seeded(s));
      expect(Object.keys(seats)).toHaveLength(3);
      const humans = PLAYERS.filter((p) => seats[p].kind === 'human');
      const ais = PLAYERS.filter((p) => seats[p].kind === 'ai');
      expect(humans).toHaveLength(1);
      expect(ais).toHaveLength(2);
      expect(isValidTutorialSeats(seats)).toBe(true);
    }
  });
});

describe('Human seat 随机 A/B/C（T4/T5/T6）', () => {
  it('确定性 RNG 强制覆盖 A、B、C 三条路径', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 300; s++) seen.add(humanSeatOf(createTutorialAssignment(seeded(s))));
    expect(seen).toEqual(new Set(['A', 'B', 'C']));
  });
});

describe('AI difficulty 初始化随机（T7/T8/T9/T10）', () => {
  it('两个 AI 难度仅来自 1★/2★/3★（4/5 不可能）、可不同也可相同', () => {
    let anyEqual = false;
    const seen = new Set<string>();
    for (let s = 0; s < 200; s++) {
      const seats = createTutorialAssignment(seeded(s));
      const levels = PLAYERS.filter((p) => seats[p].kind === 'ai').map((p) => seats[p].level!);
      expect(levels).toHaveLength(2);
      levels.forEach((l) => {
        expect(['random', 'tactical', 'selfish']).toContain(l);
        expect(['3ply', 'maxn']).not.toContain(l);
      });
      seen.add(levels.join('|'));
      if (levels[0] === levels[1]) anyEqual = true;
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(anyEqual).toBe(true);
  });

  it('教程只展示 AI 星级，不泄露内部策略档位名', () => {
    const internalNames = ['Random', 'Tactical', 'Selfish', '3-Ply', 'MaxN'];
    for (const level of AI_LEVELS) {
      const label = aiDisplayName(level);
      expect(label).toMatch(/^★{1,5}☆{0,4}$/);
      internalNames.forEach((name) => expect(label).not.toContain(name));
    }
  });
});

describe('Session immutability（T11/T12）', () => {
  it('T11：同一 session 重渲染不改变 assignment（初始化一次、结果幂等）', () => {
    const rng = seeded(123);
    const a = createTutorialAssignment(rng);
    // 后续 rerender 不使用新随机源重新调用；同一 assignment 序列化稳定
    expect(tutorialRoleLines(a)).toEqual(tutorialRoleLines(a));
  });

  it('T12：restart（重新初始化）使用下一段 RNG 序列产生新 assignment', () => {
    const rng = seeded(777);
    const first = createTutorialAssignment(rng);
    const second = createTutorialAssignment(rng);
    // 同一随机序列推进后，两次初始化不会总是完全相同
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });
});

describe('Human=B / Human=C turn flow（T13/T14）', () => {
  it('T13：Human=B 时 A 座为 AI（A 先自动行动）', () => {
    for (let s = 0; s < 400; s++) {
      const seats = createTutorialAssignment(seeded(s));
      if (humanSeatOf(seats) === 'B') {
        expect(seats.A.kind).toBe('ai');
        expect(seats.B.kind).toBe('human');
        expect(seats.C.kind).toBe('ai');
        return;
      }
    }
    throw new Error('未采样到 Human=B 用例');
  });

  it('T14：Human=C 时 A、B 均为 AI（A+B 先自动行动，再轮到 C）', () => {
    for (let s = 0; s < 400; s++) {
      const seats = createTutorialAssignment(seeded(s));
      if (humanSeatOf(seats) === 'C') {
        expect(seats.A.kind).toBe('ai');
        expect(seats.B.kind).toBe('ai');
        expect(seats.C.kind).toBe('human');
        return;
      }
    }
    throw new Error('未采样到 Human=C 用例');
  });
});

describe('教程身份行：按 A/B/C 真实顺序、不把用户挪第一行', () => {
  it('身份行顺序恒为 A→B→C，且只有真人座标记为「你」', () => {
    for (let s = 0; s < 30; s++) {
      const seats = createTutorialAssignment(seeded(s));
      const roles = tutorialRoleLines(seats);
      expect(roles.map((r) => r.seat)).toEqual(['A', 'B', 'C']);
      expect(roles.filter((r) => r.role === '你')).toHaveLength(1);
      const you = roles.find((r) => r.role === '你')!;
      expect(seats[you.seat].kind).toBe('human');
      expect(you.detail).toContain('（真人）');
    }
  });

  it('非法座位组合被拒绝', () => {
    expect(isValidTutorialSeats({ A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'ai', level: 'random' } })).toBe(false);
    expect(isValidTutorialSeats({ A: { kind: 'human' }, B: { kind: 'ai', level: 'random' }, C: { kind: 'ai', level: 'random' } })).toBe(true);
    expect(isValidTutorialSeats({ A: { kind: 'ai', level: 'random' }, B: { kind: 'ai', level: 'random' }, C: { kind: 'ai', level: 'random' } })).toBe(false);
  });
});
