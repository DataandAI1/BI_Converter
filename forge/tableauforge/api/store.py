"""SQLite persistence for artifacts, specs, and validation reports (GOAL §3.3).

Simple by default: one database file at <artifacts_dir>/forge.db, stdlib
sqlite3, WAL journal mode so reads and writes do not block each other.
Thread-safe via a fresh connection per call plus a process-wide write lock.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

DB_FILENAME = "forge.db"

#: Artifact kinds the table ACCEPTS. BI_Converter only ever writes 'lvdash' — a split
#: build is a `.lvdash.zip` and an unsplit one a `.lvdash.json`, and the stored filename
#: is what tells those apart. The three upstream kinds stay in the constraint because an
#: artifacts directory inherited from TableauForge may still hold rows of them, and a
#: narrower CHECK would make the migration below fail on exactly the databases it exists
#: to rescue. Accepting a historical value costs nothing; refusing it loses someone's rows.
_ARTIFACT_KINDS = ("twb", "twbx", "pbit", "lvdash")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS artifacts (
    id          TEXT PRIMARY KEY,
    workbook_name TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('twb', 'twbx', 'pbit', 'lvdash')),
    path        TEXT NOT NULL,
    spec_json   TEXT NOT NULL,
    report_json TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    llm_usage_json TEXT
)
"""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ArtifactStore:
    """CRUD over the artifacts table.

    ``now`` is injectable so tests can pin created_at; production uses UTC
    wall clock (persistence metadata only — artifact bytes stay deterministic).
    """

    def __init__(
        self,
        artifacts_dir: str | Path,
        now: Callable[[], datetime] = _utc_now,
    ):
        self.artifacts_dir = Path(artifacts_dir)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.artifacts_dir / DB_FILENAME
        self._now = now
        self._write_lock = threading.Lock()
        conn = self._connect()
        try:
            with conn:
                conn.execute(_SCHEMA)
                # Migrate databases created before the token-usage feature.
                cols = {row[1] for row in conn.execute("PRAGMA table_info(artifacts)")}
                if "llm_usage_json" not in cols:
                    conn.execute("ALTER TABLE artifacts ADD COLUMN llm_usage_json TEXT")
                # Recover a stranded artifacts_legacy: DDL autocommits under
                # sqlite3's legacy transaction handling, so a crash mid-rebuild
                # can leave the renamed table holding the only copy of the rows.
                # _SCHEMA above guarantees artifacts exists to receive them.
                stranded = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' "
                    "AND name='artifacts_legacy'"
                ).fetchone()
                if stranded is not None:
                    legacy_cols = [
                        row[1]
                        for row in conn.execute("PRAGMA table_info(artifacts_legacy)")
                    ]
                    # Column intersection: the stranded copy may predate later
                    # ALTERs (e.g. llm_usage_json).
                    shared = ", ".join(c for c in legacy_cols if c in cols)
                    conn.execute(
                        f"INSERT OR IGNORE INTO artifacts ({shared}) "
                        f"SELECT {shared} FROM artifacts_legacy"
                    )
                    conn.execute("DROP TABLE artifacts_legacy")
                # Migrate a database created before a kind was added: SQLite cannot
                # alter a CHECK constraint, so rebuild the table once per missing kind.
                # The check is over the CURRENT kind list, so adding one needs only
                # _ARTIFACT_KINDS + _SCHEMA updating, not another branch.
                row = conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'"
                ).fetchone()
                existing_ddl = (row[0] or "") if row is not None else ""
                if row is not None and any(
                    f"'{kind}'" not in existing_ddl for kind in _ARTIFACT_KINDS
                ):
                    # The rebuild must be one atomic unit: without an explicit
                    # transaction each DDL statement commits on its own, and a
                    # crash between RENAME and INSERT strands the rows (the
                    # recovery above exists for databases already bitten).
                    if conn.in_transaction:
                        conn.commit()
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute("ALTER TABLE artifacts RENAME TO artifacts_legacy")
                    conn.execute(_SCHEMA)
                    conn.execute(
                        "INSERT INTO artifacts "
                        "(id, workbook_name, kind, path, spec_json, report_json, "
                        "created_at, llm_usage_json) "
                        "SELECT id, workbook_name, kind, path, spec_json, "
                        "report_json, created_at, llm_usage_json FROM artifacts_legacy"
                    )
                    conn.execute("DROP TABLE artifacts_legacy")
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def save_artifact(
        self,
        artifact_id: str,
        workbook_name: str,
        kind: str,
        path: str,
        spec: dict[str, Any],
        report: dict[str, Any],
        llm_usage: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Insert (or replace, for idempotent re-generation) one artifact row.

        llm_usage is the token-usage summary for the LLM calls that produced
        this dashboard file (None when it was compiled without any LLM call
        and no prior usage was reported).
        """
        if kind not in _ARTIFACT_KINDS:
            raise ValueError(
                f"kind must be one of {', '.join(map(repr, _ARTIFACT_KINDS))}, got {kind!r}"
            )
        created_at = self._now().isoformat().replace("+00:00", "Z")
        with self._write_lock:
            conn = self._connect()
            try:
                with conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO artifacts "
                        "(id, workbook_name, kind, path, spec_json, report_json, "
                        "created_at, llm_usage_json) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            artifact_id,
                            workbook_name,
                            kind,
                            path,
                            json.dumps(spec, sort_keys=True),
                            json.dumps(report, sort_keys=True),
                            created_at,
                            json.dumps(llm_usage, sort_keys=True)
                            if llm_usage is not None
                            else None,
                        ),
                    )
            finally:
                conn.close()
        row = self.get_artifact(artifact_id)
        assert row is not None  # just written under the lock
        return row

    def get_artifact(self, artifact_id: str) -> Optional[dict[str, Any]]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM artifacts WHERE id = ?", (artifact_id,)
            ).fetchone()
        finally:
            conn.close()
        return _row_to_dict(row) if row is not None else None

    def list_artifacts(self) -> list[dict[str, Any]]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM artifacts ORDER BY created_at, id"
            ).fetchall()
        finally:
            conn.close()
        return [_row_to_dict(r) for r in rows]


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    llm_usage_json = row["llm_usage_json"] if "llm_usage_json" in row.keys() else None
    return {
        "id": row["id"],
        "workbook_name": row["workbook_name"],
        "kind": row["kind"],
        "path": row["path"],
        "spec": json.loads(row["spec_json"]),
        "report": json.loads(row["report_json"]),
        "created_at": row["created_at"],
        "llm_usage": json.loads(llm_usage_json) if llm_usage_json else None,
    }
