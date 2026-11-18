import { parseFixtureUserId } from "./test-ids";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  beginActionExecution,
  completeActionExecution,
  createActionLedgerSchema,
  proposeAction,
  requestActionApproval,
  signAction,
} from "../src/actors/action-ledger";
import {
  applyCommerceDelivery as applyCommerceDeliveryWithAuthority,
  createCommerceProjectionSchema,
  readCommerceSystemSyncStatus,
  readCurrentCommerceProjection,
  validateCommerceSystemProjections,
  type ApplyCommerceDeliveryInput,
} from "../src/actors/commerce-projection";
import { COMMERCE_LAB_INTEGRATION_ACCOUNT_ID } from "../src/commerce-lab/lab-metadata";
import {
  createCommerceLabScenarioRun,
  parseCommerceLabIdempotencyKey,
} from "../src/commerce-lab/scenarios";
import {
  buildCommerceActionDraft,
  buildCommerceLabDelivery,
} from "../src/commerce/action-model";
import { normalizeLabCommerceDelivery } from "../src/commerce/commerce-wasm";
import { parseCommerceSystemRevision } from "../src/data/organisation-commerce-system";
import {
  parseApprovalProofDigest,
  type ApprovalEvidence,
} from "../src/approval-authentication";
import {
  parseCaseId,
  parseControlSessionId,
  parseIntegrationAccountId,
  parsePersonId,
  parseSessionId,
  parseOrganisationId,
} from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import {
  fixtureFlowBinding,
  fixtureProviderActionAuthority,
} from "./fixtures/plan25-turn";

function applyCommerceDelivery(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
) {
  return applyCommerceDeliveryWithAuthority(sql, input, {
    kind: "lab",
    revision: null,
  });
}

const ORGANISATION_ID = "organisation_commerce_loop";
const OBSERVED_AT = "2026-08-04T00:00:00.000Z";
describe("local commerce walking loop", () => {
  it("syncs, inspects, approves, executes, and records one provider receipt", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createCommerceProjectionSchema(sql);
    createActionLedgerSchema(sql);
    const organisationId = requiredOrganisationId();
    const integrationAccountId = requiredIntegrationAccountId();
    const sessionId = requiredSessionId();
    const idempotencyKey = parseCommerceLabIdempotencyKey("commerce_loop_0001");
    if (!idempotencyKey.ok) throw new Error(idempotencyKey.error.code);
    const run = createCommerceLabScenarioRun({
      scenarioId: "product-listing",
      idempotencyKey: idempotencyKey.value,
      startedAt: Date.parse(OBSERVED_AT),
    });
    if (!run.ok) throw new Error(run.error.code);
    expect(
      readCommerceSystemSyncStatus(sql, {
        organisationId,
        integrationAccountId,
        now: Date.parse(OBSERVED_AT),
      }),
    ).toEqual({
      ok: true,
      value: { kind: "syncing", acceptedResourceCount: 0 },
    });
    const sourceEvent = run.value.events[0];
    if (sourceEvent === undefined)
      throw new Error("commerce lab source event missing");
    const normalized = normalizeLabCommerceDelivery({
      schemaVersion: "satyr.commerce.lab.event.v1",
      namespace: "lab_local_loop",
      runId: run.value.runId,
      scenarioId: run.value.scenarioId,
      organisationId: ORGANISATION_ID,
      integrationAccountId: COMMERCE_LAB_INTEGRATION_ACCOUNT_ID,
      observedAt: OBSERVED_AT,
      event: sourceEvent,
    });
    if (!normalized.ok) throw new Error(normalized.error.code);

    expect(
      applyCommerceDelivery(sql, {
        organisationId,
        integrationAccountId,
        delivery: normalized.value,
        cueFacts: [],
        labRunId: run.value.runId,
        processedAt: Date.parse(OBSERVED_AT),
      }),
    ).toMatchObject({ ok: true, value: { disposition: "accepted" } });
    expect(
      readCommerceSystemSyncStatus(sql, {
        organisationId,
        integrationAccountId,
        now: Date.parse(OBSERVED_AT),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "ready",
        acceptedResourceCount: expect.any(Number),
        lastSyncedAt: Date.parse(OBSERVED_AT),
      },
    });
    const validatedAt = Date.parse(OBSERVED_AT) + 60_000;
    expect(
      validateCommerceSystemProjections(sql, {
        organisationId,
        integrationAccountId,
        validatedAt,
      }),
    ).toMatchObject({
      ok: true,
      value: { validatedResourceCount: expect.any(Number), validatedAt },
    });
    expect(
      readCommerceSystemSyncStatus(sql, {
        organisationId,
        integrationAccountId,
        now: validatedAt,
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "ready", lastSyncedAt: validatedAt },
    });
    expect(
      readCommerceSystemSyncStatus(sql, {
        organisationId,
        integrationAccountId,
        now: validatedAt + 15 * 60 * 1_000 + 1,
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "delayed", lastSyncedAt: validatedAt },
    });
    const current = readCurrentCommerceProjection(sql, {
      organisationId,
      kind: "offer",
      canonicalId: "offer_variant_field_watch_black_lab_online",
    });
    expect(current).toMatchObject({ ok: true, value: { kind: "offer" } });
    if (!current.ok || current.value === null)
      throw new Error("commerce projection missing");

    const draft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      sessionId,
      threadId: "thread_commerce_loop",
      request: {
        kind: "publish_catalog_listing",
        productId: "product_field_watch",
        productRevision: 2,
        variantId: "variant_field_watch_black",
        variantRevision: 2,
        offerId: "offer_variant_field_watch_black_lab_online",
        offerRevision: 2,
        salesChannelId: "sales_channel_lab_online",
        salesChannelRevision: 2,
      },
      current: current.value,
      exp: 10_000,
      now: 1_000,
    });
    if (!draft.ok) throw new Error(draft.error.code);
    const authority = fixtureProviderActionAuthority({
      organisationId,
      integrationAccountId,
      providerResourceScope: draft.value.resourceKey,
    });
    const proposed = requireEntry(
      proposeAction(sql, {
        organisationId,
        integrationAccountId,
        requestAuthority: authority.requestAuthority,
        authorityPartition: authority.authorityPartition,
        authority: {
          kind: "commerce_system",
          system: "satyr_commerce",
          revision: requiredCommerceSystemRevision(),
        },
        caseId: requiredCaseId(),
        proposalId: "proposal_commerce_loop",
        sessionId,
        threadId: "thread_commerce_loop",
        draft: draft.value,
        flowBinding: fixtureFlowBinding({
          organisationId,
          sessionId,
          authorityPartitionDigest: authority.authorityPartition.digest,
        }),
        exp: 10_000,
        now: 1_000,
      }),
    );
    const approval = requireEntry(
      requestActionApproval(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        now: 1_100,
      }),
    );
    const signed = requireEntry(
      signAction(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        approval: approvalEvidence("commerce_loop", 1_200),
        now: 1_200,
      }),
    );
    const executing = requireEntry(
      beginActionExecution(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        now: 1_300,
      }),
    );
    expect(approval.state).toBe("approval_requested");
    expect(signed.state).toBe("signed");
    expect(executing.state).toBe("executing");

    const provider = await buildCommerceLabDelivery({
      action: executing.action,
      current: current.value,
      now: Date.parse(OBSERVED_AT),
    });
    if (!provider.ok) throw new Error(provider.error.code);
    expect(
      applyCommerceDelivery(sql, {
        organisationId,
        integrationAccountId,
        delivery: provider.value.delivery,
        cueFacts: [],
        labRunId: run.value.runId,
        processedAt: Date.parse(OBSERVED_AT),
      }),
    ).toMatchObject({ ok: true, value: { disposition: "accepted" } });
    const confirmed = requireEntry(
      completeActionExecution(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        executionLeaseId:
          executing.state === "executing"
            ? executing.executionLease.leaseId
            : "invalid_execution_lease",
        outcome: "confirmed",
        providerResult: JSON.stringify(provider.value.receipt),
        now: 1_400,
      }),
    );
    expect(confirmed).toMatchObject({
      state: "confirmed",
      providerResult: expect.stringContaining("commerce_provider_receipt"),
    });
    expect(
      readCurrentCommerceProjection(sql, {
        organisationId,
        kind: "offer",
        canonicalId: "offer_variant_field_watch_black_lab_online",
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "offer", projection: { lifecycle: { state: "listed" } } },
    });
  });

  it("cancels a synced order through the governed receipt path", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createCommerceProjectionSchema(sql);
    createActionLedgerSchema(sql);
    const organisationId = requiredOrganisationId();
    const integrationAccountId = requiredIntegrationAccountId();
    const sessionId = requiredSessionId();
    const idempotencyKey = parseCommerceLabIdempotencyKey(
      "commerce_loop_order_0001",
    );
    if (!idempotencyKey.ok) throw new Error(idempotencyKey.error.code);
    const run = createCommerceLabScenarioRun({
      scenarioId: "cancellation-refund",
      idempotencyKey: idempotencyKey.value,
      startedAt: Date.parse(OBSERVED_AT),
    });
    if (!run.ok) throw new Error(run.error.code);
    for (const sourceEvent of run.value.events.slice(0, 2)) {
      const observedAt = sourceEvent.occurredAt;
      const normalized = normalizeLabCommerceDelivery({
        schemaVersion: "satyr.commerce.lab.event.v1",
        namespace: "lab_local_loop",
        runId: run.value.runId,
        scenarioId: run.value.scenarioId,
        organisationId: ORGANISATION_ID,
        integrationAccountId: COMMERCE_LAB_INTEGRATION_ACCOUNT_ID,
        observedAt,
        event: sourceEvent,
      });
      if (!normalized.ok) throw new Error(normalized.error.code);
      expect(
        applyCommerceDelivery(sql, {
          organisationId,
          integrationAccountId,
          delivery: normalized.value,
          cueFacts: [],
          labRunId: run.value.runId,
          processedAt: Date.parse(observedAt),
        }),
      ).toMatchObject({ ok: true, value: { disposition: "accepted" } });
    }
    const current = readCurrentCommerceProjection(sql, {
      organisationId,
      kind: "commerce_order",
      canonicalId: "order_lab_cancelled",
    });
    expect(current).toMatchObject({
      ok: true,
      value: {
        kind: "commerce_order",
        projection: { lifecycle: { state: "confirmed" } },
      },
    });
    if (!current.ok || current.value === null)
      throw new Error("order projection missing");

    const draft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      sessionId,
      threadId: "thread_commerce_order_loop",
      request: {
        kind: "cancel_order",
        resourceId: "order_lab_cancelled",
        expectedRevision: 1,
        reason: "customer_requested",
        refund: "full",
        restock: true,
        notifyCustomer: true,
        note: "Customer requested cancellation",
      },
      current: current.value,
      exp: 10_000,
      now: 2_000,
    });
    if (!draft.ok) throw new Error(draft.error.code);
    const authority = fixtureProviderActionAuthority({
      organisationId,
      integrationAccountId,
      providerResourceScope: draft.value.resourceKey,
    });
    const proposed = requireEntry(
      proposeAction(sql, {
        organisationId,
        integrationAccountId,
        requestAuthority: authority.requestAuthority,
        authorityPartition: authority.authorityPartition,
        authority: {
          kind: "commerce_system",
          system: "satyr_commerce",
          revision: requiredCommerceSystemRevision(),
        },
        caseId: requiredCaseId(),
        proposalId: "proposal_commerce_order_loop",
        sessionId,
        threadId: "thread_commerce_order_loop",
        draft: draft.value,
        flowBinding: fixtureFlowBinding({
          organisationId,
          sessionId,
          authorityPartitionDigest: authority.authorityPartition.digest,
        }),
        exp: 10_000,
        now: 2_000,
      }),
    );
    requireEntry(
      requestActionApproval(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        now: 2_100,
      }),
    );
    requireEntry(
      signAction(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        approval: approvalEvidence("commerce_order_loop", 2_200),
        now: 2_200,
      }),
    );
    const executing = requireEntry(
      beginActionExecution(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        now: 2_300,
      }),
    );
    const provider = await buildCommerceLabDelivery({
      action: executing.action,
      current: current.value,
      now: Date.parse(OBSERVED_AT) + 2_000,
    });
    if (!provider.ok) throw new Error(provider.error.code);
    expect(
      applyCommerceDelivery(sql, {
        organisationId,
        integrationAccountId,
        delivery: provider.value.delivery,
        cueFacts: [],
        labRunId: run.value.runId,
        processedAt: Date.parse(OBSERVED_AT) + 2_000,
      }),
    ).toMatchObject({ ok: true, value: { disposition: "accepted" } });
    const confirmed = requireEntry(
      completeActionExecution(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        executionLeaseId:
          executing.state === "executing"
            ? executing.executionLease.leaseId
            : "invalid_execution_lease",
        outcome: "confirmed",
        providerResult: JSON.stringify(provider.value.receipt),
        now: 2_400,
      }),
    );
    expect(confirmed).toMatchObject({
      state: "confirmed",
      providerResult: expect.stringContaining("commerce_provider_receipt"),
    });
    expect(
      readCurrentCommerceProjection(sql, {
        organisationId,
        kind: "commerce_order",
        canonicalId: "order_lab_cancelled",
      }),
    ).toMatchObject({
      ok: true,
      value: { projection: { lifecycle: { state: "cancelled" } } },
    });
  });
});

function requiredOrganisationId(raw = ORGANISATION_ID) {
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredIntegrationAccountId() {
  const parsed = parseIntegrationAccountId(COMMERCE_LAB_INTEGRATION_ACCOUNT_ID);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredSessionId() {
  const parsed = parseSessionId("session_commerce_loop");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredCommerceSystemRevision() {
  const parsed = parseCommerceSystemRevision(1);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredCaseId() {
  const parsed = parseCaseId("case_commerce_loop");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function approvalEvidence(
  suffix: string,
  authenticatedAt: number,
): ApprovalEvidence {
  const userId = parseFixtureUserId(`control_${suffix}`);
  const controlSessionId = parseControlSessionId(`control_session_${suffix}`);
  const personId = parsePersonId(`person_${suffix}`);
  const organisationId = parseOrganisationId(`organisation_${suffix}`);
  const actionDigest = parseApprovalProofDigest("00".repeat(32));
  if (
    !userId.ok ||
    !controlSessionId.ok ||
    !personId.ok ||
    !organisationId.ok ||
    actionDigest === null
  ) {
    throw new Error("invalid approval fixture");
  }
  return {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: userId.value,
      personId: personId.value,
      role: "owner",
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: controlSessionId.value,
      authenticatedAt,
      challenge: {
        stepUpId: `fixture:${suffix}`,
        organisationId: organisationId.value,
        actionNonce: `action_${suffix}`,
        actionDigest,
        policy: { kind: "unversioned_default" },
        issuedAt: authenticatedAt,
        expiresAt: authenticatedAt + 600_000,
      },
    },
  };
}

function requireEntry<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
