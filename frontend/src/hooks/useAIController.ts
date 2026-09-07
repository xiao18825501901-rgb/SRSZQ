import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState, Player } from '../../../shared/src/game/types';
import { currentPlayerOf, getLegalMoves } from '../../../shared/src/game/legalMoves';
import { AI_LEVEL_STARS, type AIDecision, type AILevel, type MatchPolicyContext, type SeatConfigs } from '../../../shared/src/ai/types';
import { TACTIC_CONFIG } from '../../../shared/src/ai/config/defaultWeights';
import { isAISeat, seatLevel, seatsEqual } from '../../../shared/src/ai/seats';
import { makeSeed } from '../../../shared/src/ai/rng';
import { requestAIMove, type AIJobHandle } from '../../../shared/src/ai/worker/aiWorkerClient';
import { chooseAIMove } from '../../../shared/src/ai/chooseAIMove';

/** AI 思考中的状态（供 UI 锁定棋盘 / 显示） */
export interface AIThinking {
  player: Player;
  level: AILevel;
  /** 思考开始的 wall-clock 时间（用于最短展示时长） */
  startedAt: number;
}

interface PendingTurn {
  gen: number;
  turnIndex: number;
  movesLen: number;
  player: Player;
  level: AILevel;
  seatsSnapshot: SeatConfigs;
  worker: AIJobHandle;
  timer: ReturnType<typeof setTimeout> | null;
  /** 最短展示时长（结果早到也等满再落子） */
  minDisplayMs: number;
  startedAt: number;
  seed: number;
}

interface UseAIControllerArgs {
  state: GameState;
  seats: SeatConfigs;
  placeStone: (row: number, col: number) => void;
  /** 当前玩家无合法落子时的自动跳过（引擎整链推进） */
  passTurn: () => void;
  /** AI 落子成功回调（记录坐标 = state.moves 原长度） */
  onAIMove?: (info: { player: Player; level: AILevel; recordIndex: number; decision: AIDecision }) => void;
  onAIError?: (message: string) => void;
  onAIPassNotice?: (text: string) => void;
  /** 默认开启；仅 BAC 模式（CBA/CBACC 座位固定全人类） */
  enabled?: boolean;
  /** 内部对局策略上下文（NOT PLAYER-FACING；如 HvAI 1H+2AI 的 fastest-threat 防守） */
  policy?: MatchPolicyContext;
}

interface UseAIControllerResult {
  /** 当前是否有 AI 正在思考（非空时 UI 应锁定棋盘） */
  thinking: AIThinking | null;
  /** 当前行动者是否为 AI 座位 */
  currentIsAI: boolean;
  /** 取消一切在途 AI 任务（新棋局 / 导入 / 悔棋时可调用） */
  cancelAll: () => void;
}

function seedForMove(base: number, turnIndex: number, movesLen: number): number {
  return (base ^ Math.imul(turnIndex + 1, 2654435761) ^ Math.imul(movesLen + 1, 40503)) >>> 0;
}

/**
 * SRSZQ AI 自动行动控制器。
 *
 * 观察 state：若对局进行中、当前座位为 AI 且该回合尚未触发过思考，
 * 则进入 THINKING 并在 Worker 中决策；结果回来后：
 *  - 校验「代数 + 回合 + 步数 + 座位」未被外部动作（悔棋/新棋局/导入/换座位）作废；
 *  - 决策点二次对照引擎合法集（与 chooseAIMove 内部校验一致，双保险）；
 *  - 经引擎 applyMove 落子 —— 引擎仍是唯一规则来源。
 *
 * AI 回合串行：每个 AI 落子（含自动 Pass 链）后状态变化重新触发本控制器。
 * 最短展示时长按用户所选星级设置，至少显示 THINKING 一小段时间，
 * 避免“看起来没思考”的闪烁。
 */
export function useAIController(args: UseAIControllerArgs): UseAIControllerResult {
  const { state, seats, placeStone, passTurn, onAIMove, onAIError, onAIPassNotice, policy } = args;
  const enabled = args.enabled ?? true;

  const [thinking, setThinking] = useState<AIThinking | null>(null);
  const pendingRef = useRef<PendingTurn | null>(null);
  const genRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const seatsRef = useRef(seats);
  seatsRef.current = seats;

  const current = currentPlayerOf(state);
  const currentIsAI = state.status === 'playing' && enabled && isAISeat(seats, current);

  const cancelPending = useCallback((reason: string) => {
    const p = pendingRef.current;
    if (!p) return;
    genRef.current++;
    pendingRef.current = null;
    if (p.timer) clearTimeout(p.timer);
    p.worker.cancel();
    setThinking((t) => (t && t.player === p.player ? null : t));
    if (reason) console.info(`[SRSZQ] AI turn cancelled: ${reason}`);
  }, []);

  const cancelAll = useCallback(() => {
    cancelPending('external');
  }, [cancelPending]);

  // 应用一个 AI 决策（可能被最短展示时长延迟）
  const applyDecision = useCallback(
    (p: PendingTurn, decision: AIDecision) => {
      const s = stateRef.current;
      const seatsNow = seatsRef.current;
      // 结果过期 / 局面被外部改动 → 丢弃
      if (pendingRef.current !== p) return; // 已被取消
      if (genRef.current !== p.gen) return;
      if (s.status !== 'playing' || s.turnIndex !== p.turnIndex || s.moves.length !== p.movesLen) {
        cancelPending('state changed while AI thinking');
        return;
      }
      if (!isAISeat(seatsNow, p.player) || seatLevel(seatsNow, p.player) !== p.level) {
        cancelPending('seat config changed while AI thinking');
        return;
      }
      pendingRef.current = null;
      setThinking(null);

      if (decision.pass) {
        passTurn();
        return;
      }
      // 决策合法性双保险：引擎合法集为准
      const legal = getLegalMoves(s);
      let row = decision.row;
      let col = decision.col;
      if (!legal.some((m) => m.row === row && m.col === col)) {
        console.error(`[SRSZQ] AI result not in engine legal set (${p.player}/${p.level}): (${row},${col}) -> fallback`);
        if (legal.length > 0) {
          row = legal[0].row;
          col = legal[0].col;
        } else {
          passTurn();
          return;
        }
      }
      const recordIndex = s.moves.length;
      placeStone(row, col);
      onAIMove?.({ player: p.player, level: p.level, recordIndex, decision: { ...decision, row, col } });
    },
    [cancelPending, onAIMove, passTurn, placeStone],
  );

  // 主循环：取消过期任务 → 触发当前 AI 回合
  useEffect(() => {
    if (!enabled) {
      cancelPending('AI disabled');
      return;
    }
    // 1) 在途任务被外部改动作废（悔棋 / 新棋局 / 导入 / 换座位 / 终局）
    const pending = pendingRef.current;
    if (pending) {
      const stale =
        state.status !== 'playing' ||
        state.turnIndex !== pending.turnIndex ||
        state.moves.length !== pending.movesLen ||
        !seatsEqual(seats, pending.seatsSnapshot) ||
        !isAISeat(seats, pending.player) ||
        seatLevel(seats, pending.player) !== pending.level;
      if (stale) {
        cancelPending('external state/seat change');
        // 继续往下走：若新局面的当前玩家仍是 AI，直接为新回合触发思考
      } else {
        return; // 同一回合的思考已在途（含 StrictMode 双跑）
      }
    }

    if (state.status !== 'playing') return;
    const player = currentPlayerOf(state);
    if (!isAISeat(seats, player)) return;

    const legal = getLegalMoves(state);
    // 当前 AI 无合法步：引擎未自动推进（undo 重放后）→ 自动跳过
    if (legal.length === 0) {
      onAIPassNotice?.(`AI 玩家 ${player}（AI ${AI_LEVEL_STARS[seatLevel(seats, player)]}）无合法落子，自动 Pass。`);
      passTurn();
      return;
    }

    const level = seatLevel(seats, player);
    // Every difficulty may draw MaxN, so all browser turns receive the same
    // safe worker budget. Difficulty changes probabilities, not tactic power.
    const cfg = TACTIC_CONFIG.maxn;
    const gen = ++genRef.current;
    const p: PendingTurn = {
      gen,
      turnIndex: state.turnIndex,
      movesLen: state.moves.length,
      player,
      level,
      seatsSnapshot: { A: { ...seats.A }, B: { ...seats.B }, C: { ...seats.C } },
      worker: null as unknown as AIJobHandle,
      timer: null,
      minDisplayMs: 220 + (level - 1) * 70,
      startedAt: Date.now(),
      seed: seedForMove(makeSeed(), state.turnIndex, state.moves.length),
    };
    setThinking({ player, level, startedAt: p.startedAt });

    const handleResult = (r: { decision: AIDecision | null; error?: string }) => {
      const cur = pendingRef.current;
      if (!cur || cur.gen !== p.gen) return; // 已取消
      if (r.error || !r.decision) {
        // Worker 失败：主线程同步兜底（小预算），避免 AI 回合卡死
        onAIError?.(`AI 玩家 ${p.player}（AI ${AI_LEVEL_STARS[p.level]}）Worker 决策失败：${r.error ?? 'unknown'}，改用主线程兜底。`);
        let fallback: AIDecision | null = null;
        try {
          fallback = chooseAIMove(stateRef.current, p.player, p.level, {
            seed: p.seed,
            timeBudgetMs: Math.min(400, cfg.timeBudgetMs ?? 400),
            candidateK: Math.min(6, cfg.candidateK ?? 6),
            maxDepth: Math.min(4, cfg.maxDepth ?? 4),
            policy,
          });
        } catch {
          fallback = null;
        }
        if (fallback) {
          applyDecision(p, fallback);
        } else {
          const legal = getLegalMoves(stateRef.current);
          if (legal.length > 0) {
            pendingRef.current = null;
            setThinking(null);
            placeStone(legal[0].row, legal[0].col);
          } else {
            cancelPending('worker failed and no legal move');
            passTurn();
          }
        }
        return;
      }
      const elapsed = Date.now() - p.startedAt;
      const remain = p.minDisplayMs - elapsed;
      if (remain > 0) {
        p.timer = setTimeout(() => applyDecision(p, r.decision as AIDecision), remain);
      } else {
        applyDecision(p, r.decision as AIDecision);
      }
    };

    p.worker = requestAIMove(state, player, level, { seed: p.seed, timeBudgetMs: cfg.timeBudgetMs, maxDepth: cfg.maxDepth, candidateK: cfg.candidateK, policy }, handleResult);
    pendingRef.current = p;

    return () => {
      // 仅清定时器：Worker 结果由 pending/gen 校验兜底（StrictMode 双跑安全）
      if (pendingRef.current === p && p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, seats, enabled, cancelPending, applyDecision, onAIError, onAIPassNotice, passTurn]);

  // 卸载清理
  useEffect(() => {
    return () => {
      const p = pendingRef.current;
      if (p) {
        genRef.current++;
        pendingRef.current = null;
        if (p.timer) clearTimeout(p.timer);
        p.worker.cancel();
      }
    };
  }, []);

  return { thinking, currentIsAI, cancelAll };
}
