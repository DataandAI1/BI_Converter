"""The validation report shape every artifact carries.

Upstream this module orchestrated six layers over a compiled TWB — JSON Schema, the
pinned Tableau XSD, structural lint, a Document-API round-trip, and .twbx archive
integrity. BI_Converter emits `.lvdash.json`, so the Tableau layers and their lxml /
tableaudocumentapi dependencies go with the compiler (spec §3.2). What is left is the
report shape itself: ``validate/lakeview.py`` runs its own four layers and assembles them
into a ``ValidationReport``, and ``rebuild.py`` merges one report per emitted document.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class LayerResult:
    layer: int
    name: str
    passed: bool
    errors: list[str]


@dataclass
class ValidationReport:
    layers: list[LayerResult]
    xsd_version: str

    @property
    def passed(self) -> bool:
        """True when every executed layer passed."""
        return all(layer.passed for layer in self.layers)

    def to_dict(self) -> dict[str, Any]:
        """JSON-serializable report for persistence and the API."""
        return {
            "passed": self.passed,
            "xsd_version": self.xsd_version,
            "layers": [
                {
                    "layer": layer.layer,
                    "name": layer.name,
                    "passed": layer.passed,
                    "errors": list(layer.errors),
                }
                for layer in self.layers
            ],
        }
