#!/usr/bin/env python3
"""Prepare the current schema from a quiescent historical D1 export without editing it."""

import tempfile
import subprocess
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid

ROOT = Path(__file__).resolve().parents[2]
PREFIXES = {"user": "user_", "conversation": "conv_", "project": "project_"}
UUID_SUFFIX = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
STORAGE_INTERNAL_TABLES = {"_cf_KV", "_cf_METADATA", "d1_migrations"}
ID_COLUMNS = {
    "conversation_id": "conversation",
    "source_conversation_id": "conversation",
    "destination_conversation_id": "conversation",
    "project_id": "project",
}


def single_database_schema_file():
    """The one-database schema, built from the two deployed baselines."""
    out = Path(tempfile.mkdtemp(prefix="satyr-single-database-")) / "schema.sql"
    subprocess.run(
        ["node", str(ROOT / "services/platform/scripts/single-database-schema.mjs"), str(out)],
        check=True,
    )
    return out


def quoted(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def renamed(identifier: str) -> str:
    return identifier.replace("control_identity", "app_user").replace(
        "app_user_id", "user_id"
    )


def tables(connection: sqlite3.Connection) -> list[str]:
    return sorted(
        row[1]
        for row in connection.execute("PRAGMA table_list")
        if row[0] == "main"
        and row[2] == "table"
        and not row[1].startswith("sqlite_")
        and row[1] not in STORAGE_INTERNAL_TABLES
    )


def columns(connection: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in connection.execute(f"PRAGMA table_info({quoted(table)})")]


def mapping_for(
    source: sqlite3.Connection, mapping_path: Path
) -> dict[str, dict[str, str]]:
    has_saved_mapping = mapping_path.exists()
    retained = json.loads(mapping_path.read_text()) if has_saved_mapping else None
    if has_saved_mapping and (
        not isinstance(retained, dict) or set(retained) != set(PREFIXES)
    ):
        raise ValueError("Saved identity mapping has invalid areas")
    result = {area: {} for area in PREFIXES}
    for table, column, area in [
        ("control_identity", "control_identity_id", "user"),
        ("portal_conversation", "conversation_id", "conversation"),
        ("project", "project_id", "project"),
    ]:
        originals = (
            set()
            if table == "project" and table not in tables(source)
            else {
                row[0]
                for row in source.execute(
                    f"SELECT DISTINCT {quoted(column)} FROM {quoted(table)}"
                )
            }
        )
        if retained is not None:
            values = retained[area]
            if not isinstance(values, dict) or set(values) != originals:
                raise ValueError(f"Saved {area} mapping differs from source inventory")
            if any(
                not isinstance(value, str)
                or re.fullmatch(PREFIXES[area] + UUID_SUFFIX, value) is None
                for value in values.values()
            ) or len(set(values.values())) != len(values):
                raise ValueError(f"Saved {area} mapping has invalid canonical identities")
        for old in originals:
            canonical = re.fullmatch(PREFIXES[area] + UUID_SUFFIX, old) is not None
            if retained is not None:
                value = retained[area][old]
                if canonical and value != old:
                    raise ValueError(f"Saved {area} mapping changes a canonical identity")
                result[area][old] = value
            else:
                result[area][old] = old if canonical else PREFIXES[area] + str(uuid.uuid4())
    return result


def translated_id(
    value: object, area: str, mapping: dict[str, dict[str, str]]
) -> object:
    if value is None:
        return None
    if not isinstance(value, str) or value not in mapping[area]:
        raise ValueError(
            f"Unmapped {area} reference; inventory the source before cutover"
        )
    return mapping[area][value]


def conversation_state(
    raw: str,
    mapping: dict[str, dict[str, str]],
    original: dict[str, object],
) -> str:
    state = json.loads(raw)
    if not isinstance(state, dict) or state.get("id") != original["conversation_id"]:
        raise ValueError("Conversation projection identity does not match its owner row")
    actor_identity = state.get("actorIdentity")
    if actor_identity is None:
        actor_identity = (
            f"{original['organisation_id']}:portal-chat:"
            f"{original['control_identity_id']}:{original['conversation_id']}"
        )
    if not isinstance(actor_identity, str) or not actor_identity.startswith(
        f"{original['organisation_id']}:portal-chat:"
    ):
        raise ValueError("Invalid conversation Actor identity")
    state["actorIdentity"] = actor_identity
    state["id"] = translated_id(state["id"], "conversation", mapping)
    lineage = state.get("lineage")
    if isinstance(lineage, dict) and lineage.get("kind") == "fork":
        lineage["sourceConversationId"] = translated_id(
            lineage["sourceConversationId"], "conversation", mapping
        )
    if state.get("pendingInputs") or state.get("work", {}).get("kind") not in (
        "ready",
        "failed",
    ):
        raise ValueError("Conversation has pending work: drain Actors before cutover")
    for binding in state.get("historyBindings", []):
        if not isinstance(binding, dict) or set(binding) != {
            "requestId",
            "responseId",
            "throughSequence",
            "sessionId",
            "turnId",
            "cursor",
            "modelRoute",
        }:
            raise ValueError("Unrecognized durable history binding boundary")
    for event in state.get("timeline", []):
        for part in event.get("parts", []):
            if part.get("kind") != "project_context":
                continue
            layer = part["snapshot"]["layer"]
            if layer.get("kind") == "project" and translated_id(
                layer["projectId"], "project", mapping
            ) != layer["projectId"]:
                raise ValueError(
                    "Historical project snapshot requires its digest-verifying restore adapter"
                )
    return json.dumps(state, separators=(",", ":"), ensure_ascii=False)


def copy_rows(
    source: sqlite3.Connection,
    target: sqlite3.Connection,
    mapping: dict[str, dict[str, str]],
) -> None:
    available = set(tables(target))
    for old_table in tables(source):
        old_columns = columns(source, old_table)
        user_columns = {
            row[3]
            for row in source.execute(f"PRAGMA foreign_key_list({quoted(old_table)})")
            if row[2] in ("control_identity", "app_user")
        }
        if old_table == "control_identity":
            user_columns.add("control_identity_id")
        rows = source.execute(f"SELECT * FROM {quoted(old_table)}").fetchall()
        if not rows:
            continue
        table = renamed(old_table)
        new_columns = [renamed(column) for column in old_columns]
        if table not in available or not set(new_columns).issubset(
            columns(target, table)
        ):
            raise ValueError(f"Unrecognized populated schema boundary: {old_table}")
        insert = (
            f"INSERT INTO {quoted(table)} ({','.join(map(quoted, new_columns))}) "
            f"VALUES ({','.join('?' for _ in new_columns)})"
        )
        for row in rows:
            record = dict(zip(old_columns, row))
            values = []
            for old_column, column, value in zip(old_columns, new_columns, row):
                if old_column in user_columns or old_column.endswith(
                    "control_identity_id"
                ):
                    value = translated_id(value, "user", mapping)
                elif column in ID_COLUMNS:
                    value = translated_id(value, ID_COLUMNS[column], mapping)
                elif table == "portal_conversation" and column == "state_json":
                    value = conversation_state(value, mapping, record)
                values.append(value)
            target.execute(insert, values)


def cutover_schema(source: sqlite3.Connection) -> str:
    shadow = {
        row[1] for row in source.execute("PRAGMA table_list") if row[2] == "shadow"
    }
    statements = []
    for name, sql in source.execute(
        """SELECT name, sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND type <> 'trigger' ORDER BY rowid"""
    ):
        if (
            name not in shadow
            and name not in STORAGE_INTERNAL_TABLES
            and not name.startswith("sqlite_")
        ):
            statements.append(renamed(sql) + ";")
    return "\n".join(statements)


def copy_current_rows(source: sqlite3.Connection, target: sqlite3.Connection) -> None:
    available = set(tables(target))
    for table in tables(source):
        rows = source.execute(f"SELECT * FROM {quoted(table)}").fetchall()
        if not rows:
            continue
        source_columns = columns(source, table)
        if table not in available or not set(source_columns).issubset(
            columns(target, table)
        ):
            raise ValueError(f"Unrecognized populated current-schema boundary: {table}")
        if table == "provider_manifest":
            target.executemany(
                """DELETE FROM provider_manifest
                WHERE provider = ? AND manifest_version = ? AND environment = ?""",
                source.execute(
                    "SELECT provider, manifest_version, environment FROM provider_manifest"
                ).fetchall(),
            )
        insert = (
            f"INSERT INTO {quoted(table)} ({','.join(map(quoted, source_columns))}) "
            f"VALUES ({','.join('?' for _ in source_columns)})"
        )
        target.executemany(insert, rows)


def remove_retired_reconciliation(staged: sqlite3.Connection) -> None:
    retired = {
        "actor_reconciliation_active",
        "actor_reconciliation_id",
        "actor_reconciliation_inflight",
    }
    present = retired.intersection(columns(staged, "organisation"))
    if not present:
        return
    if present != retired:
        raise ValueError("Incomplete historical reconciliation schema")
    unfinished = staged.execute("""
        SELECT 1 FROM organisation WHERE actor_reconciliation_active <> 0
        OR actor_reconciliation_inflight <> 0 OR actor_reconciliation_id IS NOT NULL
        LIMIT 1
    """).fetchone()
    if unfinished:
        raise ValueError("Organisation reconciliation must finish before cutover")
    for column in sorted(retired):
        staged.execute(f"ALTER TABLE organisation DROP COLUMN {quoted(column)}")


def prepare_preproject_schema(staged: sqlite3.Connection) -> None:
    if "project" in tables(staged):
        return
    project_columns = {"project_id", "membership_revision", "manual_position"}
    if project_columns.intersection(columns(staged, "portal_conversation")):
        raise ValueError("Incomplete historical project schema; inventory before cutover")
    staged.executescript("""
        CREATE TABLE project (
            organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
            user_id TEXT NOT NULL REFERENCES app_user (user_id),
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            brief TEXT NOT NULL,
            references_json TEXT NOT NULL,
            revision INTEGER NOT NULL,
            content_revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (organisation_id, user_id, project_id)
        );
        ALTER TABLE portal_conversation ADD COLUMN project_id TEXT;
        ALTER TABLE portal_conversation ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE portal_conversation ADD COLUMN manual_position INTEGER NOT NULL DEFAULT 0;
    """)


def normalize_agent_skills(staged: sqlite3.Connection) -> dict[str, int]:
    """Convert stored references and remove proven redundant definition bindings."""
    revisions = staged.execute("""
        SELECT definition.agent_definition_id, definition.organisation_id,
          definition.display_name, definition.role, definition.purpose,
          revision.revision, revision.instructions,
          revision.requested_capabilities_json, revision.skill_refs_json,
          revision.content_digest
        FROM agent_definition_revision AS revision
        JOIN agent_definition AS definition
          USING (agent_definition_id, organisation_id)
    """).fetchall()
    converted = 0
    changed_digests = 0
    for identity, organisation, name, role, purpose, revision, instructions, caps, raw, digest in revisions:
        refs = json.loads(raw)
        if not isinstance(refs, list):
            raise ValueError("Agent skill references are not an array")
        if not any(isinstance(ref, str) for ref in refs):
            continue
        if not all(isinstance(ref, str) and ref for ref in refs):
            raise ValueError("Agent skill references mix historical and current shapes")
        if len(set(refs)) != len(refs):
            raise ValueError("Agent skill references contain duplicates")
        normalized = []
        for skill in refs:
            pins = staged.execute("""
                SELECT DISTINCT binding.skill_revision
                FROM skill_binding AS binding
                JOIN skill_revision AS revision
                  ON revision.skill_id = binding.skill_id
                  AND revision.organisation_id = binding.organisation_id
                  AND revision.revision = binding.skill_revision
                WHERE binding.organisation_id = ? AND binding.skill_id = ?
                  AND binding.target_kind = 'agent_definition'
                  AND binding.target_id = ?
            """, (organisation, skill, identity)).fetchall()
            if len(pins) != 1:
                raise ValueError("Historical agent skill reference has no unique revision")
            normalized.append({"skillId": skill, "revision": pins[0][0]})
        # This is an unsigned configuration checksum. Preserve the historical
        # bytes in the source backup and hash the converted representation.
        content = {
            "displayName": name,
            "role": role,
            "purpose": purpose,
            "instructions": instructions,
            "requestedCapabilities": json.loads(caps),
            "skillRefs": normalized,
        }
        encoded = json.dumps(content, separators=(",", ":"), ensure_ascii=False)
        current_digest = hashlib.sha256(encoded.encode()).hexdigest()
        staged.execute("""
            UPDATE agent_definition_revision
            SET skill_refs_json = ?, content_digest = ?
            WHERE agent_definition_id = ? AND organisation_id = ? AND revision = ?
        """, (
            json.dumps(normalized, separators=(",", ":")), current_digest,
            identity, organisation, revision,
        ))
        converted += 1
        changed_digests += int(current_digest != digest)

    bindings = staged.execute("""
        SELECT binding_id, organisation_id, target_id, skill_id, skill_revision
        FROM skill_binding WHERE target_kind = 'agent_definition'
    """).fetchall()
    for binding, organisation, definition, skill, revision in bindings:
        uncovered = staged.execute("""
            SELECT 1 FROM agent_installation AS installation
            WHERE installation.organisation_id = ?
              AND installation.agent_definition_id = ?
              AND installation.lifecycle = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM agent_area_assignment AS assignment
                JOIN skill_binding AS area_binding
                  ON area_binding.organisation_id = installation.organisation_id
                  AND area_binding.target_kind = 'area'
                  AND area_binding.target_id = assignment.area_id
                  AND area_binding.skill_id = ?
                  AND area_binding.skill_revision = ?
                WHERE assignment.installation_id = installation.installation_id
              ) LIMIT 1
        """, (organisation, definition, skill, revision)).fetchone()
        if uncovered is not None:
            raise ValueError("Definition skill binding is not covered by its area bindings")
        staged.execute("DELETE FROM skill_binding WHERE binding_id = ?", (binding,))
    return {
        "normalizedAgentSkillRevisions": converted,
        "recomputedAgentConfigurationChecksums": changed_digests,
        "removedRedundantDefinitionSkillBindings": len(bindings),
    }


def archive_obsolete_whatsapp_policies(
    source: sqlite3.Connection, staged: sqlite3.Connection
) -> list[dict[str, object]]:
    # The operator authorized archiving these nine revisions on 2026-10-06.
    # The current policy and all accounts, messages and Actor state stay intact.
    obsolete = staged.execute("""
        SELECT revision.integration_account_id, revision.policy_version,
          policy.current_version
        FROM whatsapp_ingress_policy_revision AS revision
        LEFT JOIN whatsapp_ingress_policy AS policy
          USING (integration_account_id, organisation_id, environment)
        WHERE revision.processing = 'enabled'
          AND (revision.relevant_message_topics IS NULL
            OR revision.automatic_acknowledgement_text IS NULL)
        ORDER BY revision.integration_account_id, revision.policy_version
    """).fetchall()
    if not obsolete:
        return []
    if len(obsolete) != 9:
        raise ValueError("WhatsApp policy exclusions exceed the approved nine-row scope")
    names = columns(source, "whatsapp_ingress_policy_revision")
    archived = []
    for account, revision, current in obsolete:
        if current is None or revision >= current:
            raise ValueError("A current WhatsApp policy requires operator configuration")
        original = source.execute("""
            SELECT * FROM whatsapp_ingress_policy_revision
            WHERE integration_account_id = ? AND policy_version = ?
        """, (account, revision)).fetchone()
        if original is None:
            raise ValueError("Original WhatsApp policy archive is missing")
        archived.append(dict(zip(names, original, strict=True)))
        staged.execute("""
            DELETE FROM whatsapp_ingress_policy_revision
            WHERE integration_account_id = ? AND policy_version = ?
        """, (account, revision))
    return archived


def prepare(
    source_path: Path, destination: Path, mapping_path: Path
) -> dict[str, object]:
    archive_path = mapping_path.with_name(mapping_path.stem + "-whatsapp-archive.json")
    retained_mapping = mapping_path.exists()
    if destination.exists():
        raise ValueError("Destination must be a new file")
    if archive_path.exists() and not retained_mapping:
        raise ValueError("WhatsApp archive has no saved identity mapping")
    os.umask(0o077)
    source = sqlite3.connect(f"file:{source_path.resolve()}?mode=ro", uri=True)
    staged = sqlite3.connect(":memory:")
    target = sqlite3.connect(destination)
    try:
        source.execute("BEGIN")
        mapping = mapping_for(source, mapping_path)
        staged.executescript(cutover_schema(source))
        staged.execute("PRAGMA foreign_keys = ON")
        staged.execute("BEGIN")
        staged.execute("PRAGMA defer_foreign_keys = ON")
        copy_rows(source, staged, mapping)
        if staged.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Mapped references violate foreign keys")
        staged.commit()
        remove_retired_reconciliation(staged)
        prepare_preproject_schema(staged)
        agent_skills = normalize_agent_skills(staged)
        archived_whatsapp = archive_obsolete_whatsapp_policies(source, staged)
        baseline = single_database_schema_file().read_text()
        target.executescript(baseline)
        if "portal_chat_deletion" not in tables(staged):
            deletion_schema = target.execute(
                "SELECT sql FROM sqlite_schema WHERE name = 'portal_chat_deletion'"
            ).fetchone()[0]
            staged.execute(deletion_schema)
        project_migration = (
            ROOT / "scripts/plan-54/migrate-personal-projects.sql"
        ).read_text()
        staged.executescript("BEGIN;\n" + project_migration + "\nCOMMIT;")
        target.execute("PRAGMA foreign_keys = ON")
        target.execute("BEGIN")
        target.execute("PRAGMA defer_foreign_keys = ON")
        triggers = target.execute(
            "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'"
        ).fetchall()
        # Bulk import preserves source records without replaying provisioning triggers.
        for name, _ in triggers:
            target.execute(f"DROP TRIGGER {quoted(name)}")
        copy_current_rows(staged, target)
        for _, sql in triggers:
            target.execute(sql)
        target.execute(
            """INSERT INTO context_projection_fts
            (rowid, organisation_id, source_kind, source_key, visibility_key,
             title, display_path, bounded_text)
            SELECT rowid, organisation_id, source_kind, source_key, visibility_key,
              COALESCE(title, ''), COALESCE(display_path, ''), bounded_text
            FROM context_projection WHERE lifecycle = 'ready'"""
        )
        if target.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Current references violate foreign keys")
        target.commit()
        if archive_path.exists():
            if json.loads(archive_path.read_text()) != archived_whatsapp:
                raise ValueError("Saved WhatsApp archive differs from source revisions")
        else:
            archive_path.write_text(json.dumps(archived_whatsapp, indent=2) + "\n")
        if not retained_mapping:
            mapping_path.write_text(json.dumps(mapping, indent=2) + "\n")
        return {
            "mappedEntities": {area: len(values) for area, values in mapping.items()},
            "foreignKeysValid": True,
            "currentSchema": True,
            "productionCutoverReady": False,
            "agentSkills": agent_skills,
            "archivedObsoleteWhatsAppPolicyRevisions": len(archived_whatsapp),
            "savedIdentityMappingReused": retained_mapping,
        }
    except Exception:
        target.rollback()
        target.close()
        destination.unlink(missing_ok=True)
        if not retained_mapping:
            mapping_path.unlink(missing_ok=True)
            archive_path.unlink(missing_ok=True)
        raise
    finally:
        source.close()
        staged.close()
        target.close()


def split_prepared_database(source_path: Path) -> dict[str, object]:
    """Prepare the two serving stores from the canonical migration intermediate."""
    paths = {
        role: source_path.with_name(source_path.stem + f"-{role}.sqlite")
        for role in ("global", "regional")
    }
    if any(path.exists() for path in paths.values()):
        raise ValueError("Serving database destinations must be new files")
    os.umask(0o077)
    source = sqlite3.connect(f"file:{source_path.resolve()}?mode=ro", uri=True)
    targets = {}
    try:
        source.execute("BEGIN")
        organisation_ids = {
            row[0] for row in source.execute("SELECT organisation_id FROM organisation")
        }
        scopes = {
            row[0]
            for row in source.execute(
                "SELECT DISTINCT organisation_scope FROM control_mutation_receipt"
            )
        }
        if scopes - organisation_ids - {"organisation:create"}:
            raise ValueError("Unknown control receipt ownership")
        for role, path in paths.items():
            target = sqlite3.connect(path)
            targets[role] = target
            baseline = (
                ROOT / f"services/platform/migrations-{role}/0001_current_schema.sql"
            )
            target.executescript(baseline.read_text())
        covered = set(tables(targets["global"])) | set(tables(targets["regional"]))
        if covered != set(tables(source)):
            raise ValueError("Serving schemas do not cover the prepared database")
        evidence = {}
        for role, target in targets.items():
            target.execute("BEGIN")
            target.execute("PRAGMA defer_foreign_keys = ON")
            triggers = target.execute(
                "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'"
            ).fetchall()
            for name, _ in triggers:
                target.execute(f"DROP TRIGGER {quoted(name)}")
            row_count = 0
            for table in tables(target):
                if columns(source, table) != columns(target, table):
                    raise ValueError(f"Serving columns differ: {table}")
                predicate = "1"
                if table == "control_mutation_receipt":
                    predicate = (
                        "organisation_scope = 'organisation:create'"
                        if role == "global"
                        else "organisation_scope <> 'organisation:create'"
                    )
                target.execute(f"DELETE FROM {quoted(table)}")
                rows = source.execute(
                    f"SELECT * FROM {quoted(table)} WHERE {predicate}"
                ).fetchall()
                placeholders = ",".join("?" for _ in columns(source, table))
                target.executemany(
                    f"INSERT INTO {quoted(table)} VALUES ({placeholders})", rows
                )
                retained = target.execute(f"SELECT * FROM {quoted(table)}").fetchall()
                if set(retained) != set(rows) or len(retained) != len(rows):
                    raise ValueError(f"Serving rows differ: {table}")
                row_count += len(rows)
            for _, sql in triggers:
                target.execute(sql)
            if role == "regional":
                target.execute(
                    """INSERT INTO context_projection_fts
                    (rowid, organisation_id, source_kind, source_key, visibility_key,
                     title, display_path, bounded_text)
                    SELECT rowid, organisation_id, source_kind, source_key, visibility_key,
                      COALESCE(title, ''), COALESCE(display_path, ''), bounded_text
                    FROM context_projection WHERE lifecycle = 'ready'"""
                )
            if target.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError(f"Serving foreign keys fail: {role}")
            target.commit()
            if target.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError(f"Serving integrity fails: {role}")
            evidence[role] = {
                "tables": len(tables(target)),
                "rows": row_count,
                "completeRowEquality": True,
                "foreignKeysValid": True,
                "integrityValid": True,
            }
        return evidence
    except Exception:
        for target in targets.values():
            target.close()
        for path in paths.values():
            path.unlink(missing_ok=True)
        raise
    finally:
        source.close()
        for target in targets.values():
            target.close()


def source_write_fence_sql(source_path: Path) -> tuple[str, str]:
    """Fence the retired source at the cutover boundary without changing its rows."""
    source = sqlite3.connect(f"file:{source_path.resolve()}?mode=ro", uri=True)
    freeze = []
    rollback = []
    try:
        for table in tables(source):
            for operation in ("INSERT", "UPDATE", "DELETE"):
                name = f"p55_source_fence_{table}_{operation.lower()}"
                freeze.append(
                    f"CREATE TRIGGER IF NOT EXISTS {quoted(name)} "
                    f"BEFORE {operation} ON {quoted(table)} "
                    "BEGIN SELECT RAISE(ABORT, 'p55_source_frozen'); END;"
                )
                rollback.append(f"DROP TRIGGER IF EXISTS {quoted(name)};")
        return "\n".join(freeze) + "\n", "\n".join(rollback) + "\n"
    finally:
        source.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--mapping", required=True, type=Path)
    args = parser.parse_args()
    result = prepare(args.source, args.destination, args.mapping)
    result["servingSchemas"] = split_prepared_database(args.destination)
    freeze, rollback = source_write_fence_sql(args.source)
    for action, sql in (("freeze", freeze), ("rollback", rollback)):
        path = args.destination.with_name(args.destination.stem + f"-source-{action}.sql")
        with path.open("x") as output:
            output.write(sql)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
