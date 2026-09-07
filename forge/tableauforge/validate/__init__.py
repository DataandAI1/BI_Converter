"""Layered validation pipeline (GOAL §5). Imports are lazy; see pipeline.py for orchestration."""

from typing import Any

__all__ = ["ValidationReport", "validate_artifact"]


def __getattr__(name: str) -> Any:
    if name in ("ValidationReport", "validate_artifact"):
        from tableauforge.validate import pipeline

        return getattr(pipeline, name)
    raise AttributeError(name)
