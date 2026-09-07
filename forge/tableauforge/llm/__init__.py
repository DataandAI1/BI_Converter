"""LLM layer: versioned prompt files in prompts/, a thin client over the Messages API (or
a local Ollama server), and the one prompt role BI_Converter keeps — the rebuild author.
"""

from __future__ import annotations

from pathlib import Path

from tableauforge.llm.client import LlmClient, LlmJsonError

PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"

__all__ = ["PROMPTS_DIR", "LlmClient", "LlmJsonError", "load_prompt", "load_system_prompt"]


def load_prompt(name: str) -> str:
    """Full markdown text of a versioned prompt file in prompts/."""
    path = PROMPTS_DIR / f"{name}.md"
    if not path.exists():
        raise FileNotFoundError(f"prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def load_system_prompt(name: str) -> str:
    """Body of the '## System' section of a prompt file (up to the next '## ' header)."""
    lines = load_prompt(name).splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "## System")
    except StopIteration:
        raise ValueError(f"prompt {name!r} has no '## System' section") from None
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("## "):
            break
        body.append(line)
    return "\n".join(body).strip()
