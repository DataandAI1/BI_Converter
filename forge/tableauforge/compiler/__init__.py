"""Deterministic compile: a validated DashboardSpec -> `.lvdash.json`.

Upstream this package also produced .twb/.twbx and .pbit, and re-exported those compilers
lazily. BI_Converter emits one format, so there is nothing to dispatch: import
``tableauforge.compiler.lakeview`` directly.
"""
