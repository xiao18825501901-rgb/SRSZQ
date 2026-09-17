import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../rng';
import type { AiDifficulty } from '../types';
import {
  pickOnlineSingleHumanAiDifficulty,
  pickOnlineTwoHumanAiDifficulty,
  pickUniform,
  shuffled,
  tutorialAiLevel,
  tutorialHumanSeat,
} from '../assignment';

const seedRng = (seed: number) => {
  const r = mulberry32(seed);
  return () => r.next();
};

/** 固定 r 的 RNG */
const fixedRng = (values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
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
  it('确定性 RNG 覆盖 A、B、C 三种路径', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 300; s++) seen.add(tutorialHumanSeat(seedRng(s)));
    expect(seen.has('A')).toBe(true);
    expect(seen.has('B')).toBe(true);
    expect(seen.has('C')).toBe(true);
    expect(seen.size).toBe(3);
  });
});

describe('Tutorial AI 难度：仅 1★/2★/3★（random/tactical/selfish）', () => {
  it('只能出现 1/2/3，4/5 不可能；三者均可到达', () => {
    const seen = new Set<AiDifficulty>();
    for (let s = 0; s < 600; s++) {
      const lvl = tutorialAiLevel(seedRng(s));
      expect([1, 2, 3]).toContain(lvl);
      expect([4, 5]).not.toContain(lvl);
      seen.add(lvl);
    }
    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  it('两个 AI 独立抽取（两次 draw），可出现相同难度', () => {
    let anyEqual = false;
    const seen = new Set<string>();
    for (let s = 0; s < 300; s++) {
      const rng = seedRng(s);
      const d1 = tutorialAiLevel(rng);
      const d2 = tutorialAiLevel(rng);
      seen.add(`${d1}|${d2}`);
      if (d1 === d2) anyEqual = true;
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(anyEqual).toBe(true);
  });
});

describe('Online 1H+2AI 加权：2=20% / 3=30% / 4=40% / 5=10%（累计区间边界）', () => {
  const cases: Array<[number, 2 | 3 | 4 | 5]> = [
    [0, 2],
    [0.199999, 2],
    [0.2, 3],
    [0.499999, 3],
    [0.5, 4],
    [0.899999, 4],
    [0.9, 5],
    [0.999999, 5],
  ];
  it.each(cases)('r=%s → %s★', (r, expected) => {
    expect(pickOnlineSingleHumanAiDifficulty(fixedRng([r]))).toBe(expected);
  });

  it('两个 AI 分别独立抽取（2+5、3+4、4+4、5+5 等组合可产生）', () => {
    // 用确定性序列验证独立性：第一 draw 与第二 draw 使用序列中不同的 r
    const rng = fixedRng([0.1, 0.95]); // 2★ + 5★
    expect(pickOnlineSingleHumanAiDifficulty(rng)).toBe(2);
    expect(pickOnlineSingleHumanAiDifficulty(rng)).toBe(5);
  });
});

describe('Online 2H+1AI 加权：4=60% / 5=40%', () => {
  const cases: Array<[number, 4 | 5]> = [
    [0, 4],
    [0.599999, 4],
    [0.6, 5],
    [0.999999, 5],
  ];
  it.each(cases)('r=%s → %s★', (r, expected) => {
    expect(pickOnlineTwoHumanAiDifficulty(fixedRng([r]))).toBe(expected);
  });

  it('2/3 不可能出现', () => {
    for (let s = 0; s < 200; s++) {
      const lvl = pickOnlineTwoHumanAiDifficulty(seedRng(s));
      expect([4, 5]).toContain(lvl);
      expect([1, 2, 3]).not.toContain(lvl);
    }
  });
});

describe('随机分布 sanity（deterministic，不写 flaky 阈值）', () => {
  it('10,000 次教程初始化：human A/B/C 均出现、AI 仅 1-3 档均出现', () => {
    const humans = { A: 0, B: 0, C: 0 };
    const levels = new Set<AiDifficulty>();
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
    expect(levels).toEqual(new Set([1, 2, 3]));
  });

  it('100,000 次 online 1H+2AI：比例大致 2=20% / 3=30% / 4=40% / 5=10%（宽阈值 sanity）', () => {
    const count: Record<AiDifficulty, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const rng = seedRng(20240908);
    const N = 100000;
    for (let i = 0; i < N; i++) count[pickOnlineSingleHumanAiDifficulty(rng)]++;
    const pct = (difficulty: AiDifficulty) => count[difficulty] / N;
    expect(pct(2)).toBeGreaterThan(0.18);
    expect(pct(2)).toBeLessThan(0.22);
    expect(pct(3)).toBeGreaterThan(0.28);
    expect(pct(3)).toBeLessThan(0.32);
    expect(pct(4)).toBeGreaterThan(0.38);
    expect(pct(4)).toBeLessThan(0.42);
    expect(pct(5)).toBeGreaterThan(0.08);
    expect(pct(5)).toBeLessThan(0.12);
  });
});
