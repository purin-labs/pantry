/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { ConnectorDO } from "../src/actors/connector";
import {
  digestOperationalEmailSnapshot,
  expireOperationalEmailProposals,
  isDefinitiveGmailSendRejection,
  revokeOperationalEmailProposals,
} from "../src/actors/connector-email-operational";
import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { activateConnectorFixture } from "./fixtures/connector-activation";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
import {
  parseOrganisationId,
  parseConnectorId,
  parseIntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const NOW = 1_790_000_000_000;
const ACCOUNT = "integration_operational_test";

describe("operational email proposal boundary", operationalEmailSuite);

function operationalEmailSuite(): void {
  it("accepts the complete approve and reject RPC shape", dispatchParserTest);
  it(
    "binds sender and recipient into the approved snapshot",
    snapshotBindingTest,
  );
  it("purges unattended expiry and account revocation", cleanupTest);
  it("distinguishes rejected 4xx sends from ambiguous transport failures", () => {
    expect(
      isDefinitiveGmailSendRejection({
        code: "gmail_unavailable",
        status: 400,
      }),
    ).toBe(true);
    expect(
      isDefinitiveGmailSendRejection({
        code: "gmail_unavailable",
        status: 503,
      }),
    ).toBe(false);
  });
}

async function dispatchParserTest(): Promise<void> {
  const db = createMigratedDatabase();
  const organisationId = parseOrganisationId("organisation_operational_test");
  const connectorId = parseConnectorId("connector_operational_test");
  if (!organisationId.ok || !connectorId.ok)
    throw new Error("Invalid fixture identity");
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'operational', 'Operational', 0)",
    )
    .bind(organisationId.value)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisationId.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const env = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const { connector } = setup(env);
  await activateConnectorFixture(
    connector,
    env,
    organisationId.value,
    connectorId.value,
  );
  const rejected = await connector.rejectEmailOperational({
    identity: {
      organisationId: "organisation_operational_test",
      connectorId: "connector_operational_test",
    },
    integrationAccountId: ACCOUNT,
    proposalId: "proposal_operational_test",
    approvedVersion: 1,
    approvedSnapshotDigest: "a".repeat(64),
    now: NOW,
  });
  expect(rejected).toEqual({
    ok: false,
    error: { code: "operational_email_proposal_missing" },
  });
}

async function snapshotBindingTest(): Promise<void> {
  const integrationAccountId = parseIntegrationAccountId(ACCOUNT);
  if (!integrationAccountId.ok) throw new Error("test account id is invalid");
  const base = {
    proposalId: "proposal_operational_test",
    version: 1,
    caseId: "case_operational_test",
    integrationAccountId: integrationAccountId.value,
    authorizationProduct: "send_only" as const,
    credentialGeneration: 1,
    policyVersion: 1,
    expiresAt: NOW + 60_000,
    sender: "sender@example.com",
    recipient: "recipient@example.com",
    targetDigest: "1".repeat(64),
    subjectDigest: "2".repeat(64),
    bodyDigest: "3".repeat(64),
  };
  const approved = await digestOperationalEmailSnapshot(base);
  const changedRecipient = await digestOperationalEmailSnapshot({
    ...base,
    recipient: "other@example.com",
  });
  const changedSender = await digestOperationalEmailSnapshot({
    ...base,
    sender: "other-sender@example.com",
  });
  expect(changedRecipient).not.toBe(approved);
  expect(changedSender).not.toBe(approved);
}

function cleanupTest(): void {
  const { sql } = setup();
  seed(sql, "proposal_expired", NOW - 1);
  seed(sql, "proposal_revoked", NOW + 60_000);

  expect(expireOperationalEmailProposals(sql, NOW)).toHaveLength(1);
  expect(row(sql, "proposal_expired")).toMatchObject({
    state: "expired",
    nonce: null,
    ciphertext: null,
  });

  const accountId = parseIntegrationAccountId(ACCOUNT);
  if (!accountId.ok) throw new Error("test account id is invalid");
  expect(
    revokeOperationalEmailProposals(sql, accountId.value, NOW + 1),
  ).toHaveLength(1);
  expect(row(sql, "proposal_revoked")).toMatchObject({
    state: "revoked",
    nonce: null,
    ciphertext: null,
  });
}

function seed(sql: SqlStorage, proposalId: string, expiresAt: number): void {
  sql.exec(
    `INSERT INTO connector_email_operational_proposal (
       proposal_id, version, case_id, integration_account_id, target_json,
       target_digest, subject_digest, body_digest, snapshot_digest,
       policy_version, credential_generation, state, approved_snapshot_digest,
       nonce_b64, ciphertext_b64, content_bytes, sent_message_id,
       sent_thread_id, created_at, expires_at, updated_at
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'awaiting_approval', NULL,
       'nonce', 'ciphertext', 10, NULL, NULL, ?, ?, ?)`,
    proposalId,
    `case_${proposalId}`,
    ACCOUNT,
    JSON.stringify({
      kind: "customer_contact",
      customerId: "customer_1",
      contactId: "contact_1",
      contactRevision: 1,
    }),
    "1".repeat(64),
    "2".repeat(64),
    "3".repeat(64),
    "4".repeat(64),
    NOW - 100,
    expiresAt,
    NOW - 100,
  );
}

function row(
  sql: SqlStorage,
  proposalId: string,
): {
  readonly state: string;
  readonly nonce: string | null;
  readonly ciphertext: string | null;
} {
  const value = sql
    .exec<{ state: string; nonce: string | null; ciphertext: string | null }>(
      `SELECT state, nonce_b64 AS nonce, ciphertext_b64 AS ciphertext
       FROM connector_email_operational_proposal WHERE proposal_id = ?`,
      proposalId,
    )
    .toArray()[0];
  if (value === undefined) throw new Error("proposal row is missing");
  return value;
}

function setup(env: UnitTestEnv = {} as UnitTestEnv): Readonly<{
  readonly connector: ConnectorDO;
  readonly sql: SqlStorage;
}> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const storage = new TestStorage(fixture.database, sql);
  return {
    connector: new ConnectorDO(
      { storage, waitUntil: vi.fn() } as unknown as DurableObjectState,
      env,
    ),
    sql,
  };
}

class TestStorage {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: SqlStorage,
  ) {}

  transactionSync<Value>(callback: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
