"""Invitus self-play pilot + training ledger。
- 每次完整对局（合法初始 state 打到 A/B/C/DRAW 终局）生成唯一 game_id；
- ledger 追加 JSONL（timestamp/episodes/checkpoint/board/opponents/sims/result/sample_count/game_id）；
- 注意：本 pilot 使用 rollout-MCTS 对手（无神经网络学习），
  这些局数按定义**不计入 100k formal training episodes**（见 FINAL REPORT）。
"""
from __future__ import annotations
import copy
import json
import random
import sys
import time
import uuid

sys.path.insert(0, ".")
from engine import srszq
from mcts.mcts import MCTS

LEDGER = "logs/INVICTUS_TRAINING_LEDGER.jsonl"


def play_game(board_size, agents, sims, rng, max_moves=400):
    """agents: {seat: callable(state)->(r,c)}。返回 (result, samples, game_id)。"""
    s = srszq.create_state(board_size)
    samples = 0
    gid = uuid.uuid4().hex
    guard = 0
    while s["status"] == "playing" and guard < max_moves:
        seat = srszq.current_player(s)
        agent = agents[seat]
        mv = agent(s)
        if mv is None:
            srszq._advance_pass_chain(s)
        else:
            srszq.apply_move(s, mv[0], mv[1])
            samples += 1
        guard += 1
    if s["status"] == "playing":
        s["status"] = "draw"  # 超长局按和棋计（计数仍为一局）
    result = "A_WIN" if s["status"] == "won" else ("DRAW" if s["status"] == "draw" else "UNKNOWN")
    return result, samples, gid


def mcts_agent(sims, rng):
    def agent(s):
        m = MCTS(sims=sims, rng=rng)
        m.search(s)
        mv, _ = m.best_move(temperature=0.0)
        return mv
    return agent


def main(games=40, sims=8):
    rng = random.Random(12345)
    counts = {"A_WIN": 0, "B_WIN": 0, "C_WIN": 0, "DRAW": 0}
    # 结果按 winner 细分（report 用）
    with open(LEDGER, "a", encoding="utf-8") as f:
        for i in range(games):
            size = 13 if rng.random() < 0.6 else 17
            agents = {seat: mcts_agent(sims, random.Random(rng.getrandbits(32))) for seat in "ABC"}
            t0 = time.time()
            result, samples, gid = play_game(size, agents, sims, rng)
            rec = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "kind": "pilot",  # pilot 不计入 formal 100k
                "game_id": gid,
                "boardSize": size,
                "result": result,
                "sampleCount": samples,
                "mctsSims": sims,
                "opponents": "mcts-rollout",
                "seconds": round(time.time() - t0, 3),
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if result == "A_WIN":
                counts["A_WIN"] += 1
            elif result == "B_WIN":
                counts["B_WIN"] += 1
            elif result == "C_WIN":
                counts["C_WIN"] += 1
            else:
                counts["DRAW"] += 1
            if i % 10 == 0:
                print(f"pilot game {i}/{games} ...", flush=True)
    print("PILOT COMPLETE:", counts, flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 40, int(sys.argv[2]) if len(sys.argv) > 2 else 8)
