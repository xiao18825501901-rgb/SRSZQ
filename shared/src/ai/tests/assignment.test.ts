import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../rng';
import {
  onlineAiFillLevel,
  pickUniform,
  shuffled,
  tutorialAiLevel,
  tutorialHumanSeat,
} from '../assignment';
import { AI_LEVELS } from '../types';

const seedRng = (seed: number) => {
  const r = mulberry32(seed);
  return () => r.next();
};

describe('随机分配工具（deterministic RNG）', () => {
  it('pickUniform 在区间内且可复现', () => {
    const v = pickUniform(['A', 'B', 'C'], seedRng(1));
    expect(['A', 'B', 'C']).toContain(v);
    expect(pickUniform(['A', 'B', 'C'], seedRng(1))).toBe(v);
  });

  it('shuffled 保持元素集合不变、可复现、不修改入参', () => {
    const arr = ['u1', 'u2', 'ai'] as const;
    const a = shuffled(arr, seedRng(7));
    const b = shuffled(arr, seedRng(7));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...arr].sort());
    expect(arr).toEqual(['u1', 'u2', 'ai']);
  });
});

describe('Tutorial 真人座位：A/B/C 三档都出现（无实现偏差）', () => {
  it('T4/T5/T6：确定性 RNG 覆盖 A、B、C 三种路径', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 300; s++) seen.add(tutorialHumanSeat(seedRng(s)));
    expect(seen.has('A')).toBe(true);
    expect(seen.has('B')).toBe(true);
    expect(seen.has('C')).toBe(true);
    expect(seen.size).toBe(3);
  });
});

describe('Tutorial AI 难度：真实 registry 全档、可相同、独立', () => {
  it('T7/T8：每次初始化选择、且属于真实 registry', () => {
    for (let s = 0; s < 200; s++) {
      expect(AI_LEVELS.includes(tutorialAiLevel(seedRng(s)))).toBe(true);
    }
  });

  it('T9/T10：两个 AI 难度可不同、也可相同（独立随机）', () => {
    const seenDiff = new Set<string>();
    let anyEqual = false;
    for (let s = 0; s < 300; s++) {
      const rng = seedRng(s);
      const d1 = tutorialAiLevel(rng);
      const d2 = tutorialAiLevel(rng);
      seenDiff.add(`${d1}|${d2}`);
      if (d1 === d2) anyEqual = true;
    }
    expect(seenDiff.size).toBeGreaterThan(1);
    expect(anyEqual).toBe(true);
  });
});

describe('Online AI fill：只允许 4★/5★，且两者都可出现', () => {
  it('O4/O5/O6/O7：确定性 RNG 同时产生 3ply(4★) 与 maxn(5★)，绝不产生其它档', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 400; s++) {
      const lvl = onlineAiFillLevel(seedRng(s));
      seen.add(lvl);
      expect(['3ply', 'maxn']).toContain(lvl);
      expect(['random', 'tactical', 'selfish']).not.toContain(lvl);
    }
    expect(seen.has('3ply')).toBe(true);
    expect(seen.has('maxn')).toBe(true);
  });
});

describe('随机分布 sanity（deterministic，不写 flaky 阈值）', () => {
  it('10,000 次教程初始化：human A/B/C 均出现、AI 全档均出现', () => {
    const humans = { A: 0, B: 0, C: 0 };
    const levels = new Set<string>();
    const rng = seedRng(20240907);
    for (let i = 0; i < 10000; i++) {
      const seat = tutorialHumanSeat(rng);
      humans[seat]++;
      levels.add(tutorialAiLevel(rng));
      levels.add(tutorialAiLevel(rng));
    }
    expect(humans.A).toBeGreaterThan(0);
    expect(humans.B).toBeGreaterThan(0);
    expect(humans.C).toBeGreaterThan(0);
    for (const l of AI_LEVELS) expect(levels.has(l)).toBe(true);
  });

  it('10,000 次 online AI fill：只出现 4/5，且 4 与 5 都出现', () => {
    const levels = new Set<string>();
    const rng = seedRng(20240908);
    for (let i = 0; i < 10000; i++) levels.add(onlineAiFillLevel(rng));
    expect([...levels].sort()).toEqual(['3ply', 'maxn']);
  });
});
