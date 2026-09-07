"""Ledger verifier：统计唯一 game_id（formal + pilot 分开），重复 id 不重复计数。"""
import json
import sys
from collections import Counter


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "logs/INVICTUS_TRAINING_LEDGER.jsonl"
    formal = set()
    pilot = set()
    dup = 0
    rows = 0
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rows += 1
                rec = json.loads(line)
                gid = rec.get("game_id")
                bucket = formal if rec.get("kind") == "formal" else pilot
                if gid in bucket or gid in (formal | pilot):
                    dup += 1
                bucket.add(gid)
    except FileNotFoundError:
        pass
    print(f"rows={rows} unique_formal_episodes={len(formal)} unique_pilot_games={len(pilot)} duplicate_ids={dup}")
    sys.exit(0)


if __name__ == "__main__":
    main()
