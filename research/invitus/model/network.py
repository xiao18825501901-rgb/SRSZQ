"""InvitusNet：Residual CNN。输入 (B,16,17,17)；输出 policy logits (B,289) + value (B,4)。
value = [P(A),P(B),P(C),P(DRAW)]，softmax。device = cuda if available else cpu。
"""
from __future__ import annotations
import torch
import torch.nn as nn
import torch.nn.functional as F

CANVAS = 17
CHANNELS = 16


class ResBlock(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.conv1 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(c)
        self.conv2 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(c)

    def forward(self, x):
        r = x
        x = F.relu(self.bn1(self.conv1(x)))
        x = self.bn2(self.conv2(x))
        return F.relu(x + r)


class InvitusNet(nn.Module):
    def __init__(self, channels=32, blocks=4):
        super().__init__()
        self.trunk = nn.Sequential(nn.Conv2d(CHANNELS, channels, 3, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU())
        self.blocks = nn.Sequential(*[ResBlock(channels) for _ in range(blocks)])
        self.policy = nn.Conv2d(channels, 2, 1, bias=False)
        self.policy_bn = nn.BatchNorm2d(2)
        self.policy_fc = nn.Linear(2 * CANVAS * CANVAS, CANVAS * CANVAS)
        self.value_conv = nn.Conv2d(channels, 1, 1, bias=False)
        self.value_bn = nn.BatchNorm2d(1)
        self.value_fc = nn.Linear(CANVAS * CANVAS, 64)
        self.value_out = nn.Linear(64, 4)

    def forward(self, x):
        h = self.blocks(self.trunk(x))
        p = F.relu(self.policy_bn(self.policy(h)))
        logits = self.policy_fc(p.flatten(1))
        v = F.relu(self.value_bn(self.value_conv(h)))
        value = self.value_out(F.relu(self.value_fc(v.flatten(1))))
        return logits, F.log_softmax(value, dim=1)


def make_model(channels=32, blocks=4):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return InvitusNet(channels, blocks).to(device), device


def count_params(m):
    return sum(p.numel() for p in m.parameters())
