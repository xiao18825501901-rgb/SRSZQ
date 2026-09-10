"""One-game debug: candidate (A) vs random tactic (B, C) with move/value logging."""
import random
import sys
from pathlib import Path

import torch

sys.path.insert(0, ".")
from engine import srszq
from eval.champion_gate import load_checkpoint_network
from mcts.nn_mcts import NNMCTS
from training.league import TacticBridge

CKPT = "/root/autodl-tmp/invitus/official/checkpoints/invitus_005000_major.pt"
net, meta = load_checkpoint_network(CKPT, torch.device("cuda"))
print("ckpt meta", meta, flush=True)
bridge = TacticBridge(Path("/root/SRSZQ"))
rng = random.Random(7)
state = srszq.create_state(13)
move_no = 0
while state["status"] == "playing" and move_no < 60:
    seat = srszq.current_player(state)
    legal = srszq.legal_moves(state)
    if not legal:
        srszq._advance_pass_chain(state)
        continue
    if seat == "A":
        search = NNMCTS(net, torch.device("cuda"), sims=16, exact=None,
                        rng=random.Random(rng.getrandbits(32)), train=False)
        search.search(state)
        top = sorted(search.root.children.items(), key=lambda kv: -kv[1].N)[:5]
        print(f"A move {move_no} turn {state['turn']} top=", flush=True)
        for (r, c), child in top:
            q = child.W[0] / max(1, child.N)
            p = search.root.P.get((r, c), 0.0) if isinstance(search.root.P, dict) else 0.0
            print(f"   ({r},{c}) N={int(child.N)} Q={q:.3f} P={p:.4f}", flush=True)
        mv, _ = search.best_move(temperature=0.0)
        print("   chosen", mv, flush=True)
    else:
        mv = bridge.move(state, seat, "random", rng.getrandbits(31))
    srszq.apply_move(state, mv[0], mv[1])
    move_no += 1
print("result", state["status"], state.get("winner"), flush=True)
bridge.close()
