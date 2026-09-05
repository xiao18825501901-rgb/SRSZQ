import type { Board, Player } from '../game/types';
import { countLine } from '../game/winDetection';

/**
 * 每玩家的线型特征（供评估函数在搜索叶节点高频调用；基于整行扫描，代价 O(棋盘格数)）。
 */
export interface PlayerPatternFeatures {
  stones: number;
  /** 几何胜点数量：空点落子可形成 ≥4（无论资格） */
  winningPoints: number;
  /** 双胜点（fork）：同一空点在 ≥2 个方向都能延伸成 ≥3/≥4 结构 */
  forks: number;
  /** 两头开放的 3 连 */
  openThrees: number;
  /** 单头开放的 3 连 */
  halfOpenThrees: number;
  /** 两头开放的 2 连 */
  openTwos: number;
  /** 与己方相邻的棋子数（连通性） */
  connectivity: number;
}

/** 计算玩家 p 的线型特征（整盘扫描）。 */
export function patternFeatures(board: Board, player: Player): PlayerPatternFeatures {
  const n = board.length;
  const counts: PlayerPatternFeatures = {
    stones: 0,
    winningPoints: 0,
    forks: 0,
    openThrees: 0,
    halfOpenThrees: 0,
    openTwos: 0,
    connectivity: 0,
  };
  const winCellCount = new Map<string, number>();

  const scanLine = (cells: Array<{ r: number; c: number }>) => {
    // 直接对真实 board 扫描，避免复制
    let i = 0;
    while (i < cells.length) {
      const cell = cells[i];
      const p = board[cell.r][cell.c];
      if (p !== player) {
        i++;
        continue;
      }
      let j = i;
      while (j < cells.length && board[cells[j].r][cells[j].c] === player) j++;
      const len = j - i;
      const left = i > 0 ? cells[i - 1] : null;
      const right = j < cells.length ? cells[j] : null;
      const openLeft = !!left && board[left.r][left.c] === null;
      const openRight = !!right && board[right.r][right.c] === null;
      if (len === 3) {
        if (openLeft && openRight) counts.openThrees++;
        else if (openLeft || openRight) counts.halfOpenThrees++;
      } else if (len === 2 && openLeft && openRight) {
        counts.openTwos++;
      }
      if (len >= 3) {
        if (openLeft) bumpWin(left!);
        if (openRight) bumpWin(right!);
        // 若 len>=4 理论上已获胜/非法状态，不再计
      } else if (len >= 1) {
        // gap 桥接：len 1-2 的 run 与对侧 run 可能共享一个 gap 形成胜点 ——
        // 若左侧有 gap：检查 gap 再左侧是否紧邻同色 run，使总长 >=3 时 gap 成胜点
        if (openLeft && left) {
          const gap = left;
          const before = i - 2 >= 0 ? cells[i - 2] : null;
          if (before && board[before.r][before.c] === player) {
            // run(before..?) 向左延伸长度
            let k = i - 2;
            let leftLen = 0;
            while (k >= 0 && board[cells[k].r][cells[k].c] === player) {
              leftLen++;
              k--;
            }
            if (len + leftLen + 1 >= 4) bumpWin(gap);
          }
        }
        if (openRight && right) {
          const gap = right;
          const after = j + 1 < cells.length ? cells[j + 1] : null;
          if (after && board[after.r][after.c] === player) {
            let k = j + 1;
            let rightLen = 0;
            while (k < cells.length && board[cells[k].r][cells[k].c] === player) {
              rightLen++;
              k++;
            }
            if (len + rightLen + 1 >= 4) bumpWin(gap);
          }
        }
      }
      i = j;
    }
  };

  const bumpWin = (cell: { r: number; c: number }) => {
    const key = `${cell.r},${cell.c}`;
    winCellCount.set(key, (winCellCount.get(key) ?? 0) + 1);
  };

  // 行 / 列
  for (let r = 0; r < n; r++) {
    const cells: Array<{ r: number; c: number }> = [];
    for (let c = 0; c < n; c++) cells.push({ r, c });
    scanLine(cells);
  }
  for (let c = 0; c < n; c++) {
    const cells: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < n; r++) cells.push({ r, c });
    scanLine(cells);
  }
  // 主对角线 \（自左上到右下）
  for (let d = -(n - 1); d <= n - 1; d++) {
    const cells: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < n; r++) {
      const c = r + d;
      if (c >= 0 && c < n) cells.push({ r, c });
    }
    if (cells.length >= 4) scanLine(cells);
  }
  // 副对角线 /（自右上到左下）
  for (let d = 0; d <= 2 * (n - 1); d++) {
    const cells: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < n; r++) {
      const c = d - r;
      if (c >= 0 && c < n) cells.push({ r, c });
    }
    if (cells.length >= 4) scanLine(cells);
  }

  // 统计
  counts.stones = 0;
  for (const row of board) for (const c of row) if (c === player) counts.stones++;
  for (const [, cnt] of winCellCount) {
    if (cnt >= 1) counts.winningPoints++;
    if (cnt >= 2) counts.forks++;
  }
  // 连通性（4 邻域）
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (board[r][c] !== player) continue;
      if (r > 0 && board[r - 1][c] === player) counts.connectivity++;
      if (c > 0 && board[r][c - 1] === player) counts.connectivity++;
    }
  }
  return counts;
}

/** 单格视角：在该格落子后，沿 4 个方向的最大连续数（含自身）与开放端情况 */
export function cellLineInfo(
  board: Board,
  row: number,
  col: number,
  player: Player,
): Array<{ dir: string; run: number; openBoth: boolean; openOne: boolean }> {
  const dirs: Array<[number, number, string]> = [
    [0, 1, 'h'],
    [1, 0, 'v'],
    [1, 1, 'd'],
    [1, -1, 'a'],
  ];
  const out = [];
  for (const [dr, dc, name] of dirs) {
    const run = countLine(board, row, col, player, dr, dc);
    // 两端开放检查
    let k = 1;
    let r = row + dr * k;
    let c = col + dc * k;
    let farEnd1 = null;
    while (r >= 0 && r < board.length && c >= 0 && c < board[0].length && board[r][c] === player) {
      k++;
      r = row + dr * k;
      c = col + dc * k;
    }
    if (r >= 0 && r < board.length && c >= 0 && c < board[0].length && board[r][c] === null) farEnd1 = true;
    k = 1;
    r = row - dr * k;
    c = col - dc * k;
    let farEnd2 = null;
    while (r >= 0 && r < board.length && c >= 0 && c < board[0].length && board[r][c] === player) {
      k++;
      r = row - dr * k;
      c = col - dc * k;
    }
    if (r >= 0 && r < board.length && c >= 0 && c < board[0].length && board[r][c] === null) farEnd2 = true;
    const openBoth = farEnd1 === true && farEnd2 === true;
    const openOne = farEnd1 === true || farEnd2 === true;
    out.push({ dir: name, run, openBoth, openOne });
  }
  return out;
}

/** 在 (row,col) 落子后，该格沿 4 方向的最大连续数（含自身） */
export function maxRunThrough(board: Board, row: number, col: number, player: Player): number {
  let best = 0;
  const dirs: Array<[number, number]> = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    const run = countLine(board, row, col, player, dr, dc);
    if (run > best) best = run;
  }
  return best;
}
