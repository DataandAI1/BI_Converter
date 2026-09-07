"""Validation pipeline orchestration (GOAL §5): every artifact, every time.

Runtime layers:
  1. json-schema     — DashboardSpec dict validates against its JSON Schema.
  2. xsd             — TWB XML validates against the pinned official XSD.
  3. structural-lint — custom reference checks the XSD cannot express.
  4. roundtrip       — Tableau Document API reads the .twb back as declared.
  6. twbx-integrity  — archive structure + Hyper extracts (when a .twbx given).

Layer 5 (golden files) lives in the test suite, not this runtime pipeline:
golden snapshots are a CI regression gate for compiler changes, not a
per-artifact runtime check.

Layers run in order and every failure is reported — a layer failing does not
stop later layers — EXCEPT layers 3-6 are skipped when layer 1 failed (no
usable spec to check against) or the TWB bytes are not well-formed XML
(nothing structural to check). Skipped layers are absent from the report;
``ValidationReport.passed`` covers executed layers only.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from lxml import etree
from pydantic import ValidationError

from tableauforge.spec.models import DashboardSpec
from tableauforge.spec.schema import validate_spec
from tableauforge.validate.lint import lint_twb
from tableauforge.validate.roundtrip import roundtrip_check
from tableauforge.validate.twbx_integrity import check_twbx
from tableauforge.validate.xsd import XSD_VERSION, validate_twb_xml


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


def _roundtrip_errors(
    twb_bytes: bytes, twb_path: Path | None, spec: DashboardSpec
) -> list[str]:
    """Layer 4 needs the .twb on disk; write a temp file when no path given."""
    if twb_path is not None:
        return roundtrip_check(Path(twb_path), spec)
    fd, tmp_name = tempfile.mkstemp(suffix=".twb", prefix="tf_roundtrip_")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(twb_bytes)
        return roundtrip_check(Path(tmp_name), spec)
    finally:
        os.unlink(tmp_name)


def validate_artifact(
    spec_dict: dict,
    twb_bytes: bytes,
    twb_path: Path | None = None,
    twbx_path: Path | None = None,
    expected_row_counts: dict[str, int] | None = None,
) -> ValidationReport:
    """Run the layered validation pipeline over a compiled artifact."""
    layers: list[LayerResult] = []

    # Layer 1: JSON Schema, then build the typed spec the later layers consume.
    schema_errors = validate_spec(spec_dict)
    spec: DashboardSpec | None = None
    if not schema_errors:
        try:
            spec = DashboardSpec.model_validate(spec_dict)
        except ValidationError as exc:
            schema_errors = [f"spec failed model validation: {exc}"]
    layers.append(LayerResult(1, "json-schema", not schema_errors, schema_errors))

    # Layer 2: official XSD.
    xsd_errors = validate_twb_xml(twb_bytes)
    layers.append(LayerResult(2, "xsd", not xsd_errors, xsd_errors))

    try:
        etree.fromstring(twb_bytes)
        xml_well_formed = True
    except etree.XMLSyntaxError:
        xml_well_formed = False

    # Catastrophic failures leave nothing for layers 3-6 to check against.
    if spec is None or not xml_well_formed:
        return ValidationReport(layers=layers, xsd_version=XSD_VERSION)

    # Layer 3: structural lint.
    lint_errors = lint_twb(twb_bytes, spec)
    layers.append(LayerResult(3, "structural-lint", not lint_errors, lint_errors))

    # Layer 4: Document API round-trip.
    rt_errors = _roundtrip_errors(twb_bytes, twb_path, spec)
    layers.append(LayerResult(4, "roundtrip", not rt_errors, rt_errors))

    # Layer 6: TWBX integrity, only when an archive was produced.
    if twbx_path is not None:
        twbx_errors = check_twbx(Path(twbx_path), spec, expected_row_counts)
        layers.append(
            LayerResult(6, "twbx-integrity", not twbx_errors, twbx_errors)
        )

    return ValidationReport(layers=layers, xsd_version=XSD_VERSION)
