import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../rng';
import type { GameState, Player } from '../../game/types';
import { applyDefensePolicy, projectedTurnsToWin, threatCellsFor } from '../defensePolicy';
import { chooseTacticMove } from '../chooseAIMove';

/** 构造 13×13 棋盘状态（turnIndex 决定 Round 与当前行动者；不经过引擎校验，仅用于策略单测） */
function makeState(turnIndex: number, stones: Array<[Player, number, number]>): GameState {
  const n = 13;
  const board = Array.from({ length: n }, () => Array<Player | null>(n).fill(null));
  for (const [p, r, c] of stones) board[r][c] = p;
  return { boardSize: 13, board, turnIndex, moves: [], status: 'playing', winner: null, winLine: null };
}

const key = (r: number, c: number) => `${r},${c}`;

describe('Online 1H+2AI Hidden Human Protection（internal）', () => {
  // acting A（3★），Human=C，另一个 AI=B；A 无自胜；C、B 各有活三 → 各有 meaningful 防守候选
  const stones: Array<[Player, number, number]> = [
    ['C', 6, 1], ['C', 6, 2], ['C', 6, 3], // Human C 活三（开放端 6,0 / 6,4）
    ['B', 8, 1], ['B', 8, 2], ['B', 8, 3], // 另一个 AI B 活三（开放端 8,0 / 8,4）
  ];

  it('HP1/HP2/HP3：3/4/5★ 无自胜且双方都有 meaningful 候选 → 优先堵另一个 AI（替换堵 Human 的决策）', () => {
    const state = makeState(21, stones); // R8，A 有资格但无胜点
    const decision = { row: 6, col: 0, pass: false, reason: 'Blocks C winning point' }; // 原决策在堵 Human
    const out = applyDefensePolicy(state, 'A', decision, { protectSingleHuman: true, humanSeat: 'C' }, mulberry32(1));
    expect(out.pass).toBe(false);
    expect([key(8, 0), key(8, 4)]).toContain(key(out.row, out.col));
  });

  it('HP4：2★ 不启用保护（chooseAIMove 层级 gating）', () => {
    const state = makeState(21, stones);
    const d = chooseTacticMove(state, 'A', 'tactical', { seed: 7, policy: { protectSingleHuman: true, humanSeat: 'C' } });
    expect(d.reason).not.toContain('Defensive preference');
  });

  it('HP5/HP6/HP7：有立即自胜 → 直接赢（保护不覆盖）', () => {
    // A 三连（2,1..3），R8（turnIndex 21）A 有资格 → (2,0)/(2,4) 是 A 的胜点
    const winStones: Array<[Player, number, number]> = [...stones, ['A', 2, 1], ['A', 2, 2], ['A', 2, 3]];
    const state = makeState(21, winStones);
    const decision = { row: 6, col: 0, pass: false, reason: 'whatever' };
    const out = applyDefensePolicy(state, 'A', decision, { protectSingleHuman: true, humanSeat: 'C' }, mulberry32(2));
    expect([key(2, 0), key(2, 4)]).toContain(key(out.row, out.col));
  });

  it('HP8：Human 是唯一真实威胁（另一个 AI 无 meaningful 威胁）→ 保持原决策（允许堵 Human）', () => {
    const onlyHuman: Array<[Player, number, number]> = [
      ['C', 6, 1], ['C', 6, 2], ['C', 6, 3],
    ];
    const state = makeState(21, onlyHuman);
    const decision = { row: 6, col: 0, pass: false, reason: 'Blocks C winning point' };
    const out = applyDefensePolicy(state, 'A', decision, { protectSingleHuman: true, humanSeat: 'C' }, mulberry32(3));
    expect(out).toEqual(decision);
  });

  it('HP9：2H+1AI 无保护（policy 未设置时不干预决策）', () => {
    const state = makeState(21, stones);
    const decision = { row: 6, col: 0, pass: false, reason: 'x' };
    const out = applyDefensePolicy(state, 'A', decision, undefined, mulberry32(4));
    expect(out).toEqual(decision);
  });
});

describe('HvAI 1H+2AI fastest-threat defense（identity 无关）', () => {
  it('H1：C 距离 1、B 距离 2 → 堵 C', () => {
    // R6（turnIndex 15，当前 A）：C 本轮即有资格（其胜点立即可赢）→ projected 2；B 活三 → projected 4
    const stones: Array<[Player, number, number]> = [
      ['C', 6, 1], ['C', 6, 2], ['C', 6, 3],
      ['B', 8, 1], ['B', 8, 2],
    ];
    const state = makeState(15, stones);
    expect(projectedTurnsToWin(state, 'C')).toBeLessThan(projectedTurnsToWin(state, 'B'));
    const out = applyDefensePolicy(state, 'A', { row: 0, col: 0, pass: false, reason: 'x' }, { defenseFastestThreat: true }, mulberry32(5));
    const cCells = threatCellsFor(state.board, 'C').map((c) => key(c.row, c.col));
    expect(cCells).toContain(key(out.row, out.col));
  });

  it('H2：A 距离 3、C 距离 8 → 堵 A（acting B；循环 C→B→A 下 A 可比 C 更快）', () => {
    // R7（turnIndex 18，当前 A→ 这里 acting=B，turnIndex 19 是 B 的行动轮）：
    // A 有胜点（geom 1），A 下一资格轮 R8（action turn 21，dist 2）；C 有胜点但 R9 才资格（dist 7）
    const stones: Array<[Player, number, number]> = [
      ['A', 6, 1], ['A', 6, 2], ['A', 6, 3],
      ['C', 8, 1], ['C', 8, 2], ['C', 8, 3],
    ];
    const state = makeState(19, stones); // turnIndex 19 → R7，当前 B（acting）
    expect(projectedTurnsToWin(state, 'A')).toBeLessThan(projectedTurnsToWin(state, 'C'));
    const out = applyDefensePolicy(state, 'B', { row: 0, col: 0, pass: false, reason: 'x' }, { defenseFastestThreat: true }, mulberry32(6));
    const aCells = threatCellsFor(state.board, 'A').map((c) => key(c.row, c.col));
    expect(aCells).toContain(key(out.row, out.col));
  });

  it('H3：两名对手 projected 相同（均无威胁 → Infinity）→ 保持原评估器决策', () => {
    const state = makeState(15, []);
    const decision = { row: 0, col: 0, pass: false, reason: 'x' };
    const out = applyDefensePolicy(state, 'A', decision, { defenseFastestThreat: true }, mulberry32(7));
    expect(out).toEqual(decision);
  });

  it('H4：acting AI 立即自胜 → 直接赢', () => {
    // R8（turnIndex 21，当前 A）：A 有资格且有三连
    const stones: Array<[Player, number, number]> = [
      ['A', 2, 1], ['A', 2, 2], ['A', 2, 3],
      ['B', 6, 1], ['B', 6, 2], ['B', 6, 3],
      ['C', 8, 1], ['C', 8, 2], ['C', 8, 3],
    ];
    const state = makeState(21, stones);
    const out = applyDefensePolicy(state, 'A', { row: 0, col: 0, pass: false, reason: 'x' }, { defenseFastestThreat: true }, mulberry32(8));
    expect([key(2, 0), key(2, 4)]).toContain(key(out.row, out.col));
  });

  it('H5：两名对手都没有可信威胁 → 保持原决策', () => {
    const state = makeState(15, []);
    const decision = { row: 0, col: 0, pass: false, reason: 'x' };
    const out = applyDefensePolicy(state, 'A', decision, { defenseFastestThreat: true }, mulberry32(9));
    expect(out).toEqual(decision);
  });
});
