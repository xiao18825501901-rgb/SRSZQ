"""Shared model inference for parallel Invitus self-play workers."""

from .service import InferenceService, InferenceServiceError

__all__ = ["InferenceService", "InferenceServiceError"]
