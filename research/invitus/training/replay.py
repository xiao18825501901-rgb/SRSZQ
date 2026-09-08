"""Disk-backed replay（分片 JSONL，写后 fsync；只保留最近 N 片）。"""
from __future__ import annotations
import json
import os


class ReplayBuffer:
    def __init__(self, base_dir="replay", max_shards=64, max_samples_per_shard=512):
        self.base_dir = base_dir
        self.max_shards = max_shards
        self.max_samples = max_samples_per_shard
        self._cur = []
        self._shard_idx = 0
        os.makedirs(base_dir, exist_ok=True)
        # 恢复 shard 序号
        for f in sorted(os.listdir(base_dir)):
            if f.startswith("shard_") and f.endswith(".jsonl"):
                idx = int(f.split("_")[1].split(".")[0])
                self._shard_idx = max(self._shard_idx, idx + 1)

    def add(self, sample: dict):
        self._cur.append(sample)
        if len(self._cur) >= self.max_samples:
            self.flush()

    def flush(self):
        if not self._cur:
            return
        path = os.path.join(self.base_dir, f"shard_{self._shard_idx:06d}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for s in self._cur:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self._shard_idx += 1
        self._cur = []
        self._rotate()

    def _rotate(self):
        shards = sorted(f for f in os.listdir(self.base_dir) if f.startswith("shard_"))
        while len(shards) > self.max_shards:
            oldest = shards.pop(0)
            try:
                os.remove(os.path.join(self.base_dir, oldest))
            except OSError:
                pass

    def shards(self):
        return sorted(os.path.join(self.base_dir, f) for f in os.listdir(self.base_dir) if f.startswith("shard_") and f.endswith(".jsonl"))

    def iter_samples(self, shards):
        for p in shards:
            with open(p, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        yield json.loads(line)
