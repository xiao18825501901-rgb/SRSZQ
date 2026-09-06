import { describe, expect, it } from 'vitest';
import { ELIGIBLE_ORDER, ELIGIBLE_START_ROUND } from '../../../../shared/src/game/types';
import { getEligiblePlayer } from '../../../../shared/src/game/eligibility';
import { victoryTimelineRows } from '../HowToPlay';

describe('胜权时间线 = 引擎 qualification（TEST3：UI 与 engine 一致，禁止第二套规则）', () => {
  it('R1–14 行与 getEligiblePlayer 完全一致', () => {
    const rows = victoryTimelineRows(1, 14);
    expect(rows).toHaveLength(14);
    rows.forEach((r, i) => {
      const round = i + 1;
      expect(r.round).toBe(round);
      expect(r.player).toBe(getEligiblePlayer(round));
    });
  });

  it('引擎真值锚点：R1-5 NONE；R6=C、R7=B、R8=A；之后 C→B→A 循环', () => {
    const rows = victoryTimelineRows(1, 14);
    const by = (r: number) => rows.find((x) => x.round === r)!.player;
    for (let r = 1; r <= 5; r++) expect(by(r)).toBeNull();
    expect(by(6)).toBe('C');
    expect(by(7)).toBe('B');
    expect(by(8)).toBe('A');
    expect(by(9)).toBe('C');
    expect(by(10)).toBe('B');
    expect(by(11)).toBe('A');
    expect(by(12)).toBe('C');
    expect(by(13)).toBe('B');
    expect(by(14)).toBe('A'); // (14-6)%3=2 → A
    // 与常量一致
    expect(ELIGIBLE_ORDER).toEqual(['C', 'B', 'A']);
    expect(ELIGIBLE_START_ROUND).toBe(6);
  });

  it('长区间（R97–103）循环仍与引擎一致', () => {
    const rows = victoryTimelineRows(97, 103);
    rows.forEach((r) => expect(r.player).toBe(getEligiblePlayer(r.round)));
    expect(rows.find((x) => x.round === 100)!.player).toBe('B'); // (100-6)%3=1 → B
  });

  it('isStart 标记 = ELIGIBLE_START_ROUND', () => {
    const rows = victoryTimelineRows(1, 14);
    expect(rows.find((x) => x.isStart)!.round).toBe(6);
  });
});
