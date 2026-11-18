#!/usr/bin/env python3
"""Exercise identity, session, private-project and conversation mappings on a historical export."""

import base64
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HISTORICAL_REVISION = "06a0f1d00"
MODEL_ROUTE = {
    "keySource": "platform",
    "provider": "openai-compatible",
    "model": "acceptance-model",
}
spec = importlib.util.spec_from_file_location(
    "cutover", Path(__file__).with_name("identity-cutover.py")
)
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


def single_database_schema_file():
    """The one-database schema, built from the two deployed baselines."""
    out = Path(tempfile.mkdtemp(prefix="satyr-single-database-")) / "schema.sql"
    subprocess.run(
        ["node", str(ROOT / "services/platform/scripts/single-database-schema.mjs"), str(out)],
        check=True,
    )
    return out


def fixture(path: Path) -> None:
    schema = subprocess.check_output(
        [
            "git",
            "show",
            f"{HISTORICAL_REVISION}:services/platform/migrations/0001_current_schema.sql",
        ],
        cwd=ROOT,
        text=True,
    )
    db = sqlite3.connect(path)
    db.executescript(schema)
    db.execute("CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value BLOB)")
    db.execute("INSERT INTO _cf_METADATA VALUES ('local-runtime', 'fixture')")
    db.execute(
        """INSERT INTO organisation (organisation_id, name, organisation_handle, created_at)
        VALUES ('organisation_cutover', 'Synthetic organisation', 'synthetic-cutover', 1)"""
    )
    db.execute(
        """INSERT INTO organisation_workspace
        (workspace_id, organisation_id, workspace_handle, name, status, created_at)
        VALUES ('workspace_cutover', 'organisation_cutover', 'bakery', 'Bakery', 'active', 1)"""
    )
    for old, role in [("control_alice", "owner"), ("control_bob", "operator")]:
        db.execute(
            """INSERT INTO control_identity VALUES (?, 'https://accounts.google.com', ?, ?, ?, 1, 1, 2)""",
            (old, old, f"{old}@example.invalid", role),
        )
        db.execute(
            "INSERT INTO person (organisation_id, person_id, display_name) VALUES ('organisation_cutover', ?, ?)",
            (f"person_{role}", role),
        )
        db.execute(
            """INSERT INTO organisation_membership VALUES ('organisation_cutover', ?, ?, ?, 'active', 1, NULL)""",
            (old, f"person_{role}", role),
        )
    for name in ("alice", "bob"):
        db.execute(
            """INSERT INTO control_session VALUES
            (?, ?, ?, ?, 3, 1, 2, 9999999999999, NULL)""",
            (
                f"control_session_cutover_{name}",
                f"control_{name}",
                secret_hash(f"synthetic-session-{name}"),
                secret_hash(f"synthetic-csrf-{name}"),
            ),
        )
    db.execute(
        """INSERT INTO project VALUES
        ('organisation_cutover', 'control_alice', 'historical-project', 'Production',
         'Private brief', '[]', 4, 3, 1, 2)"""
    )
    state = {
        "id": "historical-conversation",
        "title": "Historical production plan",
        "lineage": {"kind": "original"},
        "modelRoute": MODEL_ROUTE,
        "documents": [],
        "completedRequests": ["historical_request"],
        "work": {"kind": "ready"},
        "historyBindings": [
            {
                "requestId": "historical_request",
                "responseId": "historical_response",
                "throughSequence": 2,
                "sessionId": "session_historical",
                "turnId": "turn_historical",
                "cursor": {"lastSequence": 2, "lastEntryDigest": "a" * 64},
                "modelRoute": MODEL_ROUTE,
            }
        ],
        "pendingInputs": [],
        "timeline": [
            {
                "kind": "user",
                "eventId": "historical_input",
                "sequence": 1,
                "requestId": "historical_request",
                "createdAt": 1,
                "text": "Preserve literal control_alice",
                "parts": [{"kind": "text", "text": "Preserve literal control_alice"}],
            },
            {
                "kind": "assistant",
                "eventId": "historical_response",
                "sequence": 2,
                "requestId": "historical_request",
                "createdAt": 2,
                "text": "Keep the accepted bakery plan.",
                "sources": [],
                "usage": None,
            },
        ],
        "latestSequence": 2,
        "lastReadSequence": 1,
        "surfaceEventCursor": 0,
        "draftText": "Keep this draft",
        "draftUpdatedAt": 4,
        "effort": None,
    }
    db.execute(
        """INSERT INTO portal_conversation
        (organisation_id, control_identity_id, conversation_id, revision, state_json, state_format,
         title_normalized, lifecycle, updated_at, last_activity_at, latest_sequence, last_read_sequence,
         draft_text, draft_updated_at, manual_position, project_id, membership_revision, pinned_at)
        VALUES ('organisation_cutover', 'control_alice', 'historical-conversation', 9, ?, 3,
                'production', 'active', 4, 4, 2, 1, 'Keep this draft', 4, 7, 'historical-project', 3, 3)""",
        (json.dumps(state),),
    )
    archived = dict(state)
    archived["id"] = "historical-archived"
    archived["title"] = "Archived capacity review"
    archived["work"] = {
        "kind": "failed",
        "requestId": "historical_request",
        "error": "capacity_unavailable",
    }
    db.execute(
        """INSERT INTO portal_conversation
        (organisation_id, control_identity_id, conversation_id, revision, state_json, state_format,
         title_normalized, lifecycle, archived_at, updated_at, last_activity_at, latest_sequence,
         last_read_sequence, draft_text, draft_updated_at, manual_position)
        VALUES ('organisation_cutover', 'control_alice', 'historical-archived', 5, ?, 3,
                'archived capacity review', 'archived', 5, 4, 4, 2, 1, 'Keep this draft', 4, 8)""",
        (json.dumps(archived),),
    )
    private = dict(state)
    private["id"] = "historical-bob-chat"
    private["title"] = "Bob private plan"
    db.execute(
        """INSERT INTO portal_conversation
        (organisation_id, control_identity_id, conversation_id, revision, state_json, state_format,
         title_normalized, updated_at, latest_sequence, last_read_sequence)
        VALUES ('organisation_cutover', 'control_bob', 'historical-bob-chat', 1, ?, 3,
                'bob private plan', 4, 2, 1)""",
        (json.dumps(private),),
    )
    db.execute(
        "INSERT INTO portal_chat_directory VALUES ('organisation_cutover', 'control_alice', 6)"
    )
    visibility = {"kind": "case", "caseId": "case_historical"}
    policies = [{
        "owner": {"kind": "organisation", "organisationId": "organisation_cutover"},
        "readers": [visibility],
        "restrictions": [],
    }]
    label = {
        "policies": policies,
        "digest": hashlib.sha256(json.dumps(
            policies, sort_keys=True, separators=(",", ":")
        ).encode()).hexdigest(),
    }
    text = "Accepted croissant handoff plan"
    content = json.dumps({"kind": "text", "text": text}, separators=(",", ":"))
    db.execute(
        """INSERT INTO context_projection
        (organisation_id, source_kind, source_key, source_json, source_revision,
         source_revision_json, lifecycle, content_digest, visibility_json,
         visibility_key, flow_label_json, indexed_at, bounded_text, created_at, updated_at)
        VALUES ('organisation_cutover', 'case_entry', ?, ?, 1, ?, 'ready', ?, ?, ?, ?, 1, ?, 1, 1)""",
        (
            "case_historical\0entry_historical",
            json.dumps({"kind": "case_entry", "caseId": "case_historical", "entryId": "entry_historical"}),
            json.dumps({"kind": "case_entry", "sequence": 1}),
            hashlib.sha256(content.encode()).hexdigest(),
            json.dumps(visibility),
            "case:case_historical",
            json.dumps(label),
            text,
        ),
    )
    db.commit()
    db.close()


def secret_hash(value: str) -> str:
    digest = hashlib.sha256(value.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def reject_unsafe_preparation(
    source: Path, directory: Path, name: str, state: dict, expected_error: str
) -> None:
    db = sqlite3.connect(source)
    db.execute(
        """UPDATE portal_conversation SET state_json = ?
        WHERE conversation_id = 'historical-conversation'""",
        (json.dumps(state),),
    )
    db.commit()
    db.close()
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    destination = directory / f"rejected-{name}.sqlite"
    mapping_path = directory / f"rejected-{name}.json"
    try:
        cutover.prepare(source, destination, mapping_path)
    except ValueError as error:
        assert expected_error in str(error)
    else:
        raise AssertionError(f"Unsafe {name} preparation was accepted")
    assert not destination.exists()
    assert not mapping_path.exists()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before


def verify_preproject_cutover(directory: Path) -> None:
    source = directory / "preproject.sqlite"
    destination = directory / "preproject-current.sqlite"
    mapping_path = directory / "preproject-mapping.json"
    fixture(source)
    db = sqlite3.connect(source)
    db.executescript("""
        DROP TABLE portal_chat_deletion;
        ALTER TABLE organisation ADD COLUMN actor_reconciliation_active INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE organisation ADD COLUMN actor_reconciliation_id TEXT;
        ALTER TABLE organisation ADD COLUMN actor_reconciliation_inflight INTEGER NOT NULL DEFAULT 0;
    """)
    retained = [
        name for name in cutover.columns(db, "portal_conversation")
        if name not in {"project_id", "membership_revision", "manual_position"}
    ]
    projection = ",".join(map(cutover.quoted, retained))
    db.execute(
        f"CREATE TEMP TABLE retained_conversations AS "
        f"SELECT {projection} FROM portal_conversation"
    )
    db.executescript("""
        DROP TABLE portal_conversation;
        DROP TABLE project;
        CREATE TABLE portal_conversation (
            organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
            control_identity_id TEXT NOT NULL REFERENCES control_identity (control_identity_id),
            conversation_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            state_json TEXT NOT NULL CHECK (json_valid(state_json)),
            updated_at INTEGER NOT NULL,
            lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
            pinned_at INTEGER,
            archived_at INTEGER,
            state_format INTEGER NOT NULL DEFAULT 1 CHECK (state_format >= 1),
            title_normalized TEXT NOT NULL DEFAULT '' CHECK (length(title_normalized) <= 160),
            last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0),
            latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
            last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0 AND last_read_sequence <= latest_sequence),
            draft_text TEXT NOT NULL DEFAULT '' CHECK (length(draft_text) <= 8000),
            draft_updated_at INTEGER,
            PRIMARY KEY (organisation_id, control_identity_id, conversation_id)
        );
    """)
    db.execute(
        f"INSERT INTO portal_conversation ({projection}) "
        f"SELECT {projection} FROM retained_conversations"
    )
    db.commit()
    original = json.loads(db.execute(
        """SELECT state_json FROM portal_conversation
        WHERE conversation_id = 'historical-conversation'"""
    ).fetchone()[0])
    db.close()
    source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
    cutover.prepare(source, destination, mapping_path)
    mapping = json.loads(mapping_path.read_text())
    assert mapping["project"] == {}
    after = sqlite3.connect(destination)
    assert after.execute("PRAGMA foreign_key_check").fetchall() == []
    assert after.execute("SELECT count(*) FROM project").fetchone() == (0,)
    conversation = mapping["conversation"]["historical-conversation"]
    assert after.execute("""SELECT c.user_id, c.project_id, c.membership_revision,
        u.manual_position, u.draft_text, u.pinned_at, u.last_read_sequence
        FROM portal_conversation c JOIN portal_conversation_user u
        USING (organisation_id, conversation_id, user_id) WHERE c.conversation_id = ?""",
        (conversation,)).fetchone() == (
            mapping["user"]["control_alice"], None, 0, 0, "Keep this draft", 3, 1
        )
    restored = json.loads(after.execute(
        "SELECT state_json FROM portal_conversation WHERE conversation_id = ?",
        (conversation,),
    ).fetchone()[0])
    assert restored["timeline"] == original["timeline"]
    assert restored["historyBindings"] == original["historyBindings"]
    assert restored["actorIdentity"] == (
        "organisation_cutover:portal-chat:control_alice:historical-conversation"
    )
    after.close()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_digest
    db = sqlite3.connect(source)
    db.execute("UPDATE organisation SET actor_reconciliation_active = 1")
    db.commit()
    db.close()
    active_source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
    rejected_destination = directory / "active-reconciliation.sqlite"
    rejected_mapping = directory / "active-reconciliation.json"
    try:
        cutover.prepare(source, rejected_destination, rejected_mapping)
    except ValueError as error:
        assert "Organisation reconciliation must finish before cutover" in str(error)
    else:
        raise AssertionError("Active reconciliation was discarded")
    assert not rejected_destination.exists()
    assert not rejected_mapping.exists()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == active_source_digest


def verify_production_schema(schema_path: Path) -> None:
    raw = schema_path.read_bytes()
    rows = json.loads(raw)[0]["results"]
    with tempfile.TemporaryDirectory(prefix="satyr-production-schema-") as temporary:
        directory = Path(temporary)
        source = directory / "source.sqlite"
        db = sqlite3.connect(source)
        for row in rows:
            shadows = {
                table[1] for table in db.execute("PRAGMA table_list")
                if table[2] == "shadow"
            }
            if row["name"].startswith("sqlite_") or row["name"] in shadows:
                continue
            db.execute(row["sql"])
        db.commit()
        db.close()
        result = cutover.prepare(
            source, directory / "current.sqlite", directory / "mapping.json"
        )
    result.update({
        "schemaOnly": True,
        "productionRowsCopied": 0,
        "productionModified": False,
        "schemaDigest": hashlib.sha256(raw).hexdigest(),
        "schemaObjects": len(rows),
    })
    evidence = ROOT / "docs/evidence/plan-55/production-schema-cutover.json"
    evidence.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


def verify_source_write_fence(
    source: Path, directory: Path, mapping_path: Path
) -> None:
    frozen_path = directory / "frozen-source.sqlite"
    with sqlite3.connect(source) as original, sqlite3.connect(frozen_path) as frozen:
        original.backup(frozen)
    freeze, rollback = cutover.source_write_fence_sql(frozen_path)
    with sqlite3.connect(frozen_path) as frozen:
        frozen.executescript(freeze)
        # Resuming maintenance cannot remove or weaken an installed guard.
        frozen.executescript(freeze)
        for sql in (
            """INSERT INTO organisation (organisation_id, name, organisation_handle, created_at)
               VALUES ('organisation_stale', 'Stale writer', 'stale-writer', 1)""",
            "UPDATE control_session SET revoked_at = 2",
            "DELETE FROM portal_conversation",
        ):
            try:
                frozen.execute(sql)
            except sqlite3.IntegrityError as error:
                assert str(error) == "p55_source_frozen"
            else:
                raise AssertionError("A stale source writer passed the cutover fence")
        assert frozen.execute("SELECT COUNT(*) FROM organisation").fetchone() == (1,)
        assert frozen.execute("SELECT revoked_at FROM control_session").fetchall() == [
            (None,), (None,)
        ]
        assert frozen.execute("SELECT COUNT(*) FROM portal_conversation").fetchone() == (3,)
    # The source fence stays at the persistence boundary. Target schema imports
    # retain the same identities without inheriting source-only write guards.
    converted = directory / "frozen-converted.sqlite"
    cutover.prepare(frozen_path, converted, mapping_path)
    with sqlite3.connect(converted) as target:
        assert not target.execute(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'p55_source_fence_%'"
        ).fetchall()
        target.execute("UPDATE organisation SET name = 'Current runtime'")
    with sqlite3.connect(frozen_path) as frozen:
        frozen.executescript(rollback)
        assert not frozen.execute(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'p55_source_fence_%'"
        ).fetchall()
        frozen.execute("UPDATE organisation SET name = 'Rollback runtime'")
        assert frozen.execute("SELECT name FROM organisation").fetchone() == ("Rollback runtime",)


def verify() -> None:
    with tempfile.TemporaryDirectory(prefix="satyr-plan53-cutover-") as directory:
        directory = Path(directory)
        verify_preproject_cutover(directory)
        source, destination, mapping_path = (
            directory / "source.sqlite",
            directory / "mapped.sqlite",
            directory / "mapping.json",
        )
        fixture(source)
        before_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        result = cutover.prepare(source, destination, mapping_path)
        result["servingSchemas"] = cutover.split_prepared_database(destination)
        mapping = json.loads(mapping_path.read_text())
        mapping_bytes = mapping_path.read_bytes()
        archive_path = mapping_path.with_name(mapping_path.stem + "-whatsapp-archive.json")
        archive_bytes = archive_path.read_bytes()
        repeated_destination = directory / "recaptured.sqlite"
        repeated = cutover.prepare(source, repeated_destination, mapping_path)
        assert repeated["savedIdentityMappingReused"] is True
        assert mapping_path.read_bytes() == mapping_bytes
        assert archive_path.read_bytes() == archive_bytes
        with sqlite3.connect(destination) as prepared, sqlite3.connect(
            repeated_destination
        ) as recaptured:
            for table in cutover.tables(prepared):
                assert prepared.execute(
                    f"SELECT * FROM {cutover.quoted(table)} ORDER BY rowid"
                ).fetchall() == recaptured.execute(
                    f"SELECT * FROM {cutover.quoted(table)} ORDER BY rowid"
                ).fetchall()
        changed_mapping = json.loads(mapping_bytes)
        changed_mapping["user"]["control_bob"] = changed_mapping["user"]["control_alice"]
        changed_path = directory / "changed-mapping.json"
        changed_path.write_text(json.dumps(changed_mapping))
        changed_bytes = changed_path.read_bytes()
        rejected_destination = directory / "invalid-recapture.sqlite"
        try:
            cutover.prepare(source, rejected_destination, changed_path)
        except ValueError as error:
            assert str(error) == "Saved user mapping has invalid canonical identities"
        else:
            raise AssertionError("Duplicate saved identities must block recapture")
        assert not rejected_destination.exists()
        assert changed_path.read_bytes() == changed_bytes
        result["recapturePreservesSavedIdentities"] = True
        result["duplicateSavedIdentityRejected"] = True
        verify_source_write_fence(source, directory, mapping_path)
        result["staleSourceWritesRejected"] = True
        result["frozenSourceConvertsWithSavedIdentities"] = True
        result["sourceWriteFenceRollbackVerified"] = True
        before, after = sqlite3.connect(source), sqlite3.connect(destination)
        alice, bob = mapping["user"]["control_alice"], mapping["user"]["control_bob"]
        project, conversation = (
            mapping["project"]["historical-project"],
            mapping["conversation"]["historical-conversation"],
        )
        assert alice != bob
        assert after.execute(
            "SELECT user_id FROM control_session ORDER BY control_session_id"
        ).fetchall() == [(alice,), (bob,)]
        assert (
            after.execute(
                """SELECT token_hash, csrf_hash, rotation_generation, expires_at
                FROM control_session ORDER BY control_session_id"""
            ).fetchall()
            == before.execute(
                """SELECT token_hash, csrf_hash, rotation_generation, expires_at
                FROM control_session ORDER BY control_session_id"""
            ).fetchall()
        )
        assert after.execute(
            "SELECT user_id, role FROM organisation_membership ORDER BY role"
        ).fetchall() == [(bob, "operator"), (alice, "owner")]
        assert after.execute(
            "SELECT user_id, project_id FROM project"
        ).fetchone() == (alice, project)
        assert after.execute(
            """SELECT c.user_id, c.conversation_id, c.project_id, c.revision,
            u.manual_position, c.membership_revision, u.draft_text
            FROM portal_conversation c JOIN portal_conversation_user u
            USING (organisation_id, conversation_id, user_id) WHERE c.conversation_id = ?""",
            (conversation,),
        ).fetchone() == (alice, conversation, project, 9, 7, 3, "Keep this draft")
        old_state = json.loads(
            before.execute(
                """SELECT state_json FROM portal_conversation
                WHERE conversation_id = 'historical-conversation'"""
            ).fetchone()[0]
        )
        new_state = json.loads(
            after.execute(
                "SELECT state_json FROM portal_conversation WHERE conversation_id = ?",
                (conversation,),
            ).fetchone()[0]
        )
        assert new_state["id"] == conversation
        assert new_state["actorIdentity"] == (
            "organisation_cutover:portal-chat:control_alice:historical-conversation"
        )
        old_case_digest = hashlib.sha256(
            b"organisation_cutover:portal-chat:control_alice:historical-conversation"
        ).hexdigest()[:32]
        restored_case_digest = hashlib.sha256(
            new_state["actorIdentity"].encode()
        ).hexdigest()[:32]
        assert restored_case_digest == old_case_digest
        assert new_state["timeline"] == old_state["timeline"]
        assert new_state["historyBindings"] == old_state["historyBindings"]
        assert "draftText" not in new_state
        assert after.execute(
            """SELECT draft_text, pinned_at, last_read_sequence
            FROM portal_conversation_user WHERE conversation_id = ?""",
            (conversation,),
        ).fetchone() == (old_state["draftText"], 3, 1)
        assert after.execute(
            """SELECT lifecycle, archived_at FROM portal_conversation_user
            WHERE conversation_id = ?""",
            (mapping["conversation"]["historical-archived"],),
        ).fetchone() == ("archived", 5)
        baseline = sqlite3.connect(":memory:")
        baseline.executescript(
            single_database_schema_file().read_text()
        )
        assert after.execute(
            "SELECT name, type, sql FROM sqlite_schema ORDER BY name"
        ).fetchall() == baseline.execute(
            "SELECT name, type, sql FROM sqlite_schema ORDER BY name"
        ).fetchall()
        baseline.close()
        assert after.execute(
            """SELECT bounded_text FROM context_projection_fts
            WHERE context_projection_fts MATCH 'croissant'"""
        ).fetchall() == [("Accepted croissant handoff plan",)]
        assert after.execute(
            "SELECT * FROM context_projection"
        ).fetchall() == before.execute(
            "SELECT * FROM context_projection"
        ).fetchall()
        assert hashlib.sha256(source.read_bytes()).hexdigest() == before_hash
        before.close()
        after.close()
        unknown_binding = json.loads(json.dumps(old_state))
        unknown_binding["historyBindings"] = [
            {
                "digest": "immutable-history-digest",
                "actorControlIdentityId": "control_alice",
            }
        ]
        reject_unsafe_preparation(
            source,
            directory,
            "unknown-binding",
            unknown_binding,
            "Unrecognized durable history binding boundary",
        )
        running = json.loads(json.dumps(old_state))
        running["work"] = {"kind": "running"}
        reject_unsafe_preparation(
            source, directory, "running", running, "Conversation has pending work"
        )
        queued = json.loads(json.dumps(old_state))
        queued["pendingInputs"] = [{"inputId": "historical_queued_input"}]
        reject_unsafe_preparation(
            source, directory, "queued", queued, "Conversation has pending work"
        )
        snapshot = json.loads(json.dumps(old_state))
        snapshot["timeline"][0]["parts"].append(
            {
                "kind": "project_context",
                "snapshot": {
                    "layer": {"kind": "project", "projectId": "historical-project"},
                    "digest": "b" * 64,
                },
            }
        )
        reject_unsafe_preparation(
            source,
            directory,
            "project-snapshot",
            snapshot,
            "Historical project snapshot requires its digest-verifying restore adapter",
        )
        result.update(
            {
                "historicalSchemaRevision": HISTORICAL_REVISION,
                "preprojectConversationMigrationPreserved": True,
                "idleReconciliationRemovedAtMigrationBoundary": True,
                "activeReconciliationRejectedWithoutSourceChanges": True,
                "sourceBytesUnchanged": True,
                "sessionHashesAndRotationPreserved": True,
                "membershipRolesPreserved": True,
                "privateOwnershipAndPlacementPreserved": True,
                "historyAndDraftPreserved": True,
                "durableActorAddressPreserved": True,
                "unknownDurableBindingsRejected": True,
                "personalChatStateSeparated": True,
                "completedDurableBindingsPreserved": True,
                "failedArchivedChatsPreserved": True,
                "currentBaselineSchemaMatched": True,
                "derivedSearchIndexRestored": True,
                "pendingWorkRejectedWithoutSourceChanges": True,
                "historicalProjectSnapshotsRejectedWithoutRewritingDigests": True,
                "productionCutoverReady": False,
            }
        )
        evidence = ROOT / "docs/evidence/plan-53-user-preferences"
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / "identity-cutover-results.json").write_text(
            json.dumps(result, indent=2) + "\n"
        )
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--production-schema", type=Path)
    arguments = parser.parse_args()
    verify()
    if arguments.production_schema:
        verify_production_schema(arguments.production_schema)
