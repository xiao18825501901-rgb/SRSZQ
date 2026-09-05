import { describe, expect, it } from 'vitest';
import { qualificationOf } from '../../../../shared/src/game/qualification';
import { createInitialState } from '../../../../shared/src/game/rules';
import { perspectiveLines, resolveView, rowsFromView, seatName } from '../bacTimelineModel';

const humanSeats = {
  A: { kind: 'human' as const, username: 'Alice' },
  B: { kind: 'human' as const, username: 'Bob' },
  C: { kind: 'ai' as const, stars: 3 },
};

describe('BAC 时间线 payload 渲染模型（视图 → 行）', () => {
  it('Round 1（无人持权）：NOW 行 + 未来 8 行，R6 之后开始出现持权玩家', () => {
    const rows = rowsFromView(qualificationOf(1));
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({ round: 1, player: null, isNow: true, isNext: false });
    expect(rows[1]).toMatchObject({ round: 2, player: null, isNext: true });
    // 未来窗口首个持权轮 = R6 C
    const firstHolder = rows.find((r) => r.player !== null)!;
    expect(firstHolder).toMatchObject({ round: 6, player: 'C' });
  });

  it('Round 6：当前行高亮 C，NEXT = R7 B', () => {
    const rows = rowsFromView(qualificationOf(6));
    expect(rows[0]).toMatchObject({ round: 6, player: 'C', isNow: true });
    expect(rows[1]).toMatchObject({ round: 7, player: 'B', isNext: true });
  });

  it('resolveView：优先服务器 payload；缺省时用共享引擎从 state 计算（同一规则源）', () => {
    const payload = qualificationOf(8);
    const state15 = { ...createInitialState(13), turnIndex: 15 }; // Round 6
    expect(resolveView(payload, state15)).toBe(payload);
    const fallback = resolveView(null, state15);
    expect(fallback?.currentRound).toBe(6);
    expect(fallback?.currentEligible).toBe('C');
    expect(resolveView(null, null)).toBeNull();
  });
});

describe('座位名与玩家视角文案', () => {
  it('seatName：自己=You / 真人带用户名 / AI 仅星级', () => {
    expect(seatName('A', humanSeats, 'A')).toBe('You');
    expect(seatName('B', humanSeats, 'A')).toBe('Player B · Bob');
    expect(seatName('C', humanSeats, 'A')).toBe('AI ★★★');
    expect(seatName('A', null, null)).toBe('Player A');
  });

  it('持权者是自己 → YOUR VICTORY WINDOW 文案', () => {
    const p = perspectiveLines('B', 'B', humanSeats);
    expect(p?.yours).toBe(true);
    expect(p?.en).toBe('You currently have the legal winning right.');
  });

  it('持权者是其他玩家 → 防守提示', () => {
    const p = perspectiveLines('A', 'C', humanSeats);
    expect(p?.yours).toBe(false);
    expect(p?.en).toBe('AI ★★★ currently has winning right.');
    expect(p?.zh).toContain('注意防守');
  });

  it('无人持权（R1-5）→ 无视角文案（面板显示 VICTORY LOCKED）', () => {
    expect(perspectiveLines('A', null, humanSeats)).toBeNull();
  });
});
