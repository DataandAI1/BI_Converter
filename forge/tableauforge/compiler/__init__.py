"""Deterministic file engine: DashboardSpec -> TWB XML -> .twb/.twbx.

Imports are lazy so data-layer modules stay usable while heavier pieces load.
"""

from typing import Any

__all__ = ["write_hyper_from_csv", "read_hyper_row_count", "compile_twb", "package_twbx"]


def __getattr__(name: str) -> Any:
    if name in ("write_hyper_from_csv", "read_hyper_row_count"):
        from tableauforge.compiler import hyper

        return getattr(hyper, name)
    if name == "compile_twb":
        from tableauforge.compiler.twb import compile_twb

        return compile_twb
    if name == "package_twbx":
        from tableauforge.compiler.twbx import package_twbx

        return package_twbx
    raise AttributeError(name)
