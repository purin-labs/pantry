/// <reference types="@cloudflare/workers-types" />

import { describe, expect, test } from "vitest";

import { createSessionSchema, initializeAgentSessionPersistence } from "../src/actors/agent-session-schema";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "../src/actors/actor-schema-versions";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("AgentSession persistence mode", function agentSessionPersistenceSuite() {
  test("initializes canonical persistence", function initializesCanonical() {
    const fixture = emptySqliteFixture();
    const mode = initializeAgentSessionPersistence(sqlStorage(fixture.storage));

    expect(mode).toEqual({ kind: "v33_canonical" });
    expect(readSchemaVersion(fixture.database)).toBe(CANONICAL_SESSION_SCHEMA_VERSION);
    expect(tableExists(fixture.database, "actor_journal")).toBe(true);
    expect(tableExists(fixture.database, "session_surface_effect")).toBe(false);
  });

  test("validates existing canonical persistence", function validatesCanonical() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);

    expect(initializeAgentSessionPersistence(sql)).toEqual({
      kind: "v33_canonical",
    });
  });

  test("fails closed for an unknown future schema", function rejectsFutureSchema() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    fixture.database
      .prepare(
        "UPDATE do_schema_meta SET value = ? WHERE key = 'session_hot_schema'",
      )
      .run(CANONICAL_SESSION_SCHEMA_VERSION + 1);

    expect(function initializeFuturePersistence() {
      initializeAgentSessionPersistence(sql);
    }).toThrow(
      `schema_version_ahead:session_hot_schema:${CANONICAL_SESSION_SCHEMA_VERSION + 1}`,
    );
  });
});

function readSchemaVersion(
  database: import("node:sqlite").DatabaseSync,
): number {
  const value = database
    .prepare(
      "SELECT value FROM do_schema_meta WHERE key = 'session_hot_schema'",
    )
    .get()?.value;
  if (typeof value !== "number")
    throw new Error("missing session schema version");
  return value;
}
function tableExists(
  database: import("node:sqlite").DatabaseSync,
  table: string,
): boolean {
  return (
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table)?.count === 1
  );
}
