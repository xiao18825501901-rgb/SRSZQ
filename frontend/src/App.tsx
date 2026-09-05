import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardSize, Player } from '../../shared/src/game/types';
import { PLAYER_COLORS, PLAYER_LABELS } from '../../shared/src/game/types';
import { useGame } from './hooks/useGame';
import { Board } from './components/Board';
import { PlayerCard } from './components/PlayerCard';
import { QualificationTimeline } from './components/QualificationTimeline';
import { MoveHistory } from './components/MoveHistory';
import { GameControls } from './components/GameControls';
import { RulesModal } from './components/RulesModal';
import { Modal, ConfirmModal } from './components/Modal';
import { DebugPanel, SetupOptions } from './components/DebugPanel';
import { SeatSetup, type SeatChoice } from './components/SeatSetup';
import { importMoves, applyAutoPassChain } from '../../shared/src/game/rules';
import { getWinningPoints, getForbiddenCells } from '../../shared/src/game/legalMoves';
import { getEligiblePlayer } from '../../shared/src/game/eligibility';
import type { GameState } from '../../shared/src/game/types';
import type { AIDecision, AILevel, SeatConfigs } from '../../shared/src/ai/types';
import { AI_LEVEL_STARS } from '../../shared/src/ai/types';
import { allHumanSeats, countAI, countHuman, isAISeat, parseSeatConfigs, serializeSeats } from '../../shared/src/ai/seats';
import { useAIController, type AIThinking } from './hooks/useAIController';

type NoticeKind = 'info' | 'pass' | 'error';

/** AI 星级展示（平台规范：用户只能看到 ★，看不到真实档位名） */
const stars = (lvl: AILevel): string => AI_LEVEL_STARS[lvl];

export default function App() {
  const game = useGame(13);
  const { state } = game;

  const [setupOpen, setSetupOpen] = useState(true);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [pendingSetupChange, setPendingSetupChange] = useState<null | { size?: BoardSize; players?: SeatConfigs }>(null);
  const [confirmNewGame, setConfirmNewGame] = useState(false);
  const [showLegal, setShowLegal] = useState(true);
  const [showWinning, setShowWinning] = useState(false);
  const [notice, setNotice] = useState<{ kind: NoticeKind; text: string } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dismissedEnd, setDismissedEnd] = useState(false);
  const [seats, setSeats] = useState<SeatConfigs>(() => allHumanSeats());
  const [aiStats, setAiStats] = useState<ReadonlyMap<number, AIDecision>>(new Map());
  const fileRef = useRef<HTMLInputElement>(null);
  const prevMovesLen = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debugMode = new URLSearchParams(window.location.search).has('debug');

  const current = game.current;
  const eligible = game.eligible;
  const round = game.round;

  /** 座位配置（正式规则仅一套；座位对本地对局直接生效） */
  const displaySeats: SeatConfigs = seats;
  const aiActive = countAI(displaySeats) > 0;

  const flash = useCallback((kind: NoticeKind, text: string, ms = 4000) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), ms);
  }, []);

  // AI 控制器：BAC 模式下自动驱动 AI 座位（串行思考/落子，锁盘，取消保护）
  const handleAIMove = useCallback((info: { player: Player; level: AILevel; recordIndex: number; decision: AIDecision }) => {
    setAiStats((prev) => {
      const m = new Map(prev);
      m.set(info.recordIndex, info.decision);
      return m;
    });
    const d = info.decision;
    console.info(
      `[SRSZQ] AI move: seat ${info.player} level ${info.level} -> (${d.row},${d.col}) reason=${d.reason ?? ''} depth=${d.depth ?? '-'} nodes=${d.nodes ?? '-'} time=${d.thinkTimeMs !== undefined ? Math.round(d.thinkTimeMs) + 'ms' : '-'}`,
    );
  }, []);
  const handleAIError = useCallback(
    (msg: string) => {
      console.error('[SRSZQ]', msg);
      flash('error', msg, 6000);
    },
    [flash],
  );
  const handleAIPassNotice = useCallback(
    (text: string) => {
      flash('pass', text, 5000);
    },
    [flash],
  );
  const ai = useAIController({
    state,
    seats: displaySeats,
    placeStone: game.placeStone,
    passTurn: game.passTurn,
    // 设置弹窗打开期间 AI 不行动（避免选座位时对局已在后台开始）
    enabled: !setupOpen,
    onAIMove: handleAIMove,
    onAIError: handleAIError,
    onAIPassNotice: handleAIPassNotice,
  });
  const thinking: AIThinking | null = ai.thinking;
  const currentIsAI = ai.currentIsAI;

  const counts = useMemo(() => {
    const stones: Record<Player, number> = { A: 0, B: 0, C: 0 };
    for (const row of state.board) for (const c of row) if (c) stones[c]++;
    const forbidden: Record<Player, number> = { A: 0, B: 0, C: 0 };
    const winPts: Record<Player, number> = { A: 0, B: 0, C: 0 };
    for (const p of ['A', 'B', 'C'] as Player[]) {
      const idx = ['A', 'B', 'C'].indexOf(p);
      const s: GameState = { ...state, turnIndex: idx };
      forbidden[p] = getForbiddenCells(s).length;
      winPts[p] = getWinningPoints(state.board, p).length;
    }
    return { stones, forbidden, winPts };
  }, [state]);

  // 新记录提示：自动 Pass
  useEffect(() => {
    const newRecords = state.moves.slice(prevMovesLen.current);
    prevMovesLen.current = state.moves.length;
    const passes = newRecords.filter((m) => m.pass);
    if (passes.length > 0) {
      setNotice({
        kind: 'pass',
        text: `自动 Pass：${passes.map((m) => `玩家 ${m.player}`).join('、')} 无合法落子，回合自动跳过。`,
      });
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 7000);
    } else if (state.moves.length > 0 && newRecords.length > 0 && !thinking) {
      setNotice(null);
    }
  }, [state, thinking]);

  // 终局弹窗在状态重置 / 悔棋后自动隐藏
  useEffect(() => {
    if (state.status === 'playing') setDismissedEnd(false);
  }, [state.status]);

  const onPlace = useCallback(
    (row: number, col: number) => {
      // AI 回合 / AI 思考中 → 棋盘锁定（点击无效）
      if (thinking) return;
      if (state.status !== 'playing') return;
      if (currentIsAI) return;
      game.placeStone(row, col);
    },
    [thinking, state.status, currentIsAI, game],
  );

  const handleSizeChange = (s: BoardSize) => {
    if (state.moves.length > 0) setPendingSetupChange((p) => ({ ...(p ?? {}), size: s }));
    else game.newGame(s);
  };

  /** 座位选择：每座位 6 选 1（人类 + 五档 AI）；至少 1 人类、至多 2 AI */
  const handleSeatChoice = (player: Player, choice: SeatChoice) => {
    const next: SeatConfigs = {
      A: { ...seats.A },
      B: { ...seats.B },
      C: { ...seats.C },
    };
    next[player] = choice === 'human' ? { kind: 'human' } : { kind: 'ai', level: choice };
    if (countHuman(next) < 1) {
      flash('error', '每局必须保留至少 1 名人类玩家（禁止三人全 AI 对弈）。');
      return;
    }
    if (state.moves.length > 0) {
      // 有落子时改座位 = 需要新开局（确认弹窗统一处理）
      setPendingSetupChange((p) => ({ ...(p ?? {}), players: next }));
      flash('info', '座位改动将在新棋局中生效（请确认）。');
    } else {
      setSeats(next);
      const n = countAI(next);
      flash(
        'info',
        n === 0
          ? '已切换为全人类对弈。'
          : `座位已更新：${['A', 'B', 'C'].filter((p) => next[p as Player].kind === 'ai').map((p) => `玩家 ${p}（AI ${stars((next[p as Player].level ?? 'random') as AILevel)}）`).join('、')} 由 AI 执棋。`,
        5000,
      );
    }
  };

  const applySetupChange = () => {
    if (!pendingSetupChange) return;
    ai.cancelAll();
    game.newGame(pendingSetupChange.size ?? state.boardSize);
    if (pendingSetupChange.players) setSeats(pendingSetupChange.players);
    setAiStats(new Map());
    setPendingSetupChange(null);
    setSetupOpen(false);
    flash('info', '已按新设置开始新棋局。');
  };

  /** 悔棋：AI 模式 = 撤销 AI 落子回到上一人类回合（含该人类自身最后一步，让其重新决策）；纯人类模式 = 单步撤销 */
  const handleUndo = () => {
    if (state.moves.length === 0) return;
    let n: number;
    let label: string;
    if (aiActive) {
      const moves = state.moves;
      let lastHuman = -1;
      for (let i = moves.length - 1; i >= 0; i--) {
        const m = moves[i];
        if (!m.pass && isAISeat(displaySeats, m.player) === false) {
          lastHuman = i;
          break;
        }
      }
      // 保留 [0..lastHuman) → 弹出 lastHuman..末尾（AI 落子 + 该人类最后一步）
      n = lastHuman < 0 ? moves.length : moves.length - lastHuman;
      label = `已悔棋到上一人类回合（撤销 ${n} 条记录，可重新落子）。`;
    } else {
      n = 1;
      label = '已悔棋一步。';
    }
    prevMovesLen.current = Math.max(0, state.moves.length - n);
    game.undoN(n);
    flash('info', label);
  };

  const doExport = () => {
    const payload = {
      boardSize: state.boardSize,
      rulesVersion: 2,
      // 座位配置 + AI 决策统计（可选字段；缺省按全人类处理）
      players: serializeSeats(displaySeats),
      moves: state.moves.map((m, i) => {
        const stat = aiStats.get(i);
        return {
          turn: m.turn,
          round: m.round,
          player: m.player,
          ...(m.pass ? { pass: true } : { row: (m.row ?? 0) + 1, col: (m.col ?? 0) + 1 }),
          ...(stat && !m.pass
            ? {
                ai: {
                  depth: stat.depth,
                  nodes: stat.nodes,
                  thinkTimeMs: stat.thinkTimeMs !== undefined ? Math.round(stat.thinkTimeMs) : undefined,
                  ttHits: stat.ttHits,
                  candidates: stat.candidates,
                  reason: stat.reason,
                },
              }
            : {}),
        };
      }),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `srszq-${state.boardSize}x${state.boardSize}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash('info', `已导出棋局 JSON（${state.moves.length} 条记录，含座位配置）。`);
  };

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as {
          boardSize?: number;
          rulesVersion?: number;
          schedule?: string; // 旧版文件残留字段（v1 规则），仅容忍存在、不参与判定
          moves?: unknown[];
          players?: unknown;
        };
        if (data.boardSize !== 13 && data.boardSize !== 17) throw new Error('boardSize 必须是 13 或 17');
        if (!Array.isArray(data.moves)) throw new Error('缺少 moves 数组');
        const imported = importMoves(data.boardSize as BoardSize, data.moves as never);
        const final = imported.status === 'playing' ? applyAutoPassChain(imported).state : imported;
        // 座位：文件带 players 时导入；否则默认全人类
        const importedSeats = data.players ? parseSeatConfigs(data.players) : allHumanSeats();
        ai.cancelAll();
        game.replaceState(final);
        setSeats(importedSeats);
        setAiStats(new Map());
        setSetupOpen(false);
        flash(
          'info',
          `已导入棋局：${final.moves.length} 步 · ${final.boardSize}×${final.boardSize} · 正式规则 v2 · ${
            final.status === 'won' ? `胜者 ${final.winner}` : final.status === 'draw' ? '和棋' : '进行中'
          }${countAI(importedSeats) > 0 ? ` · ${countAI(importedSeats)} 个 AI 座位` : ''}`,
          6000,
        );
      } catch (e) {
        setImportError(e instanceof Error ? e.message : String(e));
      }
    };
    reader.onerror = () => setImportError('读取文件失败');
    reader.readAsText(file);
  };

  const showWinModal = state.status === 'won' && !dismissedEnd;
  const showDrawModal = state.status === 'draw' && !dismissedEnd;

  // ?debug=1：暴露最小测试钩子（仅用于自动化验证 / 规则研究）
  useEffect(() => {
    if (!debugMode) return;
    const api = {
      getState: () => JSON.parse(JSON.stringify(state)),
      place: (row: number, col: number) => {
        if (thinking) return;
        game.placeStone(row - 1, col - 1);
      },
      undo: () => game.undo(),
      newGame: (size?: number) => game.newGame((size as BoardSize) ?? undefined),
      pass: () => game.passTurn(),
      seats: () => serializeSeats(displaySeats),
      setSeats: (raw: unknown) => {
        const next = parseSeatConfigs(raw);
        if (countHuman(next) < 1) return;
        if (state.moves.length > 0) return; // 仅开局前可换座位（自动化先 setSeats 再 newGame）
        setSeats(next);
      },
      aiStats: () =>
        [...aiStats.entries()]
          .filter(([i]) => i < state.moves.length)
          .map(([i, d]) => ({ index: i, row: d.row, col: d.col, depth: d.depth ?? null, nodes: d.nodes ?? null, thinkTimeMs: d.thinkTimeMs ?? null, reason: d.reason ?? null })),
      thinking: () => (thinking ? { player: thinking.player, level: thinking.level } : null),
    };
    (window as unknown as Record<string, unknown>).__tcf = api;
  }, [debugMode, state, game, thinking, aiStats, displaySeats]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo-dot logo-a" />
          <span className="logo-dot logo-b" />
          <span className="logo-dot logo-c" />
          <h1>三人四子棋</h1>
          <span className="subtitle">Three-Player Connect Four</span>
        </div>
        <div className="topbar-actions">
          <span className="cfg-chip">
            {state.boardSize}×{state.boardSize} · SRSZQ 正式规则
          </span>
          <button className="btn ghost" onClick={() => setRulesOpen(true)}>
            规则说明
          </button>
        </div>
      </header>

      <StatusBar
        current={current}
        round={round}
        eligible={eligible}
        status={state.status}
        winner={state.winner}
        aiThinking={thinking}
        currentIsAI={state.status === 'playing' && currentIsAI}
      />

      {state.status === 'playing' && !game.hasLegalMove && (
        <div className="notice pass passbar">
          {currentIsAI ? (
            <span>
              AI 玩家 {game.current}（AI {stars(isAISeat(displaySeats, game.current) ? ((displaySeats[game.current].level ?? 'random') as AILevel) : 'random')}）没有任何合法落子 —— 将自动跳过。
            </span>
          ) : (
            <span>
              玩家 {game.current} 没有任何合法落子 —— 将自动 Pass。
              {game.eligible ? `（当前胜权：玩家 ${game.eligible}，无合法步不能获胜）` : '（Round 1–5 无人有胜权）'}
            </span>
          )}
          {!currentIsAI && (
            <button
              className="btn tiny"
              onClick={() => {
                game.passTurn();
                flash('pass', `玩家 ${game.current} 自动 Pass（无合法落子）。`);
              }}
            >
              跳过 → {['A', 'B', 'C'][(['A', 'B', 'C'].indexOf(game.current) + 1) % 3]}
            </button>
          )}
        </div>
      )}

      <main className="main">
        <section className="board-col">
          <Board state={state} showLegal={showLegal} showWinning={showWinning} onCellClick={onPlace} />
          {thinking && (
            <div className="notice info ai-thinking">
              🤖 AI 思考中… 座位 {thinking.player}（AI {stars(thinking.level)}）正在计算最佳落子，棋盘已锁定。
            </div>
          )}
          {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
          <div className="players-row">
            {(['A', 'B', 'C'] as Player[]).map((p) => (
              <PlayerCard
                key={p}
                player={p}
                stoneCount={counts.stones[p]}
                isCurrent={state.status === 'playing' && current === p}
                hasEligible={state.status === 'playing' && eligible === p}
                forbiddenCount={counts.forbidden[p]}
                winningPointCount={counts.winPts[p]}
                gameOver={state.status !== 'playing'}
                seat={displaySeats[p]}
                thinking={thinking?.player === p}
              />
            ))}
          </div>
          <div className="legend muted">
            图例：<span className="legend-dot legal" /> 合法点 <span className="legend-x">✕</span> 禁手（无胜权成四）
            <span className="legend-ring ring-A" /> A胜点 <span className="legend-ring ring-B" /> B胜点 <span className="legend-ring ring-C" /> C胜点
          </div>
        </section>

        <aside className="side-col">
          <QualificationTimeline currentRound={round} highlightRound={round} />
          <GameControls
            canUndo={state.moves.length > 0}
            hasMoves={state.moves.length > 0}
            aiMode={aiActive}
            showLegal={showLegal}
            showWinning={showWinning}
            onToggleLegal={(v) => {
              setShowLegal(v);
              if (v) setShowWinning(false);
            }}
            onToggleWinning={(v) => {
              setShowWinning(v);
              if (v) setShowLegal(false);
            }}
            onNewGame={() => setConfirmNewGame(true)}
            onUndo={handleUndo}
            onExport={doExport}
            onImport={() => fileRef.current?.click()}
            onOpenSetup={() => setSetupOpen(true)}
            onOpenRules={() => setRulesOpen(true)}
          />
          <MoveHistory state={state} seats={displaySeats} aiStats={aiStats} debug={debugMode} />
          {debugMode && <DebugPanel state={state} />}
        </aside>
      </main>

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportFile(f);
          e.target.value = '';
        }}
      />

      {/* 开局设置 */}
      <Modal
        open={setupOpen}
        title="Game Setup · 开局设置"
        onClose={() => setSetupOpen(false)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setSetupOpen(false)}>
              稍后（默认 13×13）
            </button>
            <button className="btn primary" onClick={() => setSetupOpen(false)}>
              START GAME
            </button>
          </>
        }
      >
        <SetupOptions size={state.boardSize} onSize={handleSizeChange} />
        <SeatSetup seats={seats} onChange={handleSeatChoice} />
        <p className="muted">修改棋盘尺寸 / AI 座位会开始新棋局（已有落子时会先询问）。Round 1–5 无人拥有胜权；R6 起按 C → B → A 循环。AI 与人类共享同一规则引擎，AI 永远只走合法点。</p>
      </Modal>

      <ConfirmModal
        open={pendingSetupChange !== null}
        title="修改设置将开始新游戏"
        message="当前棋局已有落子。修改棋盘尺寸 / AI 座位将清空当前棋局并开始新游戏，是否继续？"
        onCancel={() => setPendingSetupChange(null)}
        onConfirm={applySetupChange}
      />

      <ConfirmModal
        open={confirmNewGame}
        title="新游戏"
        message={state.moves.length > 0 ? '是否清空当前棋局并开始新对局？（保留棋盘尺寸与 AI 座位设置）' : '开始一局新游戏？'}
        onCancel={() => setConfirmNewGame(false)}
        onConfirm={() => {
          prevMovesLen.current = 0;
          ai.cancelAll();
          game.newGame();
          setConfirmNewGame(false);
          setNotice(null);
        }}
      />

      <Modal open={importError !== null} title="导入失败" onClose={() => setImportError(null)} footer={<button className="btn primary" onClick={() => setImportError(null)}>关闭</button>}>
        <p className="error-text">{importError}</p>
      </Modal>

      {/* 胜利弹窗 */}
      <Modal
        open={showWinModal}
        title={`${state.winner} WINS · 玩家 ${state.winner} 获胜`}
        onClose={() => setDismissedEnd(true)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setDismissedEnd(true)}>
              查看棋盘
            </button>
            <button
              className="btn primary"
              onClick={() => {
                prevMovesLen.current = 0;
                ai.cancelAll();
                game.newGame();
              }}
            >
              再来一局
            </button>
          </>
        }
      >
        <div className="endgame">
          <span
            className="big-stone"
            style={{
              background: state.winner ? (state.winner === 'C' ? '#F7F7F7' : PLAYER_COLORS[state.winner]) : '#888',
              color: state.winner === 'C' ? '#333' : '#fff',
            }}
          >
            {state.winner}
          </span>
          <p>
            玩家 {state.winner}（{state.winner ? PLAYER_LABELS[state.winner] : ''}）在 R{round} 凭当前落子形成 ≥4 连，获得胜利！
          </p>
          <p className="muted">获胜连线已在棋盘上高亮显示。点击「查看棋盘」可回看终局。</p>
        </div>
      </Modal>

      {/* 和棋弹窗 */}
      <Modal
        open={showDrawModal}
        title="DRAW · 和棋"
        onClose={() => setDismissedEnd(true)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setDismissedEnd(true)}>
              查看棋盘
            </button>
            <button
              className="btn primary"
              onClick={() => {
                prevMovesLen.current = 0;
                ai.cancelAll();
                game.newGame();
              }}
            >
              再来一局
            </button>
          </>
        }
      >
        <p>棋盘已满且无人获胜，本局为和棋。</p>
      </Modal>

      {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} />}
    </div>
  );
}

function StatusBar(props: {
  current: Player;
  round: number;
  eligible: Player | null;
  status: string;
  winner: Player | null;
  aiThinking?: AIThinking | null;
  currentIsAI?: boolean;
}) {
  const { current, round, eligible, status, winner, aiThinking, currentIsAI } = props;
  const thinking = aiThinking ?? null;
  return (
    <div className="statusbar">
      <div className="status-item">
        <span className="status-label">Round</span>
        <span className="status-value big">{round}</span>
      </div>
      <div className="status-item">
        <span className="status-label">当前玩家 Turn</span>
        <span
          className={`status-value big turn-badge ${current.toLowerCase()} ${thinking ? 'thinking' : ''}`}
          style={status === 'playing' ? { borderColor: PLAYER_COLORS[current] } : undefined}
        >
          {thinking
            ? `🤖 AI 思考中（${thinking.player}·AI ${stars(thinking.level)}）`
            : status === 'playing'
              ? `${currentIsAI ? '🤖 ' : ''}玩家 ${current}${currentIsAI ? '（AI）' : ''}`
              : status === 'won'
                ? `胜者 ${winner}`
                : '和棋'}
        </span>
      </div>
      <div className="status-item">
        <span className="status-label">当前胜权 Eligible</span>
        {status !== 'playing' ? (
          <span className="status-value">—</span>
        ) : eligible === null ? (
          <span className="status-value none-badge">NONE · 无人</span>
        ) : (
          <span className={`status-value big eligible-badge ${eligible.toLowerCase()}`} style={{ borderColor: PLAYER_COLORS[eligible] }}>
            🏆 玩家 {eligible}
          </span>
        )}
      </div>
      <div className="status-item">
        <span className="status-label">资格规则</span>
        <span className="status-value">R6 起 C→B→A</span>
      </div>
      <div className="status-item">
        <span className="status-label">下轮胜权（R{round + 1}）</span>
        <span className="status-value">{nextEligible(round + 1)}</span>
      </div>
      {round <= 5 && (
        <div className="status-item wide">
          <span className="hint">Round 1–5：无人拥有胜权，所有玩家都不可形成四连（禁手）。</span>
        </div>
      )}
    </div>
  );
}

function nextEligible(round: number): string {
  const p = getEligiblePlayer(round);
  return p ?? '—';
}
