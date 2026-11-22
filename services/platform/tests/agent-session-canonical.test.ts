/// <reference types="@cloudflare/workers-types" />

import { describe, expect, test } from "vitest";

import {
  parseImportedCanonicalLifecycle,
  readImportedCanonicalSession,
} from "@purin-labs/agent/actors/agent-session-canonical";
import { createSessionSchema } from "@purin-labs/agent/actors/agent-session-schema";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("canonical AgentSession persistence", function canonicalSessionSuite() {
  test("reads one strictly validated sleeping projection", function readsSleepingProjection() {
    const fixture = canonicalFixture();
    const lifecycle = sleepingLifecycle();
    insertCanonicalSession(fixture.database, lifecycle);

    expect(readImportedCanonicalSession(fixture.sql, "organisation_1")).toEqual(
      {
        ok: true,
        value: {
          organisationId: "organisation_1",
          sessionId: "session_1",
          threadKey: "thread_1",
          track: "managed-agents",
          startedAt: 10,
          lifecycle,
        },
      },
    );
  });

  test("rejects projection columns that disagree with lifecycle state", function rejectsMismatch() {
    const fixture = canonicalFixture();
    insertCanonicalSession(fixture.database, sleepingLifecycle());
    fixture.database
      .prepare("UPDATE session_meta SET policy_version = 'policy_other'")
      .run();

    expect(readImportedCanonicalSession(fixture.sql, "organisation_1")).toEqual(
      {
        ok: false,
        error: { code: "canonical_session_corrupt" },
      },
    );
  });

  test("fences organisation reads", function fencesOrganisationRead() {
    const fixture = canonicalFixture();
    insertCanonicalSession(fixture.database, sleepingLifecycle());

    expect(
      readImportedCanonicalSession(fixture.sql, "organisation_other"),
    ).toEqual({
      ok: false,
      error: { code: "canonical_session_organisation_mismatch" },
    });
  });

  test("reads the canonical Processing and Admitted branch", function readsProcessingState() {
    const lifecycle = processingLifecycle();
    expect(parseImportedCanonicalLifecycle(JSON.stringify(lifecycle))).toEqual({
      ok: true,
      value: lifecycle,
    });
  });

  test("requires an explicit quarantine recovery policy", function requiresQuarantineRecovery() {
    const state = sleepingLifecycle().state;

    expect(
      parseImportedCanonicalLifecycle(
        JSON.stringify({
          kind: "quarantined",
          state: {
            identity: state.identity,
            contract: state.contract,
            reason: "migration_blocked",
          },
        }),
      ),
    ).toEqual({ ok: false, error: { code: "canonical_session_corrupt" } });
    expect(
      parseImportedCanonicalLifecycle(
        JSON.stringify({
          kind: "quarantined",
          state: {
            identity: state.identity,
            contract: state.contract,
            reason: "migration_blocked",
            recovery: { kind: "terminate_only" },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "quarantined",
        state: {
          identity: state.identity,
          contract: state.contract,
          reason: "migration_blocked",
          recovery: { kind: "terminate_only" },
        },
      },
    });
  });
});

function canonicalFixture(): {
  database: import("node:sqlite").DatabaseSync;
  sql: SqlStorage;
} {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createSessionSchema(sql);
  return { database: fixture.database, sql };
}

function insertCanonicalSession(
  database: import("node:sqlite").DatabaseSync,
  lifecycle: ReturnType<typeof sleepingLifecycle>,
): void {
  database
    .prepare(
      `INSERT INTO session_meta (
       session_id, organisation_id, thread_key, track, lifecycle_kind,
       lifecycle_projection, last_event_sequence, policy_version,
       started_at, terminal_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      "session_1",
      "organisation_1",
      "thread_1",
      "managed-agents",
      lifecycle.kind,
      JSON.stringify(lifecycle),
      0,
      "policy_1",
      10,
    );
}

function sleepingLifecycle() {
  return {
    kind: "sleeping" as const,
    state: {
      identity: {
        organisationId: "organisation_1",
        sessionId: "session_1",
        streamId: "stream_1",
      },
      contract: {
        policyVersion: "policy_1",
        budgetRevision: "budget_1",
        runtimeRevision: "runtime_1",
        modelRoute: {
          keySource: "platform" as const,
          provider: "openai-compatible" as const,
          model: "gpt-5.6-sol",
        },
        lastEventSequence: 0,
      },
      resumePoint: {
        kind: "checkpoint" as const,
        checkpoint: {
          checkpointId: "checkpoint_1",
          stateDigest:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          lastEventSequence: 0,
          runtimeRevision: "runtime_1",
          runtimeGeneration: 1,
          policyVersion: "policy_1",
          budgetRevision: "budget_1",
          budgetUsage: { tokens: 25, activeWallMs: 10, capabilityCalls: 0 },
          usageCursor: 2,
          budgetAccountDigest: "c".repeat(64),
          workspaceRevisionReceipt: {
            receiptId: "receipt_1",
            outcome: "accepted" as const,
            workspaceId: "workspace_catalog_1",
            revision: "workspace_1",
            canonicalHead:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            correlationId: "correlation_1",
            causation: {
              kind: "migration" as const,
              migrationId: "migration_1",
            },
          },
        },
      },
    },
  };
}

function processingLifecycle() {
  const sleeping = sleepingLifecycle();
  return {
    kind: "processing" as const,
    state: {
      identity: sleeping.state.identity,
      contract: { ...sleeping.state.contract, lastEventSequence: 2 },
      resumePoint: sleeping.state.resumePoint,
      runtimeLease: { generation: 1, leaseId: "runtime_lease_1" },
      activeTurn: {
        kind: "admitted" as const,
        state: {
          identity: {
            turnId: "turn_1",
            inputId: "input_1",
            turnLeaseGeneration: 1,
            budgetRevision: "budget_1",
          },
          admittedAt: 11,
        },
      },
    },
  };
}
