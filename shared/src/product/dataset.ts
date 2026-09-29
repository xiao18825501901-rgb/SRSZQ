/**
 * SRSZQ P3A(B5) —— 训练数据集构建（规格 6.1 / 6.2 数据卫生）。
 *
 * 做三件事，每件都对应规格里的一句话：
 *  1. **先按整盘划分**：切分单位是 gameId（不是单步/单局面），同一局不跨 train/dev/test；
 *     不同规则版本与棋盘尺寸分桶，不混在一起。
 *  2. **空间 8 对称去重 + 聚类防泄漏**：棋子坐标做 8 种空间变换后取最小 stateDigest 作为规范键；
 *     共享任一规范局面的对局属于同一聚类，聚类内必须落在同一个 split；
 *     整条轨迹的规范形式完全相同（互为镜像）的对局视为重复样本，只保留一份。
 *  3. **绝不做颜色置换**：规格明写红绿白标签置换**不等价**（资格时间与固定行动序都会变），
 *     所以 8 变换只动空间坐标、不动颜色。把它当“优化”做掉会直接污染训练集。
 *
 * stateKey 复用 replay.ts 的 stateDigest：已含棋盘尺寸 / ruleset / turnIndex 与资格 phase / 终局语义。
 */
import type { BoardSize } from '../game/types.js';
import { applyMove, createInitialState } from '../game/rules.js';
import { stableDigest } from './resultModel.js';
import { stateDigest } from './replay.js';
import type { TrailMove } from './puzzleBank.js';
import { decideGameTrainingEligibility, TRAINING_CONSENT_VERSION, type ConsentDecision } from './consent.js';

export type DatasetSplit = 'train' | 'dev' | 'test';
export type TrajectorySource = 'HUMAN' | 'SYNTHETIC' | 'RESEARCH';

export interface DatasetCandidate {
  gameId: string;
  rulesetVersion: string;
  boardSize: BoardSize;
  mode: string;
  source: TrajectorySource;
  moves: TrailMove[];
  terminal: 'win' | 'draw' | 'open';
  /** 内部账号标识：只在服务端参与许可判定，绝不进导出物。 */
  participantUserIds: string[];
  createdAt: number;
}

/** 8 种空间变换（不换色）。 */
const TRANSFORMS: Array<(r: number, c: number, n: number) => [number, number]> = [
  (r, c) => [r, c],
  (r, c, n) => [c, n - 1 - r],
  (r, c, n) => [n - 1 - r, n - 1 - c],
  (r, c, n) => [n - 1 - c, r],
  (r, c, n) => [r, n - 1 - c],
  (r, c, n) => [n - 1 - r, c],
  (r, c) => [c, r],
  (r, c, n) => [n - 1 - c, n - 1 - r],
];

export const SYMMETRY_TRANSFORM_COUNT = TRANSFORMS.length;

/** 一组互为对称的摘要 → 规范键（取字典序最小）。对称局面集合相同，因此规范键必然相同。 */
export function canonicalStateKey(digests: string[]): string {
  return [...digests].sort()[0] ?? '';
}

export interface TrajectoryKeys {
  /** 原始坐标下逐手的 stateKey */
  keys: string[];
  /** 每一手在 8 对称下的规范键 */
  canonicalKeys: string[];
  /** 整条轨迹的规范哈希：8 个变体里最小的那一条序列 */
  canonicalTrajectoryHash: string;
  /** 8 个变体是否全部合法完成（不合法说明坐标映射有问题，必须报错而不是静默） */
  variants: number;
}

export function trajectoryStateKeys(boardSize: BoardSize, moves: TrailMove[], rulesetVersion: string): TrajectoryKeys {
  const variants: string[][] = [];
  for (const t of TRANSFORMS) {
    let state = createInitialState(boardSize);
    const seq: string[] = [];
    for (const m of moves) {
      const [r, c] = t(m.row, m.col, boardSize);
      const res = applyMove(state, r, c);
      if (res.rejected) throw new Error('空间对称变换后出现非法手：' + res.rejected + '（坐标映射必须合法可逆）');
      state = res.state;
      seq.push(stateDigest(state, rulesetVersion));
    }
    variants.push(seq);
  }
  const canonicalKeys: string[] = [];
  for (let i = 0; i < moves.length; i += 1) {
    canonicalKeys.push(canonicalStateKey(variants.map((v) => v[i] ?? '')));
  }
  const sequences = variants.map((v) => v.join('>'));
  const canonicalTrajectoryHash = stableDigest([...sequences].sort()[0] ?? '');
  return { keys: variants[0] ?? [], canonicalKeys, canonicalTrajectoryHash, variants: variants.length };
}

export interface DatasetPolicy {
  consentVersion: string;
  /** 少于这么多手的对局不进数据集（残局/秒退对棋力学习没价值）。 */
  minPlies: number;
  /** 是否丢弃互为空间镜像的重复轨迹（默认丢）。 */
  dropSymmetricDuplicates: boolean;
}

export const DEFAULT_DATASET_POLICY: DatasetPolicy = {
  consentVersion: TRAINING_CONSENT_VERSION,
  minPlies: 6,
  dropSymmetricDuplicates: true,
};

export interface DatasetEntry {
  gameId: string;
  split: DatasetSplit;
  source: TrajectorySource;
  boardSize: BoardSize;
  rulesetVersion: string;
  mode: string;
  plies: number;
  consentVersion: string | null;
  canonicalTrajectoryHash: string;
  symmetricClusterId: string;
  clusterSize: number;
}

export type ExclusionReason = 'NO_TRAINING_CONSENT' | 'TOO_FEW_PLIES' | 'SYMMETRIC_DUPLICATE' | 'TRAJECTORY_REJECTED';

export interface ExcludedEntry { gameId: string; reason: ExclusionReason; detail: string }

export interface DatasetManifest {
  policy: DatasetPolicy;
  generatedAt: number;
  entries: DatasetEntry[];
  excluded: ExcludedEntry[];
  bySplit: Record<string, number>;
  bySource: Record<string, number>;
  byBoardSize: Record<string, number>;
  /** 规格 6.3：不能只给 pooled 数字，这里给分层计数。 */
  bySplitSource: Record<string, number>;
  symmetricClusters: number;
  symmetricDuplicatesDropped: number;
  clusterSplitMoves: number;
  /** test 只用于最终评估：显式声明不得用于选权重（规格 6.2）。 */
  testForWeightSelection: false;
  datasetHash: string;
}

function splitOf(gameId: string, rulesetVersion: string, boardSize: BoardSize): DatasetSplit {
  const n = parseInt(stableDigest(rulesetVersion + ':' + boardSize + ':' + gameId).slice(0, 8), 16) % 3;
  return n === 0 ? 'train' : n === 1 ? 'dev' : 'test';
}

export function buildDataset(
  candidates: DatasetCandidate[],
  consentOf: (userId: string) => ConsentDecision,
  policy: DatasetPolicy = DEFAULT_DATASET_POLICY,
  now = Date.now(),
): DatasetManifest {
  const excluded: ExcludedEntry[] = [];
  interface Kept { candidate: DatasetCandidate; split: DatasetSplit; consentVersion: string | null; hash: string; turnKeys: string[] }
  const eligible: Kept[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.gameId.localeCompare(b.gameId))) {
    if (candidate.source === 'HUMAN') {
      const verdict = decideGameTrainingEligibility(candidate.participantUserIds, consentOf);
      if (!verdict.allowed) {
        excluded.push({
          gameId: candidate.gameId,
          reason: 'NO_TRAINING_CONSENT',
          detail: '参与者未授权：' + verdict.blockedBy.map((b) => b.reason).join(','),
        });
        continue;
      }
    }
    if (candidate.moves.length < policy.minPlies) {
      excluded.push({ gameId: candidate.gameId, reason: 'TOO_FEW_PLIES', detail: '仅 ' + candidate.moves.length + ' 手' });
      continue;
    }
    let keys: TrajectoryKeys;
    try {
      keys = trajectoryStateKeys(candidate.boardSize, candidate.moves, candidate.rulesetVersion);
    } catch (e) {
      excluded.push({ gameId: candidate.gameId, reason: 'TRAJECTORY_REJECTED', detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    eligible.push({
      candidate,
      split: splitOf(candidate.gameId, candidate.rulesetVersion, candidate.boardSize),
      consentVersion: candidate.source === 'HUMAN' ? policy.consentVersion : null,
      hash: keys.canonicalTrajectoryHash,
      turnKeys: keys.canonicalKeys,
    });
  }

  // 对称去重：整条轨迹互为镜像（规范哈希相同）只留第一局。
  const byHash = new Map<string, Kept[]>();
  for (const e of eligible) {
    const list = byHash.get(e.hash) ?? [];
    list.push(e);
    byHash.set(e.hash, list);
  }
  let dropped = 0;
  const kept: Kept[] = [];
  for (const list of byHash.values()) {
    kept.push(list[0]);
    if (list.length > 1 && policy.dropSymmetricDuplicates) {
      dropped += list.length - 1;
      for (const dup of list.slice(1)) {
        excluded.push({ gameId: dup.candidate.gameId, reason: 'SYMMETRIC_DUPLICATE', detail: '与 ' + list[0].candidate.gameId + ' 互为空间镜像' });
      }
    }
  }
  kept.sort((a, b) => a.candidate.gameId.localeCompare(b.candidate.gameId));

  // 聚类防泄漏：共享任一规范局面的对局必须落在同一个 split（取聚类内最小 gameId 的 split）。
  const keyOwner = new Map<string, number>();
  const parent = kept.map((_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) x = parent[x];
    let y = i;
    while (parent[y] !== x) { const next = parent[y]; parent[y] = x; y = next; }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  kept.forEach((e, i) => {
    for (const k of new Set(e.turnKeys)) {
      const owner = keyOwner.get(k);
      if (owner === undefined) keyOwner.set(k, i);
      else union(owner, i);
    }
  });
  const clusterSplit = new Map<number, DatasetSplit>();
  kept.forEach((e, i) => {
    const root = find(i);
    if (!clusterSplit.has(root)) clusterSplit.set(root, e.split);
  });
  const clusterMembers = new Map<number, number>();
  kept.forEach((_, i) => { const root = find(i); clusterMembers.set(root, (clusterMembers.get(root) ?? 0) + 1); });
  let moved = 0;
  const entries: DatasetEntry[] = kept.map((e, i) => {
    const root = find(i);
    const split = clusterSplit.get(root) ?? e.split;
    if (split !== e.split) moved += 1;
    return {
      gameId: e.candidate.gameId,
      split,
      source: e.candidate.source,
      boardSize: e.candidate.boardSize,
      rulesetVersion: e.candidate.rulesetVersion,
      mode: e.candidate.mode,
      plies: e.candidate.moves.length,
      consentVersion: e.consentVersion,
      canonicalTrajectoryHash: e.hash,
      symmetricClusterId: stableDigest('cluster:' + e.candidate.gameId + ':' + (kept[root]?.candidate.gameId ?? '')).slice(0, 12),
      clusterSize: clusterMembers.get(root) ?? 1,
    };
  });

  const count = (key: (x: DatasetEntry) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const x of entries) out[key(x)] = (out[key(x)] ?? 0) + 1;
    return out;
  };
  const manifest: DatasetManifest = {
    policy,
    generatedAt: now,
    entries,
    excluded,
    bySplit: count((x) => x.split),
    bySource: count((x) => x.source),
    byBoardSize: count((x) => String(x.boardSize)),
    bySplitSource: count((x) => x.split + '/' + x.source),
    symmetricClusters: new Set(entries.map((x) => x.symmetricClusterId)).size,
    symmetricDuplicatesDropped: dropped,
    clusterSplitMoves: moved,
    testForWeightSelection: false,
    datasetHash: '',
  };
  manifest.datasetHash = datasetHashOf(manifest);
  return manifest;
}

export function datasetHashOf(manifest: DatasetManifest): string {
  const canonical = [...manifest.entries]
    .map((x) => [x.gameId, x.split, x.source, x.boardSize, x.plies, x.canonicalTrajectoryHash].join('|'))
    .sort()
    .join('\n');
  const policy = manifest.policy;
  return stableDigest(canonical + '\n' + policy.consentVersion + ':' + policy.minPlies + ':' + policy.dropSymmetricDuplicates);
}

/** 导出物：**不含** 内部账号标识 / 邮箱 / IP / 会话（规格 6.1）。 */
export function toExportRecord(entry: DatasetEntry): Record<string, unknown> {
  return {
    gameId: entry.gameId,
    split: entry.split,
    source: entry.source,
    boardSize: entry.boardSize,
    rulesetVersion: entry.rulesetVersion,
    mode: entry.mode,
    plies: entry.plies,
    consentVersion: entry.consentVersion,
    canonicalTrajectoryHash: entry.canonicalTrajectoryHash,
    symmetricClusterId: entry.symmetricClusterId,
  };
}