"""Value-vector representations and multiplayer selection utility.

Tree storage and engine outcomes always use absolute order
``[A, B, C, DRAW]``.  Actor-relative order is confined to the network/loss
boundary and is converted back before MCTS backup.
"""
from __future__ import annotations

from collections.abc import Sequence

PLAYERS = "ABC"
VALUE_REPRESENTATIONS = ("absolute", "actor_relative")
VALUE_LOSSES = ("ce", "brier")


def _actor_index(actor: str) -> int:
    if actor not in PLAYERS:
        raise ValueError(f"actor must be A, B, or C; got {actor!r}")
    return PLAYERS.index(actor)


def _value_tuple(value: Sequence[float]) -> tuple[float, float, float, float]:
    if len(value) != 4:
        raise ValueError(f"value vector must contain four entries; got {len(value)}")
    return tuple(float(component) for component in value)  # type: ignore[return-value]


def absolute_to_relative(
    value: Sequence[float], actor: str
) -> tuple[float, float, float, float]:
    """Map ``[A,B,C,DRAW]`` to ``[actor,next,previous,DRAW]``."""
    absolute = _value_tuple(value)
    index = _actor_index(actor)
    return (
        absolute[index],
        absolute[(index + 1) % 3],
        absolute[(index + 2) % 3],
        absolute[3],
    )


def relative_to_absolute(
    value: Sequence[float], actor: str
) -> tuple[float, float, float, float]:
    """Map ``[actor,next,previous,DRAW]`` back to ``[A,B,C,DRAW]``."""
    relative = _value_tuple(value)
    index = _actor_index(actor)
    absolute = [0.0, 0.0, 0.0, relative[3]]
    absolute[index] = relative[0]
    absolute[(index + 1) % 3] = relative[1]
    absolute[(index + 2) % 3] = relative[2]
    return tuple(absolute)  # type: ignore[return-value]


def output_to_absolute(
    value: Sequence[float], actor: str, representation: str
) -> tuple[float, float, float, float]:
    if representation == "absolute":
        return _value_tuple(value)
    if representation == "actor_relative":
        return relative_to_absolute(value, actor)
    raise ValueError(f"unknown value representation: {representation!r}")


def target_from_absolute(
    value: Sequence[float], actor: str, representation: str
) -> tuple[float, float, float, float]:
    if representation == "absolute":
        return _value_tuple(value)
    if representation == "actor_relative":
        return absolute_to_relative(value, actor)
    raise ValueError(f"unknown value representation: {representation!r}")


def actor_utility(value: Sequence[float], actor: str) -> float:
    """Expected actor utility when a draw is shared equally by three seats."""
    absolute = _value_tuple(value)
    return absolute[_actor_index(actor)] + absolute[3] / 3.0

