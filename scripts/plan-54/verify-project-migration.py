#!/usr/bin/env python3
"""Verify the project-ownership migration against populated historical SQLite data."""
import json
from pathlib import Path
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/evidence/plan-54-chat-shared-projects"
HISTORICAL_REVISION = "06a0f1d00"
OWNER = "user_00000000-0000-4000-8000-000000000001"
OTHER = "user_00000000-0000-4000-8000-000000000002"
PROJECT = "project_00000000-0000-4000-8000-000000000001"
CONVERSATION = "conv_00000000-0000-4000-8000-000000000001"


def fixture(duplicate: bool) -> sqlite3.Connection:
    schema = subprocess.check_output([
        "git", "show", f"{HISTORICAL_REVISION}:services/platform/migrations/0001_current_schema.sql"
    ], cwd=ROOT, text=True)
    # P53 owns the identity migration. This fixture starts at its named schema boundary.
    schema = schema.replace("control_identity", "app_user").replace("app_user_id", "user_id")
    connection = sqlite3.connect(":memory:")
    connection.executescript(schema)
    connection.execute("INSERT INTO organisation (organisation_id, name, created_at) VALUES ('organisation_fixture', 'Synthetic team', 1)")
    for user in [OWNER, OTHER]:
        connection.execute("""INSERT INTO app_user
            (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at)
            VALUES (?, 'fixture', ?, ?, 'Synthetic user', 1, 1, 1)""", (user, user, f"{user}@example.invalid"))
    connection.execute("""INSERT INTO project
        (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
        VALUES ('organisation_fixture', ?, ?, 'Production', 'Private brief', '[]', 4, 3, 1, 2)""", (OWNER, PROJECT))
    if duplicate:
        connection.execute("""INSERT INTO project
            (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
            VALUES ('organisation_fixture', ?, ?, 'Other owner', '', '[]', 1, 1, 1, 1)""", (OTHER, PROJECT))
    connection.execute("""INSERT INTO portal_conversation
        (organisation_id, user_id, conversation_id, project_id, manual_position, membership_revision, revision,
        state_json, state_format, title_normalized, lifecycle, pinned_at, archived_at, updated_at,
        last_activity_at, latest_sequence, last_read_sequence, draft_text, draft_updated_at)
        VALUES ('organisation_fixture', ?, ?, ?, 7, 3, 9, ?, 3, 'production', 'archived', 2, 3, 4, 4, 8, 6, 'Keep my draft', 4)""",
        (OWNER, CONVERSATION, PROJECT, json.dumps({"actorIdentity": "organisation_fixture:portal-chat:legacy_creator:legacy_conversation", "title": "Production", "timeline": [{"text": "Private history"}]})))
    connection.execute("""CREATE TABLE portal_chat_fork (
        organisation_id TEXT, user_id TEXT, operation_id TEXT, source_conversation_id TEXT,
        destination_conversation_id TEXT, history_json TEXT, conversation_json TEXT,
        status TEXT, PRIMARY KEY (organisation_id, user_id, operation_id))""")
    connection.execute("""INSERT INTO portal_chat_fork VALUES
        ('organisation_fixture', ?, 'retained-fork', ?, 'conv_00000000-0000-4000-8000-000000000002', ?, ?, 'ready')""",
        (OWNER, CONVERSATION, '{"entries":[{"text":"Retained accepted history"}]}', '{"lineage":{"kind":"fork"}}'))
    connection.commit()
    return connection


def verify() -> None:
    migration = (ROOT / "scripts/plan-54/migrate-personal-projects.sql").read_text()
    connection = fixture(False)
    before = connection.execute("SELECT * FROM portal_conversation").fetchall()
    retained_forks = connection.execute("SELECT * FROM portal_chat_fork").fetchall()
    connection.executescript("BEGIN;\n" + migration + "\nCOMMIT;")
    preserved = connection.execute("SELECT user_id, project_id, membership_revision, revision, updated_at, last_activity_at, latest_sequence, access_kind, active_user_id FROM portal_conversation").fetchone()
    assert preserved == (OWNER, PROJECT, 3, 9, 4, 4, 8, "private", None)
    personal = connection.execute("SELECT user_id, conversation_id, lifecycle, pinned_at, archived_at, manual_position, last_read_sequence, draft_text, draft_updated_at FROM portal_conversation_user").fetchone()
    assert personal == (OWNER, CONVERSATION, "archived", 2, 3, 7, 6, "Keep my draft", 4)
    history = json.loads(connection.execute("SELECT state_json FROM portal_conversation").fetchone()[0])
    assert history["timeline"] == [{"text": "Private history"}]
    assert history["actorIdentity"] == "organisation_fixture:portal-chat:legacy_creator:legacy_conversation"
    assert "draftText" not in history and "lastReadSequence" not in history
    assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert connection.execute("SELECT * FROM portal_chat_fork").fetchall() == retained_forks
    assert connection.execute("SELECT access_kind, user_id, access_revision FROM project").fetchall() == [("personal", OWNER, 0)]
    assert connection.execute("SELECT COUNT(*) FROM project_member").fetchone() == (0,)
    collision = fixture(True)
    try:
        collision.executescript("BEGIN;\n" + migration + "\nCOMMIT;")
    except sqlite3.IntegrityError:
        collision.rollback()
    else:
        raise AssertionError("A duplicate project identity was silently accepted")
    assert collision.execute("SELECT COUNT(*) FROM project").fetchone() == (2,)
    assert collision.execute("SELECT * FROM portal_conversation").fetchall() == before
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result = {
        "scenario": "personal-project-ownership-migration",
        "historicalSchemaRevision": HISTORICAL_REVISION,
        "preservedConversationHistory": True,
        "preservedActorAddress": True,
        "preservedPersonalPinArchiveOrderDraftAndCursor": True,
        "canonicalConversationIdentity": True,
        "preservedPrivateOwnership": True,
        "preservedCanonicalForkRecordsAndBytes": True,
        "noImplicitSharing": True,
        "foreignKeysValid": True,
        "duplicateIdentityRollsBack": True,
        "scope": "Project and conversation ownership/personal state migration. P53 identity and Actor migration are separate gates.",
    }
    (EVIDENCE / "project-migration-results.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    verify()
