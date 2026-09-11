"""Invitus Exact Endgame Solver（真·穷举，无启发剪枝）。
MaxN 向量精确求解：每个节点 actor 选择最大化自己分量的动作；平局值 [1/3,1/3,1/3]。
- Zobrist-like TT：以 canonical 盘面串为键（含 turn），避免重复展开。
- 对称规范化：D4（4 旋转 × 镜像）canonical，仅对 n=13/17 正方形盘。
- 仅当 legal_moves <= max_branch 时启动（性能实验定 N）。
"""
from __future__ import annotations
import sys

sys.path.insert(0, ".")
from engine import srszq

DRAW = (1 / 3, 1 / 3, 1 / 3, 0.0)


def _rot90(board, k):
    n = len(board)
    b = board
    for _ in range(k):
        b = [[b[n - 1 - c][r] for c in range(n)] for r in range(n)]
    return b


def _mirror(board):
    return [row[::-1] for row in board]


def _board_str(b):
    return "\n".join("".join("." if x is None else x for x in row) for row in b)


def canonical_key(s):
    """D4 对称 canonical 盘面串（棋子按座字母，不含玩家身份置换）。
    键必须含完整 turn（round 决定胜权）与 status/winner。"""
    n = s["n"]
    variants = []
    b = s["board"]
    for k in range(4):
        r = _rot90(b, k)
        variants.append(r)
        variants.append(_mirror(r))
    keys = [_board_str(v) for v in variants]
    return min(keys) + f"|t{s['turn']}|{s['status']}|{s['winner'] or '-'}"


class SolverBudgetExceeded(RuntimeError):
    pass


class ExactSolver:
    def __init__(self, max_branch: int = 10, max_nodes: int = 0):
        self.max_branch = max_branch
        self.max_nodes = max_nodes  # 0=不限；超出抛 SolverBudgetExceeded
        self.tt: dict[str, tuple] = {}
        self.nodes = 0

    def in_exact_region(self, s) -> bool:
        return s["status"] == "playing" and len(srszq.legal_moves(s)) <= self.max_branch

    def solve(self, s) -> tuple:
        """返回精确 outcome 向量 (P(A),P(B),P(C),P(DRAW))（MaxN 语义）。"""
        if self.max_nodes and self.nodes > self.max_nodes:
            raise SolverBudgetExceeded(f"nodes > {self.max_nodes}")
        if s["status"] == "won":
            idx = srszq.PLAYERS.index(s["winner"])
            v = [0.0, 0.0, 0.0, 0.0]
            v[idx] = 1.0
            return tuple(v)
        if s["status"] == "draw":
            return DRAW
        key = canonical_key(s)
        if key in self.tt:
            return self.tt[key]
        self.nodes += 1
        actor = srszq.PLAYERS.index(srszq.current_player(s))
        legal = srszq.legal_moves(s)
        best = None
        for (r, c) in legal:
            import copy
            child = copy.deepcopy(s)
            res = srszq.apply_move(child, r, c)
            assert res == "ok", res
            cv = self.solve(child)
            if best is None or cv[actor] > best[0][actor] or (
                cv[actor] == best[0][actor] and cv > best[0]
            ):
                best = (cv, (r, c))
        assert best is not None, "exact solve: no legal moves while playing"
        self.tt[key] = best[0]
        return best[0]

    def best_move(self, s):
        """精确最佳动作（actor 视角最大化；平局按向量字典序）。"""
        actor = srszq.PLAYERS.index(srszq.current_player(s))
        legal = srszq.legal_moves(s)
        best, best_vec, bm = None, None, None
        for (r, c) in legal:
            import copy
            child = copy.deepcopy(s)
            srszq.apply_move(child, r, c)
            cv = self.solve(child)
            val = cv[actor]
            if best is None or val > best or (val == best and cv > best_vec):
                best, best_vec, bm = val, cv, (r, c)
        return bm, best_vec
