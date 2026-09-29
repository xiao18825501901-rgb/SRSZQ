/**
 * SRSZQ P2(B4) —— 棋谱重放 / 状态摘要 / 可解释关键片段（纯逻辑，前端与后端共用同一份实现）。
 *
 * 规格来源：reference_spec/01_PRODUCT_IMPLEMENTATION_SPEC_CN.md
 *   5.1 Phase A 不依赖 LLM 的解释（ReviewEvidence）
 *   5.2 分析交付（终局先给至多 3 个关键片段，变化必须可合法重放）
 *   6.1 标准数据（stateKey 必须含棋盘尺寸 / ruleset / turnIndex 与资格 phase / 终局语义）
 * 验收矩阵：R02 全谱重放、R03 关键三手、R04 跨轮防守、R05 多个好动作。
 *
 * 三条写在实现里的红线（都是规格明写的，不是我的风格偏好）：
 *  1. 摘要只用于检索/审计/证据绑定，**不是**服务器防篡改的充分证明（规格 6.1）。
 *  2. 只输出精确一步事实（EXACT_ONE_PLY）：某空点此刻是否让某人成四、某点是否已被占。
 *     本模块不产生 SEARCH_ESTIMATE，因此不存在把启发式估值说成胜率的代码路径。
 *  3. points / alternativeLines 列出**全部**已证明答案；绝不把引擎选出的那一个说成唯一正确解。
 */
import type { BoardSize, CellPos, GameState, Player } from '../game/types.js';
import { applyMove, createInitialState } from '../game/rules.js';
import { getEligiblePlayer, playerFromTurn, roundFromTurn } from '../game/eligibility.js';
import { getForbiddenCells, getWinningPoints, isLegalMove } from '../game/legalMoves.js';
import { RULESET_VERSION } from './protocol.js';
import { stableDigest } from './resultModel.js';

/** 从 game_events 读出的一条持久事件。 */
export interface PersistedEvent {
  seq: number;
  revision: number;
  type: string;
  payload: unknown;
  createdAt?: number;
}

export interface ReplayStep {
  seq: number;
  revision: number;
  seat: Player;
  row: number;
  col: number;
  /** 落子前的全局回合序号（0-based） */
  turnIndex: number;
  round: number;
  /** 本回合胜权归属（R1-5 为 null） */
  eligiblePlayer: Player | null;
  actorEligible: boolean;
  /** 这一手之后被自动 Pass 的玩家 */
  autoPassed: Player[];
}

/** 逐手快照（仅供关键片段计算使用，**不进入 API 响应**）。 */
export interface ReplayFrame {
  before: GameState;
  after: GameState;
}

export interface ReplayOutcome {
  ok: boolean;
  rulesetVersion: string;
  boardSize: BoardSize;
  steps: ReplayStep[];
  frames: ReplayFrame[];
  skippedEvents: number;
  initialHash: string;
  finalHash: string;
  state: GameState;
  errors: string[];
  expectedHash: string | null;
  /** null = 没有可比对的期望摘要 */
  hashMatches: boolean | null;
}

/**
 * 状态摘要（stateKey）。规格 6.1 要求它必须包含：棋盘尺寸、ruleset、
 * turnIndex 与资格 phase、终局语义 —— 因此这些字段一个都不能少。
 */
export function stateDigest(state: GameState, rulesetVersion: string = RULESET_VERSION): string {
  const round = roundFromTurn(state.turnIndex);
  const board = state.board
    .map((row) => row.map((c) => (c === null ? '.' : c)).join(''))
    .join('/');
  return stableDigest(
    JSON.stringify({
      rulesetVersion,
      boardSize: state.boardSize,
      board,
      turnIndex: state.turnIndex,
      round,
      turn: playerFromTurn(state.turnIndex),
      eligible: getEligiblePlayer(round),
      status: state.status,
      winner: state.winner,
      winLine: state.winLine ? state.winLine.map((p) => [p.row, p.col]) : null,
    }),
  );
}

function frameOf(state: GameState): GameState {
  // 快照不含 moves：关键片段只依赖盘面/回合/资格，省掉逐手 moves 数组的复制。
  return {
    boardSize: state.boardSize,
    board: state.board.map((r) => r.slice()),
    turnIndex: state.turnIndex,
    moves: [],
    status: state.status,
    winner: state.winner,
    winLine: state.winLine ? state.winLine.map((p) => ({ ...p })) : null,
  };
}

/**
 * 全谱重放：**逐手走真实引擎**（applyMove：资格/禁手/自动 Pass 全部生效），
 * 而不是把坐标直接写进盘面。落子被引擎拒绝即 ok=false —— 伪造或跨规则版本的棋谱
 * 会在这里暴露，而不是被安静地重放成一个看起来合理的终局。
 */
export function replayGame(
  boardSize: BoardSize,
  events: readonly PersistedEvent[],
  opts: { expectedHash?: string | null; rulesetVersion?: string } = {},
): ReplayOutcome {
  const rulesetVersion = opts.rulesetVersion ?? RULESET_VERSION;
  const errors: string[] = [];
  const steps: ReplayStep[] = [];
  const frames: ReplayFrame[] = [];
  let skippedEvents = 0;
  let state = createInitialState(boardSize);
  const initialHash = stateDigest(state, rulesetVersion);

  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    if (ev.type !== 'move.applied') {
      skippedEvents += 1;
      continue;
    }
    const payload = (ev.payload ?? {}) as { seat?: unknown; row?: unknown; col?: unknown };
    const row = Number(payload.row);
    const col = Number(payload.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      errors.push('seq ' + ev.seq + ': 事件缺少合法坐标');
      break;
    }
    const expectedSeat = playerFromTurn(state.turnIndex);
    const seat = typeof payload.seat === 'string' ? (payload.seat as Player) : expectedSeat;
    if (seat !== expectedSeat) {
      errors.push('seq ' + ev.seq + ': 事件座位 ' + seat + ' 与行动序 ' + expectedSeat + ' 不一致');
      break;
    }
    const turnIndex = state.turnIndex;
    const round = roundFromTurn(turnIndex);
    const eligiblePlayer = getEligiblePlayer(round);
    const before = frameOf(state);
    const res = applyMove(state, row, col);
    if (res.rejected) {
      errors.push('seq ' + ev.seq + ': 第 ' + (steps.length + 1) + ' 手 (' + row + ',' + col + ') 被引擎拒绝: ' + res.rejected);
      break;
    }
    const after = frameOf(res.state);
    frames.push({ before, after });
    steps.push({
      seq: ev.seq,
      revision: ev.revision,
      seat,
      row,
      col,
      turnIndex,
      round,
      eligiblePlayer,
      actorEligible: eligiblePlayer === seat,
      autoPassed: res.autoPassed,
    });
    state = res.state;
  }

  const finalHash = stateDigest(state, rulesetVersion);
  const expectedHash = opts.expectedHash ?? null;
  return {
    ok: errors.length === 0,
    rulesetVersion,
    boardSize,
    steps,
    frames,
    skippedEvents,
    initialHash,
    finalHash,
    state,
    errors,
    expectedHash,
    hashMatches: expectedHash === null ? null : expectedHash === finalHash,
  };
}

export type ReviewType = 'IMMEDIATE_WIN' | 'MISSED_WIN' | 'PREEMPTIVE_BLOCK';
export type ReviewCertainty = 'EXACT_ONE_PLY' | 'EXACT_BOUNDED' | 'SEARCH_ESTIMATE';

export interface ReviewAlternative {
  row: number;
  col: number;
  /** 该点在当时的局面下是否合法（不合法 = 禁手/占位） */
  legal: boolean;
  /** 该点是否即刻成四 */
  winning: boolean;
}

export interface ReviewMove {
  ply: number;
  type: ReviewType;
  actorSeat: Player;
  row: number;
  col: number;
  round: number;
  turnIndex: number;
  eligiblePlayer: Player | null;
  actorEligible: boolean;
  /** 本手当时的禁手格数量（有胜权时为 0） */
  forbiddenCells: number;
  /** 涉事的所有已证明点（MISSED_WIN 为全部致胜点，不是引擎选中的那一个） */
  points: CellPos[];
  referenceLine: CellPos[];
  alternativeLines: ReviewAlternative[];
  certainty: ReviewCertainty;
  /** 精确一步事实的证明视界；本模块恒为 1 */
  proofHorizon: number;
  /** 精确检查过的候选格数量（预算口径，不是搜索节点估计） */
  nodes: number;
  wallMs: number;
  messageKey: string;
  args: Record<string, string | number>;
}

function futureTurnOf(actor: Player, turnIndex: number, target: Player): number {
  const seats: Player[] = ['A', 'B', 'C'];
  const delta = (seats.indexOf(target) - seats.indexOf(actor) + 3) % 3;
  return turnIndex + (delta === 0 ? 3 : delta);
}

/**
 * 关键片段（规格 5.2：终局至多 3 段）。只用精确一步事实：
 *  - IMMEDIATE_WIN：本手即终局致胜（precise）。
 *  - MISSED_WIN：该手玩家当时有胜权、且存在合法致胜点，却下在别处。
 *  - PREEMPTIVE_BLOCK：本手占掉了某对手在其**下一个真实行动回合**（且该回合它有胜权）的致胜点。
 * 三点说明（避免把话说大）：
 *  - 遮挡是精确的（该点此后不可用），但**不**声称这一手决定了胜负。
 *  - 不声称对手必然合作，也不给任何一方按“恶意/送分”定性。
 *  - 无可证明片段时返回空数组，不编造解释。
 */
export function reviewKeyMoves(outcome: ReplayOutcome, limit = 3): ReviewMove[] {
  const started = Date.now();
  const wins: ReviewMove[] = [];
  const missed: ReviewMove[] = [];
  const blocks: ReviewMove[] = [];

  for (let i = 0; i < outcome.frames.length; i += 1) {
    const step = outcome.steps[i];
    const frame = outcome.frames[i];
    let nodes = 0;
    const t0 = Date.now();
    if (step.actorEligible && frame.before.status === 'playing') {
      const points = getWinningPoints(frame.before.board, step.seat);
      nodes += frame.before.boardSize * frame.before.boardSize;
      const legalPoints = points.filter((p) => isLegalMove(frame.before, p.row, p.col));
      const playedIsWinning = points.some((p) => p.row === step.row && p.col === step.col);
      if (legalPoints.length > 0 && !playedIsWinning) {
        missed.push({
          ply: i + 1,
          type: 'MISSED_WIN',
          actorSeat: step.seat,
          row: step.row,
          col: step.col,
          round: step.round,
          turnIndex: step.turnIndex,
          eligiblePlayer: step.eligiblePlayer,
          actorEligible: true,
          forbiddenCells: 0,
          points: legalPoints,
          referenceLine: [],
          alternativeLines: legalPoints.slice(0, 2).map((p) => ({ row: p.row, col: p.col, legal: true, winning: true })),
          certainty: 'EXACT_ONE_PLY',
          proofHorizon: 1,
          nodes,
          wallMs: Date.now() - t0,
          messageKey: 'KEY_MOVE_MISSED_WIN',
          args: {
            seat: step.seat,
            round: step.round,
            row: step.row,
            col: step.col,
            points: legalPoints.length,
          },
        });
      }
    }
    if (frame.after.status === 'won' && frame.after.winner === step.seat) {
      wins.push({
        ply: i + 1,
        type: 'IMMEDIATE_WIN',
        actorSeat: step.seat,
        row: step.row,
        col: step.col,
        round: step.round,
        turnIndex: step.turnIndex,
        eligiblePlayer: step.eligiblePlayer,
        actorEligible: step.actorEligible,
        forbiddenCells: 0,
        points: [{ row: step.row, col: step.col }],
        referenceLine: frame.after.winLine ? frame.after.winLine.map((p) => ({ ...p })) : [],
        alternativeLines: [],
        certainty: 'EXACT_ONE_PLY',
        proofHorizon: 1,
        nodes: 1,
        wallMs: Date.now() - t0,
        messageKey: 'KEY_MOVE_IMMEDIATE_WIN',
        args: { seat: step.seat, round: step.round, row: step.row, col: step.col },
      });
    } else {
      for (const other of ['A', 'B', 'C'] as Player[]) {
        if (other === step.seat) continue;
        const nextTurn = futureTurnOf(step.seat, step.turnIndex, other);
        const nextRound = roundFromTurn(nextTurn);
        if (getEligiblePlayer(nextRound) !== other) continue;
        const threatened = getWinningPoints(frame.before.board, other);
        nodes += frame.before.boardSize * frame.before.boardSize;
        if (!threatened.some((p) => p.row === step.row && p.col === step.col)) continue;
        blocks.push({
          ply: i + 1,
          type: 'PREEMPTIVE_BLOCK',
          actorSeat: step.seat,
          row: step.row,
          col: step.col,
          round: step.round,
          turnIndex: step.turnIndex,
          eligiblePlayer: step.eligiblePlayer,
          actorEligible: step.actorEligible,
          forbiddenCells: step.actorEligible ? 0 : getForbiddenCells(frame.before).length,
          points: [{ row: step.row, col: step.col }],
          referenceLine: [],
          alternativeLines: [],
          certainty: 'EXACT_ONE_PLY',
          proofHorizon: 1,
          nodes,
          wallMs: Date.now() - t0,
          messageKey: 'KEY_MOVE_PREEMPTIVE_BLOCK',
          args: {
            seat: step.seat,
            threatened: other,
            row: step.row,
            col: step.col,
            round: step.round,
            eligibleRound: nextRound,
          },
        });
        break;
      }
    }
  }

  const picked: ReviewMove[] = [];
  // 顺序固定：终局致胜 → 最接近终局的一次错失 → 最接近终局的一次跨轮遮挡。
  if (wins.length) picked.push(wins[wins.length - 1]);
  if (missed.length) picked.push(missed[missed.length - 1]);
  if (blocks.length) picked.push(blocks[blocks.length - 1]);
  const sliced = picked.slice(0, Math.max(0, limit));
  if (sliced.length) sliced[0].wallMs = Date.now() - started;
  return sliced;
}

/** 一个“某对手在某格成四”的威胁窗口（R04：从威胁出现到真实兑现前的全部动作）。 */
export interface ThreatWindow {
  threatenedSeat: Player;
  row: number;
  col: number;
  openedAtPly: number;
  /** 该点被占掉的那一手；null = 直到终局都没有被占 */
  resolvedAtPly: number | null;
  resolvedBySeat: Player | null;
  /** 窗口内发生的**全部**动作手序号（含兑现那一手，含第三方、含隔轮） */
  actions: number[];
  /** 兑现方是否为受威胁者本人（自己用掉了这个点） */
  selfResolved: boolean;
  certainty: ReviewCertainty;
}

/**
 * 跨轮防守窗口。规格 5.1 明写：“前瞻按真实行动序从威胁出现时计算资格动作，
 * 不能只数当前 Round 剩余玩家” —— 所以 actions 收录窗口内所有真实动作，
 * 不做“只看受威胁者自己那几手”的偷懒统计。
 * 同理，联合可防**不**写成“两个对手必然合作”：这里只记录事实，不做动机推断。
 */
export function threatWindows(outcome: ReplayOutcome): ThreatWindow[] {
  const open = new Map<string, ThreatWindow>();
  const done: ThreatWindow[] = [];
  const seats: Player[] = ['A', 'B', 'C'];
  const beforeAny = outcome.frames.length ? outcome.frames[0].before : null;
  if (!beforeAny) return done;

  const openAt = (ply: number, state: GameState): void => {
    for (const seat of seats) {
      for (const p of getWinningPoints(state.board, seat)) {
        const key = seat + ':' + p.row + ':' + p.col;
        if (open.has(key)) continue;
        open.set(key, {
          threatenedSeat: seat,
          row: p.row,
          col: p.col,
          openedAtPly: ply,
          resolvedAtPly: null,
          resolvedBySeat: null,
          actions: [],
          selfResolved: false,
          certainty: 'EXACT_ONE_PLY',
        });
      }
    }
  };
  openAt(0, beforeAny);

  for (let i = 0; i < outcome.steps.length; i += 1) {
    const step = outcome.steps[i];
    const ply = i + 1;
    const closing: string[] = [];
    for (const [key, w] of open) {
      if (w.row === step.row && w.col === step.col) closing.push(key);
      else w.actions.push(ply);
    }
    for (const key of closing) {
      const w = open.get(key)!;
      w.resolvedAtPly = ply;
      w.resolvedBySeat = step.seat;
      w.actions.push(ply);
      w.selfResolved = step.seat === w.threatenedSeat;
      done.push(w);
      open.delete(key);
    }
    openAt(ply, outcome.frames[i].after);
  }
  for (const w of open.values()) done.push(w);
  return done;
}

/** 由棋谱推导的落子序列（可供前端逐步播放，不含内部座位/用户标识之外的任何东西）。 */
export function moveListOf(outcome: ReplayOutcome): Array<{ ply: number; seat: Player; row: number; col: number; round: number }> {
  return outcome.steps.map((s, i) => ({ ply: i + 1, seat: s.seat, row: s.row, col: s.col, round: s.round }));
}

/** 棋盘尺寸守卫：只接受 13/17，其他一律拒绝而不是猜。 */
export function asBoardSize(v: unknown): BoardSize | null {
  return v === 13 || v === 17 ? v : null;
}
