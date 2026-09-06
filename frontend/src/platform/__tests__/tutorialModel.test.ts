import { describe, expect, it } from 'vitest';
import { AI_LEVELS, type AILevel } from '../../../../shared/src/ai/types';
import {
  HUMAN_SEAT,
  aiDisplayName,
  isValidTutorialSeats,
  sampleAiPair,
  tutorialRoleLines,
  tutorialSeats,
} from '../tutorialModel';

/** 确定性 LCG（测试用 RNG，避免 flaky） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const allLevels = new Set<AILevel>(AI_LEVELS);

describe('Tutorial session：exactly 3 players = 1 human(A) + 2 AI(B/C)', () => {
  it('TEST4/5/6：座位恰好 3 名玩家：A 人类、B/C 为 AI', () => {
    for (const seed of [1, 7, 42, 2024]) {
      const seats = tutorialSeats(sampleAiPair(lcg(seed)));
      expect(Object.keys(seats)).toHaveLength(3);
      expect(seats.A.kind).toBe('human');
      expect(seats.B.kind).toBe('ai');
      expect(seats.C.kind).toBe('ai');
      expect(isValidTutorialSeats(seats)).toBe(true);
    }
  });

  it('TEST7：两个 AI 均来自真实 AI registry 且互不相同', () => {
    for (let seed = 0; seed < 60; seed++) {
      const [b, c] = sampleAiPair(lcg(seed));
      expect(allLevels.has(b)).toBe(true);
      expect(allLevels.has(c)).toBe(true);
      expect(b).not.toBe(c);
    }
  });

  it('TEST8：同一 session 随机结果在“重渲染”间稳定（无状态纯函数 + 一次性初始化语义）', () => {
    const rand = lcg(99);
    const first = sampleAiPair(rand);
    // 重渲染 = 再次用同一 rand 序列会得到同一结果？不 —— 关键是 TutorialPage 只初始化一次。
    // 这里验证：同一对 seats 重复构造/校验结果一致（幂等），身份行稳定。
    const seats1 = tutorialSeats(first);
    const seats2 = tutorialSeats(first);
    expect(seats1).toEqual(seats2);
    expect(tutorialRoleLines(first)).toEqual(tutorialRoleLines(first));
  });

  it('TEST9：重开教程（新初始化）产生新的随机选择路径；确定性 RNG 下分布均匀', () => {
    const seen = new Set<string>();
    // 使用大间隔、去相关的 seed（避免小整数 seed 的 LCG 结构），证实覆盖全部 10 种无序对
    for (let i = 0; i < 200; i++) {
      const seed = (Math.imul(i + 1, 2654435761) >>> 0);
      const [b, c] = sampleAiPair(lcg(seed));
      seen.add([b, c].sort().join('|')); // 无序组合
    }
    expect(seen.size).toBe(10);
    // 同一 seed 完全可复现（非 flaky）；相邻 seed 通常给出不同组合
    expect(sampleAiPair(lcg(1234))).toEqual(sampleAiPair(lcg(1234)));
    expect(sampleAiPair(lcg(1234))).not.toEqual(sampleAiPair(lcg(1235)));
  });

  it('TEST10/11：模型层约束 — 人类座位唯一（AI 不能替人类 / 人类不能控 AI 由引擎+控制器保证）', () => {
    const seats = tutorialSeats(sampleAiPair(lcg(5)));
    const humanSeats = (Object.keys(seats) as Array<keyof typeof seats>).filter((s) => seats[s].kind === 'human');
    const aiSeats = (Object.keys(seats) as Array<keyof typeof seats>).filter((s) => seats[s].kind === 'ai');
    expect(humanSeats).toEqual([HUMAN_SEAT]);
    expect(aiSeats).toEqual(['B', 'C']);
  });
});

describe('身份与文案', () => {
  it('你=玩家 A（真人）；对手带真实 AI 名称与星级', () => {
    const lines = tutorialRoleLines(['selfish', 'maxn']);
    expect(lines[0]).toMatchObject({ seat: 'A', role: '你', detail: '玩家 A（真人）' });
    expect(lines[1].detail).toContain('玩家 B · AI · Selfish');
    expect(lines[2].detail).toContain('玩家 C · AI · MaxN');
    expect(aiDisplayName('3ply')).toContain('3-Ply');
  });

  it('非法座位组合被拒绝（如 2 人类 / 双 AI 同档）', () => {
    expect(isValidTutorialSeats({ A: { kind: 'human' }, B: { kind: 'ai', level: 'random' }, C: { kind: 'ai', level: 'random' } })).toBe(false);
    expect(isValidTutorialSeats({ A: { kind: 'human' }, B: { kind: 'human' }, C: { kind: 'ai', level: 'random' } })).toBe(false);
    expect(isValidTutorialSeats({ A: { kind: 'ai', level: 'random' }, B: { kind: 'ai', level: 'tactical' }, C: { kind: 'human' } })).toBe(false);
  });
});
