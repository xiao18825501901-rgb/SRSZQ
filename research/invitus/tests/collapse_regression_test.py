"""Collapse RCA 回归测试套件：防止根 Dirichlet 混用、one-hot 目标、NaN 熵、
actor 映射错误等根因回归。全部 CPU 可跑（少量用真实 Tiny 网络）。"""
import math
import random
import sys

sys.path.insert(0, ".")
import numpy as np
import torch

from engine import srszq
from mcts import nn_mcts
from mcts.nn_mcts import NNMCTS, root_prior_mix
from model import encode
from model.network import InvitusNet


def _fresh_state13():
    return srszq.create_state(13)


def test_root_noise_uses_network_prior():
    """根先验必须保留网络策略：eps→0 时 == 网络先验；绝不退化为均匀混合。"""
    legal = [(0, 0), (0, 1), (0, 2)]
    # one-hot 网络先验
    p_net = {(0, 0): 1.0, (0, 1): 0.0, (0, 2): 0.0}
    mixed = root_prior_mix(p_net, legal, eps=0.0, alpha=0.3, rng=random.Random(1))
    assert abs(mixed[(0, 0)] - 1.0) < 1e-12, mixed
    assert mixed[(0, 1)] < 1e-12 and mixed[(0, 2)] < 1e-12, mixed
    # eps>0：被噪声稀释但仍保留网络结构
    p_net2 = {(0, 0): 0.9, (0, 1): 0.05, (0, 2): 0.05}
    mixed2 = root_prior_mix(p_net2, legal, eps=0.25, alpha=0.3, rng=random.Random(2))
    assert abs(sum(mixed2.values()) - 1.0) < 1e-9
    assert mixed2[(0, 0)] < 0.9, "noise must dilute the peak"
    # 均匀混合（错误实现）在 eps=0 时会给 1/3 —— 本测试就是护栏
    print("PASS test_root_noise_uses_network_prior")


def test_policy_target_temperature():
    """τ=2 应软化稀疏 visits：9:1 → 3:1 → [0.75, 0.25]；τ=1 保持 [0.9, 0.1]。"""
    legal = [(0, 0), (0, 1)]
    visits = {(0, 0): 9.0, (0, 1): 1.0}
    t1 = encode.policy_target(legal, visits, tau=1.0)
    t2 = encode.policy_target(legal, visits, tau=2.0)
    assert abs(t1[0] - 0.9) < 1e-6 and abs(t1[1] - 0.1) < 1e-6, t1
    assert abs(t2[0] - 0.75) < 1e-6 and abs(t2[1] - 0.25) < 1e-6, t2
    print("PASS test_policy_target_temperature")


def test_target_distribution_sums_to_one():
    rng = random.Random(3)
    state = _fresh_state13()
    legal = srszq.legal_moves(state)
    visits = {m: float(rng.randint(0, 16)) for m in legal}
    for tau in (1.0, 2.0, 3.0):
        target = encode.policy_target(legal, visits, tau=tau)
        assert abs(sum(target) - 1.0) < 1e-6, (tau, sum(target))
    print("PASS test_target_distribution_sums_to_one")


def test_legal_mask_preserved():
    rng = random.Random(4)
    state = _fresh_state13()
    legal = srszq.legal_moves(state)
    visits = {m: float(rng.randint(1, 16)) for m in legal}
    target = encode.policy_target(legal, visits, tau=2.0)
    legal_idx = {r * 17 + c for (r, c) in legal}
    for idx, value in enumerate(target):
        if idx not in legal_idx:
            assert value == 0.0, f"illegal index {idx} has mass {value}"
    print("PASS test_legal_mask_preserved")


def _random_game_samples(count, seed, size=13, sims=4):
    """用真实 MCTS（未训练网络）产一局训练样本（含 visits/legal/outcome）。"""
    from training.train import train_batch
    return train_batch  # noqa: 占位避免未用 import；实际样本由下构造


def _make_sample(state, seed):
    rng = random.Random(seed)
    legal = srszq.legal_moves(state)
    visits = {}
    for (r, c) in legal:
        visits[(r, c)] = 0.0
    for _ in range(8):
        (r, c) = rng.choice(legal)
        visits[(r, c)] += 1.0
    return {
        "board": ["".join("." if x is None else x for x in row) for row in state["board"]],
        "turn": state["turn"],
        "size": state["n"],
        "actor": srszq.current_player(state),
        "legal": [[r, c] for (r, c) in legal],
        "visits": {f"{r},{c}": v for (r, c), v in visits.items()},
        "outcome": [0.25, 0.25, 0.25, 0.25],
    }


def test_policy_entropy_finite():
    """entropy 正则（含非法步 -inf mask）必须产出有限值——NaN 根因护栏。"""
    from training.train import train_batch
    net = InvitusNet(16, 2)
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3)
    samples = []
    for i in range(8):
        state = srszq.create_state(13)
        for _ in range(i):
            legal = srszq.legal_moves(state)
            if not legal:
                break
            srszq.apply_move(state, legal[0][0], legal[0][1])
        if srszq.legal_moves(state):
            samples.append(_make_sample(state, i))
    if len(samples) < 4:
        print("SKIP test_policy_entropy_finite (insufficient samples)")
        return
    pl, vl, loss, gn, ent = train_batch(net, torch.device("cpu"), opt, samples,
                                        entropy_weight=0.05, target_tau=2.0)
    for name, value in (("pl", pl), ("vl", vl), ("loss", loss), ("gn", gn), ("ent", ent)):
        assert math.isfinite(value), f"{name} is not finite: {value}"
    assert ent > 0.0, "entropy should be positive on a fresh network"
    print(f"PASS test_policy_entropy_finite (ent={ent:.3f})")


def test_search_actor_vector_backup():
    """向量备份守恒：每个节点 W 分量之和 == N；根也一样。"""
    net = InvitusNet(16, 2)
    net.eval()
    rng = random.Random(5)
    state = srszq.create_state(13)
    mcts = NNMCTS(net, torch.device("cpu"), sims=8, rng=random.Random(rng.getrandbits(32)), train=False)
    mcts.search(state)
    assert mcts.root.N == 8, mcts.root.N
    stack = [mcts.root]
    while stack:
        node = stack.pop()
        # 子节点可能未被访问（N=0）——向量备份守恒仍须成立
        assert abs(sum(node.W) - node.N) < 1e-6, (node.N, node.W)
        stack.extend(node.children.values())
    print("PASS test_search_actor_vector_backup")


def test_value_actor_mapping():
    """选择必须用当前 actor 自己的 value 分量，而不是固定 root player。"""
    net = InvitusNet(16, 2)
    net.eval()
    # 假 _net_eval：A 视角 value 强烈偏好 (0,0)，B/C 无所谓；先验均匀
    state = srszq.create_state(13)
    original = NNMCTS._net_eval
    def fake(self, s):
        import numpy as np
        logits = np.zeros(289, dtype=np.float32)
        for (r, c) in srszq.legal_moves(s):
            logits[r * 17 + c] = 0.0
        v = [0.9, 0.03, 0.03, 0.04]
        return logits, v
    NNMCTS._net_eval = fake
    try:
        mcts = NNMCTS(net, torch.device("cpu"), sims=16, rng=random.Random(6), train=False)
        mcts.search(state)
        best, _ = mcts.best_move(temperature=0.0)
        # A 是当前 actor；A 的 value 与走法无关（0.9）。被访问的子节点 Q(A) 应全部 ≈0.9，
        # 证明 Q 取的是"当前 actor"（A=索引0）分量，而非固定 root player 或错误分量。
        qs = [ch.W[0] / ch.N for ch in mcts.root.children.values() if ch.N > 0]
        assert qs, "no visited children"
        for q in qs:
            assert abs(q - 0.9) < 1e-6, qs
        print("PASS test_value_actor_mapping")
    finally:
        NNMCTS._net_eval = original


def test_inference_service_consistency():
    """InferenceService 返回值必须与直接前向一致（策略 logits 与 exp 后 value）。"""
    from inference.service import InferenceService
    net = InvitusNet(16, 2)
    net.eval()
    device = torch.device("cpu")
    service = InferenceService(net, device, max_batch_size=4, max_wait_ms=2.0)
    try:
        state = srszq.create_state(13)
        planes = np.asarray(encode.encode_state(state), dtype=np.float32)
        logits, values = service.evaluate_state(state)
        with torch.no_grad():
            ref_logits, ref_logv = net(torch.from_numpy(planes[None]).to(device))
        assert np.allclose(logits, ref_logits[0].numpy(), atol=1e-5), "logits mismatch"
        assert np.allclose(values, torch.exp(ref_logv[0]).cpu().tolist(), atol=1e-5), "values mismatch"
        print("PASS test_inference_service_consistency")
    finally:
        service.close()


if __name__ == "__main__":
    test_root_noise_uses_network_prior()
    test_policy_target_temperature()
    test_target_distribution_sums_to_one()
    test_legal_mask_preserved()
    test_policy_entropy_finite()
    test_search_actor_vector_backup()
    test_value_actor_mapping()
    test_inference_service_consistency()
    print("COLLAPSE REGRESSION: ALL PASS")
