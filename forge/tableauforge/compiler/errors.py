"""Compiler error types.

These lived in ``compiler/twb.py`` upstream, which BI_Converter drops along with the rest
of the Tableau-authoring flow (spec §4.4 coupling 1). Only ``compiler/lakeview.py`` still
needs them, so they get their own module rather than keeping a whole compiler alive for two
exception classes.
"""

from __future__ import annotations


class CompileError(ValueError):
    pass


class UnsupportedFeatureError(CompileError):
    """Raised for spec features the compiler does not support yet.

    An unsupported request must fail cleanly, never emit a corrupt file.
    """
