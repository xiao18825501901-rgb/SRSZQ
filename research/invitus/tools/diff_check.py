"""Differential checker：Python 训练引擎 vs Node 生成的生产引擎 oracle。
逐字段比对 currentPlayer/round/eligible/legal/forbidden/winner/status + probe apply 结果。
用法：python tools/diff_check.py <cases.jsonl>
"""
import json
import sys

sys.path.insert(0, ".")
from engine import srszq


def rebuild(case):
    n = case["boardSize"]
    s = srszq.create_state(n)
    board = case["board"]
    for r in range(n):
        for c in range(n):
            s["board"][r][c] = board[r][c]
    s["turn"] = case["turnIndex"]
    s["moves"] = case["movesLen"]
    s["status"] = case["status"]
    s["winner"] = case["winner"]
    return s


def main():
    path = sys.argv[1]
    total = 0
    mismatches = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            case = json.loads(line)
            total += 1
            s = rebuild(case)
            exp = case["expected"]
            errs = []
            if case["status"] == "playing":
                if srszq.current_player(s) != exp["currentPlayer"]:
                    errs.append("currentPlayer")
                if srszq.round_of(s) != exp["round"]:
                    errs.append("round")
                if srszq.eligible_of(s) != exp["eligible"]:
                    errs.append("eligible")
                legal = srszq.legal_moves(s)
                if sorted(legal) != sorted([tuple(x) for x in exp["legal"]]):
                    errs.append(f"legal {len(legal)}!={len(exp['legal'])}")
                forb = srszq.forbidden_moves(s)
                if sorted(forb) != sorted([tuple(x) for x in exp["forbidden"]]):
                    errs.append(f"forbidden {len(forb)}!={len(exp['forbidden'])}")
            else:
                if s["status"] != case["status"] or s["winner"] != case["winner"]:
                    errs.append("terminal")
            probe = case.get("probe")
            if probe:
                res = srszq.apply_move(s, probe["row"], probe["col"])
                post = probe["post"]
                if res != "ok" or (s["status"], s["winner"], s["turn"], s["moves"]) != (
                    post["status"], post["winner"], post["turnIndex"], post["movesLen"],
                ):
                    errs.append(f"probe apply {res} -> ({s['status']},{s['winner']},t{s['turn']},m{s['moves']})")
            if errs:
                mismatches.append((case.get("turnIndex"), errs, case.get("probe")))
            if total % 20000 == 0:
                print(f"checked {total} ... mismatches={len(mismatches)}")
    print(f"TOTAL {total} · MISMATCH {len(mismatches)}")
    for m in mismatches[:10]:
        print("MISMATCH", m)
    sys.exit(0 if not mismatches else 1)


if __name__ == "__main__":
    main()
