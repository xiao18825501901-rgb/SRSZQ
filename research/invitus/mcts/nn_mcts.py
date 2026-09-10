"""Invitus 神经 MCTS：policy prior 来自网络（合法 mask 后 softmax），
叶值 = 网络 value（exact region 内改由 exact solver 精确值）。
训练：root Dirichlet noise + temperature；评估：关闭 noise、temperature=0。
"""
from __future__ import annotations
import copy
import math
import sys

sys.path.insert(0, ".")
import torch
from engine import srszq
from model import encode as enc

c_puct = 1.4


class NNode:
    __slots__ = ("N", "W", "children", "P")

    def __init__(self):
        self.N = 0
        self.W = [0.0, 0.0, 0.0, 0.0]
        self.children = {}
        self.P = {}


def dirichlet_noise(legal, alpha=0.3, rng=None):
    """纯 Dirichlet(alpha) 噪声（AlphaZero 式根节点探索噪声）。"""
    import random
    import numpy as np
    rnd = random.Random(rng.randint(0, 2**31 - 1))
    g = np.random.default_rng(rnd.getrandbits(32)).gamma(alpha, 1.0, size=len(legal))
    g = g / g.sum()
    return {m: float(g[i]) for i, m in enumerate(legal)}


class NNMCTS:
    def __init__(self, net, device, sims=16, exact=None, rng=None, train=False, c_puct=1.4, inference_service=None):
        import random
        self.net = net
        self.device = device
        self.sims = sims
        self.exact = exact
        self.rng = rng or random.Random(0)
        self.train = train
        self.c_puct = c_puct
        self.inference_service = inference_service
        self.root = None

    def _net_eval(self, s):
        if self.inference_service is not None:
            return self.inference_service.evaluate_state(s)
        import numpy as np
        planes = np.asarray(enc.encode_state(s), dtype=np.float32)[None]
        with torch.no_grad():
            logits, logv = self.net(torch.from_numpy(planes).to(self.device))
        return logits[0], torch.exp(logv)[0].cpu().tolist()

    def _prior(self, s):
        legal = srszq.legal_moves(s)
        if not legal:
            return {}
        logits, _ = self._net_eval(s)
        vals = []
        for (r, c) in legal:
            vals.append(float(logits[r * 17 + c]))
        import numpy as np
        vals = np.asarray(vals, dtype=np.float64)
        vals -= vals.max()
        e = np.exp(vals)
        e = e / e.sum()
        P = {m: float(e[i]) for i, m in enumerate(legal)}
        return P

    def search(self, s0, dirichlet_eps: float = 0.25, dirichlet_alpha: float = 0.3):
        root = NNode()
        self.root = root
        legal = srszq.legal_moves(s0)
        if not legal:
            return root
        if self.train:
            # AlphaZero 式：根先验 = (1-eps)*网络策略 + eps*Dirichlet 噪声。
            # （此前实现把噪声混进均匀分布，根节点脱离网络策略，
            #   而内部节点用网络尖先验无噪声 → 策略坍塌正反馈。）
            p_net = self._prior(s0)
            noise = dirichlet_noise(legal, alpha=dirichlet_alpha, rng=self.rng)
            root.P = {m: (1 - dirichlet_eps) * p_net[m] + dirichlet_eps * noise[m] for m in legal}
        else:
            root.P = self._prior(s0)
        for _ in range(self.sims):
            st = copy.deepcopy(s0)
            node = root
            path = [root]
            depth = 0
            while node.children and st["status"] == "playing":
                actor = srszq.PLAYERS.index(srszq.current_player(st))
                nb = math.sqrt(max(1, node.N))
                best_a, best_u = None, -1e18
                for (m, child) in node.children.items():
                    q = child.W[actor] / max(1, child.N)
                    u = self.c_puct * node.P.get(m, 1e-6) * nb / (1 + child.N)
                    val = q + u
                    if val > best_u:
                        best_a, best_u = m, val
                if best_a is None:
                    break
                node = node.children[best_a]
                path.append(node)
                r, c = best_a
                srszq.apply_move(st, r, c)
                depth += 1
                if depth > 400:
                    break
            expand_s = copy.deepcopy(st)
            value = self.evaluate(st)
            if expand_s["status"] == "playing" and not node.children:
                node.P = self._prior(expand_s)
                for m in srszq.legal_moves(expand_s):
                    node.children[m] = NNode()
            for nd in reversed(path):
                nd.N += 1
                for i in range(4):
                    nd.W[i] += value[i]
        return root

    def evaluate(self, st):
        if st["status"] == "won":
            v = [0.0, 0.0, 0.0, 0.0]
            v[srszq.PLAYERS.index(st["winner"])] = 1.0
            return tuple(v)
        if st["status"] == "draw":
            return (1 / 3, 1 / 3, 1 / 3, 0.0)
        if self.exact and self.exact.in_exact_region(st):
            return self.exact.solve(st)
        _, v = self._net_eval(st)
        return tuple(float(x) for x in v)

    def best_move(self, temperature=0.0):
        items = list(self.root.children.items())
        if temperature <= 0:
            best = max(items, key=lambda kv: kv[1].N)
            return best[0], {m: (ch.N, [ch.W[i] / max(1, ch.N) for i in range(4)]) for m, ch in items}
        tot = sum(ch.N ** (1.0 / temperature) for _, ch in items)
        r = self.rng.random() * tot
        for m, ch in items:
            r -= ch.N ** (1.0 / temperature)
            if r <= 0:
                return m, None
        return items[-1][0], None
