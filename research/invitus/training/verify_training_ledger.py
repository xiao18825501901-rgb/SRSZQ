"""Ledger verifier（硬约束版）：
- 只统计 kind=formal 且 completed=True 且 num_samples>0 且 game_id 唯一的记录；
- 输出 formal/board/seat 分布与 duplicates/invalid。
用法：python training/verify_training_ledger.py [ledger]
"""
import json
import sys
from collections import Counter


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "logs/INVICTUS_TRAINING_LEDGER.jsonl"
    seen = set()
    formal = 0
    dup = 0
    invalid = 0
    by_board = Counter()
    by_result = Counter()
    pilot = 0
    rows = 0
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rows += 1
                rec = json.loads(line)
                if rec.get("kind") == "pilot":
                    pilot += 1
                    continue
                gid = rec.get("game_id")
                ok = (
                    rec.get("kind") == "formal"
                    and rec.get("completed") is True
                    and int(rec.get("num_samples", 0) > 0)
                    and gid
                )
                if gid in seen:
                    dup += 1
                    ok = False
                if gid:
                    seen.add(gid)
                if ok:
                    formal += 1
                    by_board[str(rec.get("board_size"))] += 1
                    by_result[str(rec.get("terminal_result"))] += 1
                else:
                    invalid += 1
    except FileNotFoundError:
        pass
    print(f"rows={rows} FORMAL_UNIQUE_COMPLETED={formal} pilot={pilot} duplicates={dup} invalid={invalid}")
    print(f"boards={dict(by_board)} results={dict(by_result)}")
    sys.exit(0)


if __name__ == "__main__":
    main()
