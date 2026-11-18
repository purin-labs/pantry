#!/usr/bin/env python3
"""Inventory historical identity boundaries from stable local SQLite copies."""

import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile

USER_ID = re.compile(
    r"user_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)
HISTORICAL_FIELDS = {"controlIdentityId", "control_identity_id"}


def quoted(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


@contextmanager
def copied_database(source: Path):
    paths = [source]
    wal = Path(str(source) + "-wal")
    if wal.exists():
        paths.append(wal)
    before = [(path.stat().st_size, path.stat().st_mtime_ns) for path in paths]
    with tempfile.TemporaryDirectory(prefix="satyr-plan53-inventory-") as directory:
        target = Path(directory) / "snapshot.sqlite"
        for path in paths:
            suffix = "" if path == source else "-wal"
            shutil.copyfile(path, Path(str(target) + suffix))
        after = [(path.stat().st_size, path.stat().st_mtime_ns) for path in paths]
        if before != after or wal.exists() != (wal in paths):
            raise ValueError("Source changed while copying")
        # SQLite can recover its copied WAL without creating files beside the source.
        db = sqlite3.connect(target)
        try:
            yield db
        finally:
            db.close()


def contains_historical_identity(raw: str) -> bool:
    try:
        pending = [json.loads(raw)]
    except (ValueError, TypeError):
        return False
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            for key, item in value.items():
                if key in HISTORICAL_FIELDS:
                    return True
                if (
                    key == "userId"
                    and isinstance(item, str)
                    and not USER_ID.fullmatch(item)
                ):
                    return True
                pending.append(item)
        elif isinstance(value, list):
            pending.extend(value)
    return False


def actor_inventory(db: sqlite3.Connection) -> dict:
    result = {"historicalIdentityRows": {}, "assignmentStates": {}, "outboxStates": {}}
    tables = {
        row[1]
        for row in db.execute("PRAGMA table_list")
        if row[0] == "main"
        and row[2] == "table"
        and not row[1].startswith(("sqlite_", "_cf_"))
    }
    for table in sorted(tables):
        columns = [
            row[1]
            for row in db.execute(f"PRAGMA table_info({quoted(table)})")
            if row[2].upper() == "TEXT"
        ]
        for column in columns:
            count = sum(
                contains_historical_identity(row[0])
                for row in db.execute(f"SELECT {quoted(column)} FROM {quoted(table)}")
                if row[0] is not None
            )
            if count:
                result["historicalIdentityRows"][f"{table}.{column}"] = count
    if "case_assignment" in tables:
        result["assignmentStates"] = dict(
            db.execute(
                """SELECT json_extract(lifecycle_json, '$.kind'), COUNT(*)
                FROM case_assignment GROUP BY 1"""
            )
        )
    if "session_case_parent" in tables:
        result["parentAssignments"] = db.execute(
            "SELECT COUNT(*) FROM session_case_parent"
        ).fetchone()[0]
    if "actor_outbox" in tables:
        result["outboxStates"] = dict(
            db.execute(
                "SELECT state_kind, COUNT(*) FROM actor_outbox GROUP BY state_kind"
            )
        )
    if "case_journal" in tables:
        result["journalRows"] = db.execute(
            "SELECT COUNT(*) FROM case_journal"
        ).fetchone()[0]
    return result


def durable_inventory(root: Path) -> dict:
    result = {}
    for directory in sorted(root.iterdir()):
        if not directory.is_dir():
            continue
        summary = {
            "files": 0,
            "copiedSnapshotsRead": 0,
            "changedSnapshotsSkipped": 0,
            "unreadableSnapshots": 0,
        }
        counters = {}
        for source in directory.glob("*.sqlite"):
            summary["files"] += 1
            try:
                with copied_database(source) as db:
                    inventory = actor_inventory(db)
            except (FileNotFoundError, ValueError):
                summary["changedSnapshotsSkipped"] += 1
                continue
            except (OSError, sqlite3.Error):
                summary["unreadableSnapshots"] += 1
                continue
            summary["copiedSnapshotsRead"] += 1
            for key, value in inventory.items():
                if isinstance(value, dict):
                    counters.setdefault(key, Counter()).update(value)
                else:
                    summary[key] = summary.get(key, 0) + value
        if summary["files"]:
            summary.update({key: dict(value) for key, value in counters.items()})
            result[directory.name] = summary
    return result


def relational_inventory(source: Path) -> dict:
    with copied_database(source) as db:
        tables = {
            row[0] for row in db.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            )
        }
        identity = "control_identity" if "control_identity" in tables else "app_user"
        work = dict(
            db.execute(
                """SELECT json_extract(state_json, '$.work.kind'), COUNT(*)
                FROM portal_conversation GROUP BY 1"""
            )
        )
        queued = db.execute(
            """SELECT COUNT(*) FROM portal_conversation
            WHERE json_array_length(state_json, '$.pendingInputs') > 0"""
        ).fetchone()[0]
        return {
            "identityTable": identity,
            "users": db.execute(f"SELECT COUNT(*) FROM {quoted(identity)}").fetchone()[0],
            "conversationWork": work,
            "conversationsWithQueuedInputs": queued,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--d1", required=True, type=Path)
    parser.add_argument("--actors", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    source_files = {
        Path(str(args.d1.resolve()) + suffix) for suffix in ("", "-wal", "-shm")
    }
    if output in source_files or (
        args.actors.resolve() in output.parents
    ):
        raise ValueError("Inventory output must be outside the source databases")
    result = {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "snapshotScope": "stable copies of individual databases; no distributed cutover fence",
        "sourceDatabasesModified": False,
        "relational": relational_inventory(args.d1),
        "durable": durable_inventory(args.actors),
        "productionCutoverReady": False,
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
