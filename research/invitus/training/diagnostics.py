"""Training telemetry and collapse guardrails shared by replica and official runs."""
from __future__ import annotations

import math
from collections import Counter, deque
from typing import Any, Iterable


def distribution_entropy(values: Iterable[float]) -> float:
    values = [max(0.0, float(value)) for value in values]
    total = sum(values)
    if total <= 0:
        return 0.0
    return -sum((value / total) * math.log(value / total) for value in values if value > 0)


def target_metrics(samples: list[dict[str, Any]], tau: float) -> dict[str, float]:
    entropies: list[float] = []
    supports: list[float] = []
    for sample in samples:
        visits = [float(value) for value in sample.get("visits", {}).values()]
        softened = [value ** (1.0 / tau) for value in visits] if tau > 0 else visits
        entropy = distribution_entropy(softened)
        entropies.append(entropy)
        supports.append(math.exp(entropy))
    return {
        "targetEntropy": sum(entropies) / len(entropies) if entropies else 0.0,
        "effectiveTargetSupport": sum(supports) / len(supports) if supports else 0.0,
    }


def summarize_games(metadata: list[dict[str, Any]]) -> dict[str, Any]:
    diagnostics = [row.get("searchDiagnostics", {}) for row in metadata]
    diagnostics = [row for row in diagnostics if row.get("invitusMoveCount", 0) > 0]
    summary: dict[str, Any] = {
        "games": len(metadata),
        "gameLengthMean": sum(float(row.get("moves", 0)) for row in metadata) / max(1, len(metadata)),
        "outcomes": dict(Counter(str(row.get("result", "UNKNOWN")) for row in metadata)),
    }
    for key in (
        "networkPriorEntropy",
        "rootPriorEntropy",
        "visitEntropy",
        "maxPolicyProbability",
        "visitedActionCount",
        "legalActionCount",
    ):
        summary[key] = (
            sum(float(row.get(key, 0.0)) for row in diagnostics) / len(diagnostics)
            if diagnostics
            else 0.0
        )
    vectors = [row.get("valuePrediction") for row in diagnostics if row.get("valuePrediction")]
    summary["valuePrediction"] = (
        [sum(float(vector[index]) for vector in vectors) / len(vectors) for index in range(len(vectors[0]))]
        if vectors
        else []
    )
    for plies in (3, 6, 9):
        sequences = [
            "-".join(row.get("openingMoves", [])[:plies])
            for row in metadata
            if len(row.get("openingMoves", [])) >= plies
        ]
        counts = Counter(sequences)
        summary[f"opening{plies}"] = {
            "unique": len(counts),
            "entropy": distribution_entropy(counts.values()),
            "top1Frequency": max(counts.values(), default=0) / max(1, len(sequences)),
        }
    return summary


class CollapseSentinel:
    """Stop after 100 consecutive collapsed game-level search summaries."""

    def __init__(self, window: int = 100) -> None:
        self.window = window
        self.rows: deque[dict[str, Any]] = deque(maxlen=window)
        self.triggered = False
        self.snapshot: dict[str, float | int | bool] = {
            "window": window,
            "observations": 0,
            "triggered": False,
        }

    def observe(self, metadata: dict[str, Any]) -> bool:
        row = metadata.get("searchDiagnostics", {})
        if row.get("invitusMoveCount", 0) <= 0:
            return self.triggered
        self.rows.append(row)
        policy_entropy = sum(float(item.get("networkPriorEntropy", 0.0)) for item in self.rows) / len(self.rows)
        visit_entropy = sum(float(item.get("visitEntropy", 0.0)) for item in self.rows) / len(self.rows)
        top1 = sum(float(item.get("maxPolicyProbability", 0.0)) for item in self.rows) / len(self.rows)
        self.triggered = (
            len(self.rows) == self.window
            and policy_entropy < 0.25
            and visit_entropy < 0.10
            and top1 > 0.95
        )
        self.snapshot = {
            "window": self.window,
            "observations": len(self.rows),
            "policyEntropyMean": policy_entropy,
            "visitEntropyMean": visit_entropy,
            "top1PriorMean": top1,
            "triggered": self.triggered,
        }
        return self.triggered
