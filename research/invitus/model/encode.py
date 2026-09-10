"""Invitus 状态编码：统一 17×17 canvas（13×13 左上嵌入 + active mask）。
输出 (C,H,W) numpy float32；通道布局见 _planes()。严禁给模型未来信息。
"""
from __future__ import annotations
import sys

sys.path.insert(0, ".")
from engine import srszq

CANVAS = 17
CHANNELS = 16


def encode_state(s) -> list:
    n = s["n"]
    C = CHANNELS
    planes = [[[0.0] * CANVAS for _ in range(CANVAS)] for _ in range(C)]
    active = lambda r, c: r < n and c < n

    def fill(ci, r, c, v=1.0):
        if active(r, c):
            planes[ci][r][c] = v

    p = srszq.current_player(s)
    elig = srszq.eligible_of(s)
    # 0-2 stones
    for r in range(n):
        for c in range(n):
            x = s["board"][r][c]
            if x is not None:
                planes["ABC".index(x)][r][c] = 1.0
    # 3-5 actor
    for r in range(n):
        for c in range(n):
            planes[3 + "ABC".index(p)][r][c] = 1.0
    # 6-9 victory right
    for r in range(n):
        for c in range(n):
            if elig is None:
                planes[9][r][c] = 1.0
            else:
                planes[6 + "ABC".index(elig)][r][c] = 1.0
    # 10 last move
    if s["moves"] > 0 and s["board"] and any(any(row) for row in s["board"]):
        pass  # last-move 由调用方可选注入（无历史时省略）
    # 11 forbidden（当前行动者的禁手）
    for (r, c) in srszq.forbidden_moves(s):
        fill(11, r, c)
    # 12 active board mask
    for r in range(n):
        for c in range(n):
            planes[12][r][c] = 1.0
    # 13 board-size flag：13 → ch13=1；17 → ch14=1
    for r in range(n):
        for c in range(n):
            planes[13 if n == 13 else 14][r][c] = 1.0
    # 15 turn phase: (turnIndex % 6) / 6
    v = (s["turn"] % 6) / 6.0
    for r in range(n):
        for c in range(n):
            planes[15][r][c] = v
    return planes


def policy_target(legal, visits_map, n=17 * 17, tau=1.0):
    """稀疏 visits → 289 维分布（仅在 legal 上归一）。
    tau>1 时按 visits^(1/tau) 软化目标（防 one-hot 坍塌，默认 1.0=原行为）。"""
    out = [0.0] * (CANVAS * CANVAS)
    tot = 0.0
    for (r, c) in legal:
        v = visits_map.get((r, c), 0.0)
        softened = v ** (1.0 / tau) if tau != 1.0 else v
        out[r * CANVAS + c] = softened
        tot += softened
    if tot > 0:
        out = [x / tot for x in out]
    return out
