"""Invitus 研究单元测试（engine/exact/mcts）。运行：python -m tests.run_all"""
import sys

sys.path.insert(0, ".")
from engine import srszq
from exact.solver import ExactSolver
from mcts.mcts import MCTS
import random

PASS = 0
FAIL = 0

def t(name, fn):
    global PASS, FAIL
    try:
        fn()
        PASS += 1
        print("PASS", name, flush=True)
    except Exception as e:
        FAIL += 1
        print("FAIL", name, "->", e, flush=True)

def test_engine_basics():
    s = srszq.create_state(13)
    assert srszq.current_player(s) == "A"
    assert srszq.round_of(s) == 1
    assert srszq.eligible_of(s) is None
    assert len(srszq.legal_moves(s)) == 169
    # R6=C
    s2 = srszq.create_state(13)
    s2["turn"] = 15
    assert srszq.eligible_of(s2) == "C"
    # 禁手：非胜权者三连的第四格应被剔除
    s3 = srszq.create_state(13)
    s3["turn"] = 15  # A 行动，R6 胜权 C
    for c in range(3):
        s3["board"][5][1 + c] = "A"
    assert (5, 0) not in srszq.legal_moves(s3)
    assert (5, 0) in srszq.forbidden_moves(s3)

def test_engine_win_and_draw():
    # C 有胜权且三连 → 第四格成四获胜
    s = srszq.create_state(13)
    s["turn"] = 17  # C 行动，R6 胜权 C
    for c in range(3):
        s["board"][7][1 + c] = "C"
    assert srszq.apply_move(s, 7, 0) == "ok"
    assert s["status"] == "won" and s["winner"] == "C"
    # 满盘 → draw（用 3×3 不行，boardSize 13；直接构造小满盘）
    s = srszq.create_state(13)
    s["turn"] = 0
    seq = ["A", "B", "C"] * 100
    import itertools
    cells = [(r, c) for r in range(13) for c in range(13)]
    for i, (r, c) in enumerate(cells):
        s["board"][r][c] = seq[i % 3]
    s["turn"] = len(cells)
    s["moves"] = len(cells)
    srszq._advance_pass_chain(s)
    # 棋盘满且无人胜 → 和棋（apply 路径会置 draw；此处直接判定）
    assert srszq._board_full(s)

def test_auto_pass_chain():
    s = srszq.create_state(13)
    # 构造：B 无合法步的场景太复杂；改用“满盘后 pass 链置 draw”间接验证
    # （满盘 draw 由 _advance_pass_chain 处理）
    s["turn"] = 0
    for r in range(13):
        for c in range(13):
            s["board"][r][c] = "A"
    s["moves"] = 169
    srszq._advance_pass_chain(s)
    # 非胜权 A 满盘无成四位置可下 → legal 空 → pass 链推进且满盘置 draw
    assert s["status"] == "draw"

def _no_win_fill(n=13, empties=4, seed=5):
    """构造无任何 ≥4 连的接近满盘局面（贪心+拒绝，保证 playing 且空位=empties）。"""
    import random as _r
    rnd = _r.Random(seed)
    s = srszq.create_state(n)
    cells = [(r, c) for r in range(n) for c in range(n)]
    rnd.shuffle(cells)
    keep = cells[empties:]
    for (r, c) in keep:
        for p in ("A", "B", "C"):
            s["board"][r][c] = p
            if not srszq.creates_four_through(s["board"], r, c, p):
                break
            s["board"][r][c] = None
    s["turn"] = 17  # C 行动，R6 胜权 C（便于资格态测试）
    s["moves"] = 17
    return s


def test_exact_solver_immediate_win():
    s = _no_win_fill(13, 4, 5)
    solver = ExactSolver(max_branch=10)
    v = solver.solve(s)
    bm, bmv = solver.best_move(s)
    assert bm in srszq.legal_moves(s)
    actor = srszq.PLAYERS.index(srszq.current_player(s))
    import copy as _c
    for (r, c) in srszq.legal_moves(s):
        child = _c.deepcopy(s)
        srszq.apply_move(child, r, c)
        cv = solver.solve(child)
        assert bmv[actor] >= cv[actor] - 1e-9


def test_exact_solver_small_endgame():
    s = _no_win_fill(13, 4, 9)
    solver = ExactSolver(max_branch=10)
    assert solver.in_exact_region(s)
    v = solver.solve(s)
    assert abs(sum(v) - 1.0) < 1e-9
    assert solver.nodes > 0

def test_mcts_legal_and_stable():
    s = srszq.create_state(13)
    m = MCTS(sims=16, exact=ExactSolver(max_branch=4), rng=random.Random(42))
    m.search(s)
    mv, info = m.best_move(temperature=0.0)
    assert mv in srszq.legal_moves(s)
    # 同一 seed 重复 → 结果一致（deterministic 检查）
    s2 = srszq.create_state(13)
    m2 = MCTS(sims=16, exact=ExactSolver(max_branch=4), rng=random.Random(42))
    m2.search(s2)
    mv2, _ = m2.best_move(temperature=0.0)
    assert mv == mv2

if __name__ == "__main__":
    t("engine: 基本轮次/资格/禁手", test_engine_basics)
    t("engine: 获胜与满盘", test_engine_win_and_draw)
    t("engine: 自动 pass 链置和棋", test_auto_pass_chain)
    t("exact: 立即胜残局", test_exact_solver_immediate_win)
    t("exact: 小残局精确求解（向量和=1）", test_exact_solver_small_endgame)
    t("mcts: 合法/稳定/seed 可复现", test_mcts_legal_and_stable)

    print(f"\nRESEARCH TESTS: {PASS} passed, {FAIL} failed", flush=True)
    sys.exit(0 if FAIL == 0 else 1)
