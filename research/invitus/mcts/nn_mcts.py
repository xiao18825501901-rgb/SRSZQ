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
from model.value import actor_utility, output_to_absolute

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


def root_prior_mix(p_net, legal, eps=0.25, alpha=0.3, rng=None):
    """AlphaZero 根先验：(1-eps)*网络策略 + eps*Dirichlet 噪声。
    （绝不能是 eps*Dirichlet + (1-eps)*均匀 —— 那是 5K 政策坍塌根因。）"""
    noise = dirichlet_noise(legal, alpha=alpha, rng=rng)
    return {m: (1 - eps) * p_net[m] + eps * noise[m] for m in legal}


class NNMCTS:
    def __init__(self, net, device, sims=16, exact=None, rng=None, train=False, c_puct=1.4, inference_service=None,
                 value_representation=None):
        import random
        self.net = net
        self.device = device
        self.sims = sims
        self.exact = exact
        self.rng = rng or random.Random(0)
        self.train = train
        self.c_puct = c_puct
        self.inference_service = inference_service
        self.value_representation = value_representation or getattr(
            net, "value_representation", getattr(inference_service, "value_representation", "absolute")
        )
        self.root = None
        self.root_network_prior = {}
        self.root_network_value = ()

    def _net_eval(self, s):
        if self.inference_service is not None:
            logits, raw_value = self.inference_service.evaluate_state(s)
        else:
            import numpy as np
            planes = np.asarray(enc.encode_state(s), dtype=np.float32)[None]
            with torch.no_grad():
                logits_batch, logv = self.net(torch.from_numpy(planes).to(self.device))
            logits = logits_batch[0]
            raw_value = torch.exp(logv)[0].cpu().tolist()
        absolute = output_to_absolute(raw_value, srszq.current_player(s), self.value_representation)
        return logits, list(absolute)

    def _prior_with_value(self, s):
        legal = srszq.legal_moves(s)
        if not legal:
            return {}, ()
        logits, value = self._net_eval(s)
        vals = []
        for (r, c) in legal:
            vals.append(float(logits[r * 17 + c]))
        import numpy as np
        vals = np.asarray(vals, dtype=np.float64)
        vals -= vals.max()
        e = np.exp(vals)
        e = e / e.sum()
        P = {m: float(e[i]) for i, m in enumerate(legal)}
        return P, tuple(float(x) for x in value)

    def _prior(self, s):
        return self._prior_with_value(s)[0]

    def search(self, s0, dirichlet_eps: float = 0.25, dirichlet_alpha: float = 0.3):
        root = NNode()
        self.root = root
        legal = srszq.legal_moves(s0)
        if not legal:
            return root
        p_net, root_value = self._prior_with_value(s0)
        self.root_network_prior = dict(p_net)
        self.root_network_value = root_value
        if self.train:
            # AlphaZero 式：根先验 = (1-eps)*网络策略 + eps*Dirichlet 噪声。
            root.P = root_prior_mix(p_net, legal, eps=dirichlet_eps, alpha=dirichlet_alpha, rng=self.rng)
        else:
            root.P = p_net
        for _ in range(self.sims):
            st = copy.deepcopy(s0)
            node = root
            path = [root]
            depth = 0
            while node.children and st["status"] == "playing":
                actor = srszq.current_player(st)
                nb = math.sqrt(max(1, node.N))
                best_a, best_u = None, -1e18
                for (m, child) in node.children.items():
                    q = actor_utility(child.W, actor) / max(1, child.N)
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
            return (0.0, 0.0, 0.0, 1.0)
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
