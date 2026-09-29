/**
 * SRSZQ P3B(B6) —— 评测矩阵聚合（规格 6.3 / 验收 D06、D08）。
 *
 * 研究协议要求“不能只给 pooled 胜率”，所以这里强制按
 * 棋盘尺寸 × 对手族 × 档位 × 座位 分层，并且把**合法性/崩溃/延迟**一起记录。
 *
 * 关于校准：现有五档不输出胜率估计（`AIDecision.score` 是启发式分数，不是概率），
 * 因此本模块**不编造** ECE/Brier，而是把它标成 NOT_AVAILABLE 并写明原因。
 */
import { stableDigest } from '../product/resultModel.js';

export type OpponentFamily = 'SAME_LEVEL' | 'MIXED_LEVEL' | 'CHALLENGER_VS_5';

export interface GameRecord {
  gameId: string;
  boardSize: 13 | 17;
  family: OpponentFamily;
  /** 被视为“被测方”的档位（该档位在三个座位各出现一次为最理想）。 */
  subjectLevel: number;
  /** 每一档实际坐过的座位。 */
  seatByLevel: Record<string, 'A' | 'B' | 'C'>;
  /** 终局：赢家座位或 null（和棋/未结束）。 */
  winnerSeat: 'A' | 'B' | 'C' | null;
  status: 'won' | 'draw' | 'open';
  plies: number;
  /** 被测档位所在座位的胜负。 */
  subjectOutcome: 'WIN' | 'LOSS' | 'DRAW' | 'UNKNOWN';
  illegalMoveAttempts: number;
  crashes: number;
  providerRefusals: number;
  passCount: number;
  latenciesMs: number[];
  nodes: number[];
  movesHash: string;
}

export interface LatencyStats { count: number; p50: number; p95: number; max: number }

export interface CellStats {
  boardSize: number;
  family: OpponentFamily;
  level: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  illegalMoveAttempts: number;
  crashes: number;
  providerRefusals: number;
  latency: LatencyStats;
  pliesAvg: number;
}

export interface SeatStats { seat: 'A' | 'B' | 'C'; games: number; wins: number; winRate: number }

export interface EvalMatrix {
  generatedAt: number;
  boardSizes: number[];
  families: OpponentFamily[];
  levels: number[];
  gamesPerCell: number;
  totalGames: number;
  cells: CellStats[];
  bySeat: SeatStats[];
  /** 座位是否被均匀覆盖（研究协议要求 A/B/C 三座充分覆盖）。 */
  seatBalanceNote: string;
  calibration: { status: 'NOT_AVAILABLE' | 'REPORTED'; reason: string };
  legalityRate: number;
  crashCount: number;
  illegalMoveAttempts: number;
  reproducibility: { checkedGames: number; identical: boolean; note: string };
  matrixHash: string;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

export function latencyStats(values: number[]): LatencyStats {
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.round(Math.max(...values) * 100) / 100 : 0 };
}

export function aggregateMatrix(records: GameRecord[], meta: {
  boardSizes: number[]; families: OpponentFamily[]; levels: number[]; gamesPerCell: number;
  generatedAt?: number;
}): EvalMatrix {
  const cells: CellStats[] = [];
  for (const boardSize of meta.boardSizes) {
    for (const family of meta.families) {
      for (const level of meta.levels) {
        const group = records.filter((r) => r.boardSize === boardSize && r.family === family && r.subjectLevel === level);
        if (group.length === 0) continue;
        const wins = group.filter((r) => r.subjectOutcome === 'WIN').length;
        const losses = group.filter((r) => r.subjectOutcome === 'LOSS').length;
        const draws = group.filter((r) => r.subjectOutcome === 'DRAW').length;
        const latencies = group.flatMap((r) => r.latenciesMs);
        cells.push({
          boardSize, family, level, games: group.length, wins, losses, draws,
          winRate: group.length ? Math.round((wins / group.length) * 1000) / 1000 : 0,
          illegalMoveAttempts: group.reduce((n, r) => n + r.illegalMoveAttempts, 0),
          crashes: group.reduce((n, r) => n + r.crashes, 0),
          providerRefusals: group.reduce((n, r) => n + r.providerRefusals, 0),
          latency: latencyStats(latencies),
          pliesAvg: Math.round((group.reduce((n, r) => n + r.plies, 0) / group.length) * 10) / 10,
        });
      }
    }
  }

  const seats: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
  const bySeat: SeatStats[] = seats.map((seat) => {
    const group = records.filter((r) => r.winnerSeat === seat || (r.winnerSeat === null && r.status !== 'won'));
    const wins = records.filter((r) => r.winnerSeat === seat).length;
    return { seat, games: group.length, wins, winRate: records.length ? Math.round((wins / records.length) * 1000) / 1000 : 0 };
  });

  const totalDecisions = records.reduce((n, r) => n + r.latenciesMs.length, 0);
  const illegal = records.reduce((n, r) => n + r.illegalMoveAttempts, 0);
  const crashes = records.reduce((n, r) => n + r.crashes, 0);
  const seatCounts = seats.map((s) => bySeat.find((x) => x.seat === s)!.wins);
  const spread = Math.max(...seatCounts) - Math.min(...seatCounts);

  const matrix: EvalMatrix = {
    generatedAt: meta.generatedAt ?? Date.now(),
    boardSizes: meta.boardSizes,
    families: meta.families,
    levels: meta.levels,
    gamesPerCell: meta.gamesPerCell,
    totalGames: records.length,
    cells,
    bySeat,
    seatBalanceNote:
      '每局三个座位各坐一个配置并轮转；座位胜场差 ' + spread + '（理想为 0）。' +
      '样本量 ' + records.length + ' 局不足以做统计显著性判断，因此不给置信区间结论。',
    calibration: {
      status: 'NOT_AVAILABLE',
      reason: '现有五档 AI 不输出胜率估计：AIDecision.score 是启发式分数而非概率，无法计算 ECE/Brier/log-loss。',
    },
    legalityRate: totalDecisions === 0 ? 0 : Math.round(((totalDecisions - illegal) / totalDecisions) * 1000) / 1000,
    crashCount: crashes,
    illegalMoveAttempts: illegal,
    reproducibility: { checkedGames: 0, identical: false, note: '由运行器填充：同种子重跑比对逐手序列。' },
    matrixHash: '',
  };
  matrix.matrixHash = matrixHashOf(records);
  return matrix;
}

/** 逐局逐手序列的哈希：同种子重跑必须得到同一个值（可复现实测）。 */
export function matrixHashOf(records: GameRecord[]): string {
  const canonical = [...records]
    .map((r) => [r.gameId, r.boardSize, r.family, r.subjectLevel, r.movesHash, r.subjectOutcome, r.plies].join('|'))
    .sort()
    .join('\n');
  return stableDigest(canonical);
}

export function findCell(matrix: EvalMatrix, boardSize: number, family: OpponentFamily, level: number): CellStats | null {
  return matrix.cells.find((c) => c.boardSize === boardSize && c.family === family && c.level === level) ?? null;
}
