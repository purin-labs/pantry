import { createMigratedDatabase } from "./sqlite-d1";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { ensureInitialOrganisationPlacement } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { createActorExecutionBarrierSchema } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { describe, expect, it } from "vitest";

import {
  activateEmailRuntime,
  createConnectorEmailSchema,
  disableEmailRuntime,
  pendingEmailDraftProposals,
  recordEmailDraftOperation,
  updateEmailDraftState,
  type EmailDraftState,
  type EmailIngressLimits,
} from "../src/actors/connector-email";
import { createConnectorEvalSchema } from "../src/actors/connector-eval";
import { dispatchEmailReply } from "../src/actors/connector-email-proposal";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { platformEnv } from "./worker-fakes";

const NOW = 1_784_016_325_277;

describe("email mailbox revocation enumeration", revocationSuite);

function revocationSuite(): void {
  it("collects every proposal that still owns a Gmail draft", pendingTest);
  it("fails closed on an unknown latest draft state", corruptStateTest);
  it("follows the newest version of a re-versioned proposal", versionTest);
  it("fences delivery the moment the runtime is stood down", fenceTest);
}

/**
 * Revocation disables the runtime before it disposes anything. That ordering
 * is the guarantee an operator is really buying: an approval already in flight
 * cannot slip through and send while the mailbox is being torn down. The proof
 * is that dispatch refuses without reaching Gmail at all.
 */
async function fenceTest(): Promise<void> {
  const sql = setup();
  createActorExecutionBarrierSchema(sql);
  const organisation = parseOrganisationId("organisation_fence");
  if (!organisation.ok) throw new Error(organisation.error.code);
  const db = createMigratedDatabase();
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'email-fence', 'Email fence', 0)",
    )
    .bind(organisation.value)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisation.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 0,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const env = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const scope = await requireOrganisationExecutionScope(
    env,
    organisation.value,
  );
  const limits: EmailIngressLimits = {
    maxActiveCases: 5,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 100_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
  };
  const activated = activateEmailRuntime(sql, {
    organisationId: "organisation_fence",
    integrationAccountId: "integration_fence",
    policyVersion: 1,
    limits,
    activationFloor: "1000",
    watchExpiresAt: NOW + 86_400_000,
    now: NOW - 1000,
  });
  expect(activated.ok).toBe(true);
  seed(sql, "p_inflight", 1, "awaiting_approval");

  disableEmailRuntime(sql, { now: NOW });

  let reached = false;
  const fetcher = (async () => {
    reached = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const dispatched = await dispatchEmailReply({
    sql,
    env,
    scope,
    proposalId: "p_inflight",
    approvedVersion: 1,
    approvedSnapshotDigest: "3".repeat(64),
    now: NOW + 1,
    fetcher,
  });
  expect(dispatched).toEqual({
    ok: false,
    error: { code: "connector_email_runtime_missing" },
  });
  expect(reached).toBe(false);

  // The draft is still outstanding, so teardown can still find and remove it.
  expect(
    pendingEmailDraftProposals(sql).map((operation) => operation.proposalId),
  ).toEqual(["p_inflight"]);
}

function setup(): ReturnType<typeof sqlStorage> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorEmailSchema(sql, createConnectorEvalSchema);
  return sql;
}

function seed(
  sql: ReturnType<typeof sqlStorage>,
  proposalId: string,
  version: number,
  state: EmailDraftState,
): void {
  recordEmailDraftOperation(sql, {
    proposalId,
    version,
    caseId: `case_${proposalId}`,
    threadId: `thread_${proposalId}`,
    draftId: `draft_${proposalId}_v${version}`,
    draftMessageId: `draft_msg_${proposalId}_v${version}`,
    triggeringMessageId: `m_${proposalId}`,
    targetDigest: "1".repeat(64),
    bodyDigest: "2".repeat(64),
    snapshotDigest: "3".repeat(64),
    policyVersion: 1,
    expiresAt: NOW + 86_400_000,
    now: NOW,
  });
  if (state !== "awaiting_approval") {
    updateEmailDraftState(sql, { proposalId, version, state, now: NOW });
  }
}

function pendingTest(): void {
  const sql = setup();
  seed(sql, "p_awaiting", 1, "awaiting_approval");
  seed(sql, "p_indeterminate", 1, "send_indeterminate");
  seed(sql, "p_invalidated", 1, "invalidated");
  seed(sql, "p_cleanup", 1, "cleanup_pending");
  seed(sql, "p_unreachable", 1, "cleanup_unreachable");
  // A delivered proposal already had its draft deleted, and a deleted one has
  // nothing left to remove. Neither may reappear as outstanding cleanup.
  seed(sql, "p_sent", 1, "sent");
  seed(sql, "p_deleted", 1, "deleted");

  const pending = pendingEmailDraftProposals(sql);
  expect(pending.map((operation) => operation.proposalId)).toEqual([
    "p_awaiting",
    "p_cleanup",
    "p_indeterminate",
    "p_invalidated",
    "p_unreachable",
  ]);
}

function corruptStateTest(): void {
  const sql = setup();
  seed(sql, "p_corrupt", 1, "awaiting_approval");
  sql.exec("PRAGMA ignore_check_constraints = ON");
  sql.exec(
    "UPDATE connector_email_draft SET state = 'corrupt' WHERE proposal_id = 'p_corrupt' AND version = 1",
  );
  sql.exec("PRAGMA ignore_check_constraints = OFF");

  let thrown: unknown = null;
  try {
    pendingEmailDraftProposals(sql);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toEqual(new Error("connector_email_draft_corrupt"));
}

function versionTest(): void {
  const sql = setup();
  // A body edit supersedes version 1; revocation must chase the live draft.
  seed(sql, "p_edited", 1, "deleted");
  seed(sql, "p_edited", 2, "awaiting_approval");
  const pending = pendingEmailDraftProposals(sql);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ proposalId: "p_edited", version: 2 });

  // Once the newest version reaches a terminal state nothing is outstanding.
  updateEmailDraftState(sql, {
    proposalId: "p_edited",
    version: 2,
    state: "deleted",
    now: NOW,
  });
  expect(pendingEmailDraftProposals(sql)).toHaveLength(0);
}
