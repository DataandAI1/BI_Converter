"""LLM token-usage accounting: how many input/output tokens each dashboard cost.

LlmClient records one call entry per Messages-API round trip (purpose, model,
input_tokens, output_tokens). These helpers turn call lists into the summary
shape persisted with every artifact and returned by the API:

    {"input_tokens": int, "output_tokens": int, "calls": [entry, ...]}

The studio flow spans several HTTP requests (draft -> refine xN -> build), so
endpoints that finish a dashboard accept the client-accumulated summary of the
earlier requests and merge it with their own via merge_usage().
"""

from __future__ import annotations

from typing import Any, Optional

#: Kept on every persisted call entry; anything else a client sends is dropped.
_CALL_KEYS = ("purpose", "model", "input_tokens", "output_tokens")

#: Hard cap on merged call lists — a runaway client cannot bloat the store.
_MAX_CALLS = 200


def _to_count(value: Any) -> int:
    """Coerce a token count defensively: ints only, never negative."""
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _clean_call(call: Any) -> Optional[dict[str, Any]]:
    if not isinstance(call, dict):
        return None
    return {
        "purpose": str(call.get("purpose") or "llm_call"),
        "model": str(call.get("model") or "unknown"),
        "input_tokens": _to_count(call.get("input_tokens")),
        "output_tokens": _to_count(call.get("output_tokens")),
    }


def summarize_usage(calls: list[dict[str, Any]]) -> dict[str, Any]:
    """Roll a call list up into the persisted summary shape."""
    cleaned = [c for c in (_clean_call(call) for call in calls) if c is not None]
    return {
        "input_tokens": sum(c["input_tokens"] for c in cleaned),
        "output_tokens": sum(c["output_tokens"] for c in cleaned),
        "calls": cleaned,
    }


def merge_usage(*summaries: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Combine usage summaries from multiple requests into one.

    Totals are re-derived from the merged call lists, EXCEPT when a summary
    carries totals but no calls (e.g. a trimmed client payload) — those totals
    are preserved via a synthetic "untracked" entry so tokens are never lost.
    Returns None when nothing usable was passed (usage stays unknown, not 0).
    """
    calls: list[dict[str, Any]] = []
    seen = False
    for summary in summaries:
        if not isinstance(summary, dict):
            continue
        seen = True
        entry_calls = [
            c for c in (
                _clean_call(call) for call in (summary.get("calls") or [])
            ) if c is not None
        ]
        if entry_calls:
            calls.extend(entry_calls)
            continue
        total_in = _to_count(summary.get("input_tokens"))
        total_out = _to_count(summary.get("output_tokens"))
        if total_in or total_out:
            calls.append(
                {
                    "purpose": "untracked",
                    "model": "unknown",
                    "input_tokens": total_in,
                    "output_tokens": total_out,
                }
            )
    if not seen:
        return None
    return summarize_usage(calls[:_MAX_CALLS])
