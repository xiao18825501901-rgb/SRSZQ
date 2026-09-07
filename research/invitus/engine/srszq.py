"""SRSZQ 正式规则引擎（Python 训练实现）。
与 shared/src/game 生产引擎逐字段对齐（differential testing 验证）。
规则真值：R1-5 无胜权；R6 起 C→B→A；仅当前胜权者可凭本手成 ≥4 获胜；
非胜权者成 ≥4 = 禁手（非法）；无合法步自动 Pass 链；满盘和棋。
"""
from __future__ import annotations

PLAYERS = ("A", "B", "C")
ELIGIBLE_ORDER = ("C", "B", "A")
ELIGIBLE_START_ROUND = 6
DIRS = ((0, 1), (1, 0), (1, 1), (1, -1))


def create_state(n: int = 13):
    return {
        "n": n,
        "board": [[None] * n for _ in range(n)],
        "turn": 0,
        "moves": 0,
        "status": "playing",
        "winner": None,
    }


def current_player(s) -> str:
    return PLAYERS[s["turn"] % 3]


def round_of(s) -> int:
    return s["turn"] // 3 + 1


def eligible_player(round_no: int):
    if round_no < ELIGIBLE_START_ROUND:
        return None
    return ELIGIBLE_ORDER[(round_no - ELIGIBLE_START_ROUND) % 3]


def eligible_of(s):
    return eligible_player(round_of(s))


def current_is_eligible(s) -> bool:
    return eligible_of(s) == current_player(s)


def creates_four_through(board, r, c, p) -> bool:
    n = len(board)
    for dr, dc in DIRS:
        run = 1
        for sign in (1, -1):
            rr, cc = r + dr * sign, c + dc * sign
            while 0 <= rr < n and 0 <= cc < n and board[rr][cc] == p:
                run += 1
                rr += dr * sign
                cc += dc * sign
        if run >= 4:
            return True
    return False


def would_form_four(s, r, c) -> bool:
    return creates_four_through(s["board"], r, c, current_player(s))


def legal_moves(s):
    """合法落子（不含禁手）。与 shared getLegalMoves 对齐。"""
    if s["status"] != "playing":
        return []
    out = []
    eligible = current_is_eligible(s)
    p = current_player(s)
    board = s["board"]
    n = s["n"]
    for r in range(n):
        for c in range(n):
            if board[r][c] is not None:
                continue
            if eligible or not creates_four_through(board, r, c, p):
                out.append((r, c))
    return out


def forbidden_moves(s):
    """禁手格（非胜权者成 ≥4 的位置，仅供 UI/训练特征）。"""
    if s["status"] != "playing" or current_is_eligible(s):
        return []
    out = []
    p = current_player(s)
    board = s["board"]
    n = s["n"]
    for r in range(n):
        for c in range(n):
            if board[r][c] is None and creates_four_through(board, r, c, p):
                out.append((r, c))
    return out


def _board_full(s) -> bool:
    return all(cell is not None for row in s["board"] for cell in row)


def _advance_pass_chain(s):
    """自动 Pass 链：与 rules.applyAutoPassChain 对齐 ——
    满盘 → 和棋；当前玩家有合法步则停止；保护上限 boardSize² 次。"""
    guard = 0
    while s["status"] == "playing":
        if _board_full(s):
            s["status"] = "draw"
            s["winner"] = None
            break
        if legal_moves(s):
            break
        s["moves"] += 1  # pass 记录
        s["turn"] += 1
        guard += 1
        if guard > s["n"] * s["n"]:  # 与生产引擎一致的死循环保护
            break


def apply_move(s, r, c):
    """落子（引擎语义）。返回 'ok' 或 'rejected:<reason>'。"""
    if s["status"] != "playing":
        return "rejected:not-playing"
    if not (0 <= r < s["n"] and 0 <= c < s["n"]) or s["board"][r][c] is not None:
        return "rejected:occupied"
    p = current_player(s)
    if not current_is_eligible(s) and creates_four_through(s["board"], r, c, p):
        return "rejected:forbidden"
    s["board"][r][c] = p
    s["moves"] += 1
    if current_is_eligible(s) and creates_four_through(s["board"], r, c, p):
        s["status"] = "won"
        s["winner"] = p
        s["turn"] += 1  # 获胜手同样计入回合推进（与生产引擎一致）
        return "ok"
    s["turn"] += 1
    if _board_full(s):
        s["status"] = "draw"
        s["winner"] = None
        return "ok"
    _advance_pass_chain(s)
    return "ok"


def outcome_vector(s):
    if s["status"] == "won":
        return tuple(1.0 if p == s["winner"] else 0.0 for p in PLAYERS) + (0.0,)
    if s["status"] == "draw":
        return (0.0, 0.0, 0.0, 1.0)
    return None
