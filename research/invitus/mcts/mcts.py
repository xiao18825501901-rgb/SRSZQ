"""Invitus 多玩家 PUCT MCTS（prototype；NN prior 接口预留）。
- Node: N/W_ABCD/Q_ABCD/P(s,a)。
- Selection: actor-aware Q_actor + c_puct * P * sqrt(N_parent)/(1+N_child)。
- Backup: 向量 MaxN-style（leaf 值=exact solver 或 rollout 终局向量）。
- 训练：root Dirichlet noise；推理：关闭。Temperature：可配置（0=最强）。
"""
from __future__ import annotations
import copy
import math
import sys

sys.path.insert(0, ".")
from engine import srszq
from model.value import selection_utility

c_puct = 1.4


def uniform_prior(s, rng):
    legal = srszq.legal_moves(s)
    p = 1.0 / max(1, len(legal))
    return {m: p for m in legal}


def dirichlet_noise(legal, alpha, rng):
    """近似 Dirichlet：用归一化 -log(U)（无 numpy 依赖版本见下；此处用 uniform+扰动）。"""
    import random
    rnd = random.Random(rng.randint(0, 2**31 - 1))
    g = [ -math.log(max(1e-9, rnd.random())) for _ in legal ]
    tot = sum(g)
    return {m: (0.25 * (g[i] / tot) + 0.75 * (1.0 / len(legal))) for i, m in enumerate(legal)}


class Node:
    __slots__ = ("state_key", "N", "W", "children", "P", "terminal")

    def __init__(self):
        self.N = 0
        self.W = [0.0, 0.0, 0.0, 0.0]  # A,B,C,DRAW 累计
        self.children = {}
        self.P = {}
        self.terminal = None


def _key(s):
    return srszq.eligible_of(s), tuple("." if x is None else x for row in s["board"] for x in row), s["turn"]


class MCTS:
    def __init__(self, sims=64, prior_fn=uniform_prior, exact=None, rollout_sims=None, rng=None, use_dirichlet=False):
        self.sims = sims
        self.prior_fn = prior_fn
        self.exact = exact
        self.rng = rng or __import__("random").Random(0)
        self.use_dirichlet = use_dirichlet
        self.root = None

    def search(self, s0):
        root = Node()
        self.root = root
        legal = srszq.legal_moves(s0)
        if self.use_dirichlet:
            root.P = dirichlet_noise(legal, 0.3, self.rng)
        else:
            root.P = self.prior_fn(s0, self.rng)
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
                    q = (
                        selection_utility([component / child.N for component in child.W], actor)
                        if child.N
                        else 0.0
                    )
                    u = c_puct * node.P.get(m, 1e-6) * nb / (1 + child.N)
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
                if depth > 500:
                    break
            # 在 evaluate（会推进 st）之前快照叶局面，供一次性扩展
            expand_s = copy.deepcopy(st)
            value = self.evaluate(st)
            if expand_s["status"] == "playing" and depth <= 500 and not node.children:
                self.expand(expand_s, node)
            for nd in reversed(path):
                nd.N += 1
                for i in range(4):
                    nd.W[i] += value[i]
        return root

    def evaluate(self, st):
        # 调用方保证 st 为工作副本，可直接推进
        if st["status"] == "won":
            idx = srszq.PLAYERS.index(st["winner"])
            v = [0.0, 0.0, 0.0, 0.0]
            v[idx] = 1.0
            return tuple(v)
        if st["status"] == "draw":
            return (0.0, 0.0, 0.0, 1.0)
        if self.exact and self.exact.in_exact_region(st):
            return self.exact.solve(st)
        # rollout：随机合法步直到终局（或步数上限，按 draw 计）
        g = 0
        while st["status"] == "playing" and g < 300:
            legal = srszq.legal_moves(st)
            if not legal:
                srszq._advance_pass_chain(st)
                if st["status"] != "playing":
                    break
                continue
            r, c = self.rng.choice(legal)
            srszq.apply_move(st, r, c)
            g += 1
        return self.evaluate(st)

    def expand(self, st, node):
        if node.children:
            return node  # 已扩展：保留既有访问统计
        legal = srszq.legal_moves(st)
        priors = self.prior_fn(st, self.rng)
        for m in legal:
            node.children[m] = Node()
        node.P = priors
        return node

    def best_move(self, temperature=0.0):
        root = self.root
        items = list(root.children.items())
        if temperature <= 0:
            actor = None
            # 用 visit 数选（temperature=0：root visit 最高）
            best = max(items, key=lambda kv: kv[1].N)
            return best[0], {m: (ch.N, [ch.W[i] / max(1, ch.N) for i in range(4)]) for m, ch in items}
        tot = sum(ch.N ** (1.0 / temperature) for _, ch in items)
        import random
        r = self.rng.random() * tot
        for m, ch in items:
            r -= ch.N ** (1.0 / temperature)
            if r <= 0:
                return m, None
        return items[-1][0], None
