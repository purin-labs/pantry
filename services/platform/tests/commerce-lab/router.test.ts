import type { SingleDatabase } from "../../src/database-handles";
import { createOrganisationExecutionFixture } from "../organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "../fixtures/organisation-placement";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

const labState = vi.hoisted(createLabState);

vi.mock("@purin-labs/commerce-contracts/lab-normalizer", labNormalizerMockFactory);

import {
  commerceLabRunReadyForCompletion,
  deleteCommerceCueEvidence,
  handleCommerceLabRoute,
  parseCommerceProposalCue,
} from "../../src/commerce-lab/router";
import { markCommerceLabOrganisation } from "../../src/commerce-lab/lab-metadata";
import {
  parseCanonicalCommerceDelivery,
  parseCommerceCueFacts,
} from "../../src/actors/commerce-projection";
import { d1Database } from "../sqlite-d1";
import { bytesToHex } from "@purin-labs/std";
import { requireOrganisationId } from "../test-ids";
import { createMigratedDatabase } from "../sqlite-d1";
import { platformEnv, type UnitTestEnv } from "../worker-fakes";

const ADMIN_TOKEN = "commerce-lab-admin-token-000000000000";
const SIGNING_SECRET = "commerce-lab-signing-secret-00000000";
const LAB_INTEGRATION_ACCOUNT_ID = "integration_account_commerce_lab";

describe("commerce lab HTTP boundary", function commerceLabRouterSuite() {
  it("keeps admin routes hidden without the configured bearer", async function adminAuth() {
    const response = await handleCommerceLabRoute(
      new Request(
        "https://pantry.test/v1/admin/commerce-lab/organisation_lab/reset",
        {
          method: "POST",
        },
      ),
      testEnv(),
      {
        kind: "admin",
        operation: "reset",
        organisationIdRaw: "organisation_lab",
      },
    );

    expect(response.status).toBe(404);
  });

  it("rejects unsigned ingress before organisation state is read", async function ingressSignature() {
    const response = await handleCommerceLabRoute(
      new Request(
        "https://pantry.test/v1/hooks/commerce-lab/organisation_lab/events",
        { method: "POST", body: "{}" },
      ),
      testEnv(),
      { kind: "ingress", organisationIdRaw: "organisation_lab" },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "commerce_lab_signature_missing" },
    });
  });

  it("rejects proposal scenarios without an active commerce cue target", async function missingCueTarget() {
    const db = createMigratedDatabase();
    const organisationId = requireOrganisationId(
      "organisation_lab_missing_cue",
    );
    const env = platformEnv({
      ...testEnv(organisationId),
      DB: db,
      POLICY_KV: { get: vi.fn().mockResolvedValue(null) },
    });

    await insertDevelopmentOrganisation(db, organisationId);
    await createOrganisationExecutionFixture(db, organisationId);
    const marked = await markCommerceLabOrganisation({
      db,
      organisationId,
      labNamespace: "lab_missing_cue",
      markedAt: 1_000,
    });
    expect(marked.ok).toBe(true);

    const response = await handleCommerceLabRoute(
      commerceScenarioRequest(
        organisationId,
        "payment-failed",
        "lab_missing_cue",
        "missing_cue_target",
      ),
      env,
      {
        kind: "admin",
        operation: "scenario",
        organisationIdRaw: organisationId,
        scenarioIdRaw: "payment-failed",
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "commerce_lab_cue_subscription_missing" },
    });
  });

  it("accepts a valid signed event and queues its canonical projection and cue facts", async function signedIngress() {
    const db = createMigratedDatabase();
    const organisationId = requireOrganisationId(
      "organisation_lab_signed_ingress",
    );
    const eventQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const env = platformEnv({
      ...testEnv(organisationId),
      DB: db,
      EVENT_Q: eventQueue,
    });

    await insertDevelopmentOrganisation(db, organisationId);
    await createOrganisationExecutionFixture(db, organisationId);
    const marked = await markCommerceLabOrganisation({
      db,
      organisationId,
      labNamespace: "lab_signed_ingress",
      markedAt: 1_000,
    });
    expect(marked.ok).toBe(true);

    const scenarioResponse = await handleCommerceLabRoute(
      new Request(
        `https://pantry.test/v1/admin/commerce-lab/${organisationId}/scenarios/payment-failed`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            labNamespace: "lab_signed_ingress",
            idempotencyKey: "signed_ingress_payment_failed",
          }),
        },
      ),
      env,
      {
        kind: "admin",
        operation: "scenario",
        organisationIdRaw: organisationId,
        scenarioIdRaw: "payment-failed",
      },
    );
    expect(scenarioResponse.status).toBe(200);
    const scenarioPayload = await scenarioResponse.json();
    const run = readScenarioRun(scenarioPayload);
    const event = run.events[1];
    if (event === undefined) {
      throw new Error("signed ingress scenario event missing");
    }
    const eventOccurredAt = readText(event, "occurredAt");
    const observedAt = new Date(
      Date.parse(eventOccurredAt) + 1_000,
    ).toISOString();
    const canonical = canonicalPaymentFailure(
      organisationId,
      LAB_INTEGRATION_ACCOUNT_ID,
      observedAt,
      event,
    );
    const cueFacts = paymentFailureCueFacts(event);
    const parsedCanonical = parseCanonicalCommerceDelivery(canonical);
    if (!parsedCanonical.ok) {
      throw new Error(JSON.stringify(parsedCanonical.error));
    }
    expect(parseCommerceCueFacts(cueFacts)).toMatchObject({ ok: true });
    labState.normalizeValue = canonical;
    labState.cueValue = cueFacts;
    const body = JSON.stringify({
      schemaVersion: "satyr.commerce.lab.event.v1",
      namespace: "lab_signed_ingress",
      runId: run.runId,
      scenarioId: run.scenarioId,
      organisationId,
      integrationAccountId: LAB_INTEGRATION_ACCOUNT_ID,
      observedAt,
      event,
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = await signLabRequest(timestamp, body);

    const response = await handleCommerceLabRoute(
      new Request(
        `https://pantry.test/v1/hooks/commerce-lab/${organisationId}/events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-satyr-lab-timestamp": timestamp,
            "x-satyr-lab-signature": signature,
          },
          body,
        },
      ),
      env,
      { kind: "ingress", organisationIdRaw: organisationId },
    );

    const responsePayload = await response.clone().json();
    expect({ status: response.status, payload: responsePayload }).toEqual({
      status: 202,
      payload: expect.objectContaining({ ok: true }),
    });
    expect(eventQueue.send).toHaveBeenCalledTimes(1);
    expect(eventQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "commerce.delivery.v1",
        organisationId,
        integrationAccountId: LAB_INTEGRATION_ACCOUNT_ID,
        labRunId: run.runId,
        canonicalDeliveryJson: JSON.stringify(canonical),
        canonicalCueFactsJson: JSON.stringify(cueFacts),
      }),
    );
  });

  it("returns method fencing before any admin state mutation", async function methodFence() {
    const response = await handleCommerceLabRoute(
      new Request(
        "https://pantry.test/v1/admin/commerce-lab/organisation_lab/reset",
        {
          method: "GET",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      ),
      testEnv(),
      {
        kind: "admin",
        operation: "reset",
        organisationIdRaw: "organisation_lab",
      },
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("deletes Cue evidence for a production-length provider event", async function resetCueEvidence() {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE cue_log (
      organisation_id TEXT NOT NULL, source TEXT NOT NULL, native_id TEXT NOT NULL
    )`);
    const organisationId = requireOrganisationId("organisation_lab");
    const eventId =
      "commerce_lab_run_inventory-shortage_p15_konbini_inventory_20260803_v2_event_3";
    const matching = `commerce:${eventId}:inventory_shortage:1`;
    const unrelated = `commerce:${eventId}_other:inventory_shortage:1`;
    sqlite
      .prepare("INSERT INTO cue_log VALUES (?, 'commerce', ?)")
      .run(organisationId, matching);
    sqlite
      .prepare("INSERT INTO cue_log VALUES (?, 'commerce', ?)")
      .run(organisationId, unrelated);
    const db = d1Database(sqlite);

    await deleteCommerceCueEvidence(db, organisationId, eventId);

    expect(sqlite.prepare("SELECT native_id FROM cue_log").all()).toEqual([
      { native_id: unrelated },
    ]);
  });

  it("completes a run only after every event and terminal projection is observed", function completionFence() {
    const evidence = {
      providerEventIds: ["event_catalog", "event_inventory"],
      expectedSlackEffect: { kind: "none" as const },
      expectedProjections: [
        {
          kind: "product" as const,
          canonicalId: "product_field_watch",
          lifecycle: "listed",
        },
        {
          kind: "inventory_position" as const,
          canonicalId: "inventory_lab_field_black",
          lifecycle: "in_stock",
        },
      ],
    };
    const incomplete = {
      result: "running" as const,
      projectionReceipts: [
        {
          eventId: "event_catalog:product:product_field_watch:2",
          providerDeliveryId: "event_catalog",
          disposition: "applied" as const,
          projectionKind: "product" as const,
          canonicalId: "product_field_watch",
          revision: 2,
          deliveryCount: 1,
        },
      ],
      terminalProjectionIdentities: [
        {
          kind: "product" as const,
          canonicalId: "product_field_watch",
          lifecycle: "listed",
          revision: 2,
        },
      ],
    };
    const complete = {
      result: "running" as const,
      projectionReceipts: [
        {
          eventId: "event_catalog:product:product_field_watch:2",
          providerDeliveryId: "event_catalog",
          disposition: "applied" as const,
          projectionKind: "product" as const,
          canonicalId: "product_field_watch",
          revision: 2,
          deliveryCount: 1,
        },
        {
          eventId:
            "event_inventory:inventory_position:inventory_lab_field_black:1",
          providerDeliveryId: "event_inventory",
          disposition: "applied" as const,
          projectionKind: "inventory_position" as const,
          canonicalId: "inventory_lab_field_black",
          revision: 1,
          deliveryCount: 1,
        },
      ],
      terminalProjectionIdentities: [
        {
          kind: "product" as const,
          canonicalId: "product_field_watch",
          lifecycle: "listed",
          revision: 2,
        },
        {
          kind: "inventory_position" as const,
          canonicalId: "inventory_lab_field_black",
          lifecycle: "in_stock",
          revision: 1,
        },
      ],
    };

    expect(commerceLabRunReadyForCompletion(incomplete, evidence, 0)).toBe(
      false,
    );
    expect(commerceLabRunReadyForCompletion(complete, evidence, 0)).toBe(true);
  });

  it("keeps proposal scenarios running until a durable proposal target exists", function proposalCompletionFence() {
    const evidence = {
      providerEventIds: ["event_payment"],
      expectedProjections: [
        {
          kind: "payment" as const,
          canonicalId: "payment_lab_failed",
          lifecycle: "failed",
        },
      ],
      expectedSlackEffect: {
        kind: "proposal" as const,
        eventType: "payment_failed" as const,
        canonicalId: "payment_lab_failed",
      },
    };
    const projected = {
      result: "running" as const,
      projectionReceipts: [
        {
          eventId: "event_payment:payment:payment_lab_failed:1",
          providerDeliveryId: "event_payment",
          disposition: "applied" as const,
          projectionKind: "payment" as const,
          canonicalId: "payment_lab_failed",
          revision: 1,
          deliveryCount: 1,
        },
      ],
      terminalProjectionIdentities: [
        {
          kind: "payment" as const,
          canonicalId: "payment_lab_failed",
          lifecycle: "failed",
          revision: 1,
        },
      ],
    };

    expect(commerceLabRunReadyForCompletion(projected, evidence, 0)).toBe(
      false,
    );
    expect(commerceLabRunReadyForCompletion(projected, evidence, 1)).toBe(true);
  });

  it("parses Slack and Case proposal targets without conflating them", function proposalTargets() {
    expect(
      parseCommerceProposalCue({
        cueId: "cue_case:proposed",
        nativeId: "commerce:event_1:inventory_shortage:1",
        reason: "case:case_inventory_1",
        surfaceKind: null,
        surfaceThreadId: null,
        at: 1,
      }),
    ).toEqual({
      cueId: "cue_case:proposed",
      nativeId: "commerce:event_1:inventory_shortage:1",
      target: { kind: "case", caseId: "case_inventory_1" },
      at: 1,
    });
    expect(
      parseCommerceProposalCue({
        cueId: "cue_slack:proposed",
        nativeId: "commerce:event_2:payment_failed:1",
        reason: "slack:1700000000.000001",
        surfaceKind: "slack",
        surfaceThreadId: "1700000000.000001",
        at: 2,
      }),
    ).toEqual({
      cueId: "cue_slack:proposed",
      nativeId: "commerce:event_2:payment_failed:1",
      target: { kind: "slack", slackTs: "1700000000.000001" },
      at: 2,
    });
  });
});

function testEnv(organisationId = "organisation_lab"): UnitTestEnv {
  return platformEnv({
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    ORGANISATION_ADMIN_TOKEN: ADMIN_TOKEN,
    COMMERCE_LAB_SIGNING_SECRET: SIGNING_SECRET,
    POLICY_KV: {
      get: vi.fn().mockResolvedValue(commerceCueSnapshot(organisationId)),
    },
  });
}

function commerceScenarioRequest(
  organisationId: string,
  scenarioId: string,
  labNamespace: string,
  idempotencyKey: string,
): Request {
  return new Request(
    `https://pantry.test/v1/admin/commerce-lab/${organisationId}/scenarios/${scenarioId}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ labNamespace, idempotencyKey }),
    },
  );
}

function commerceCueSnapshot(organisationId: string) {
  return {
    organisationId,
    version: 1,
    createdAt: 1_000,
    subscriptions: [
      {
        subscriptionId: "onboarding-commerce-payment-failed",
        organisationId,
        version: 1,
        surfaceScope: {
          kind: "slack",
          workspaceId: "T0BGQSSG45N",
          channelId: "C0TESTCOMMERCE",
          threadKey: "slack:T0BGQSSG45N:C0TESTCOMMERCE:channel",
        },
        source: "commerce",
        eventType: "payment_failed",
        action: {
          kind: "propose",
          template: "Review the failed payment.",
          delivery: { kind: "immediate" },
        },
        tier: 1,
        debounceMs: 300_000,
        maxPerHour: 4,
        enabled: true,
      },
    ],
  };
}

// The router test supplies the lab normalizer's answers, so it checks the
// router's own fences and queueing.
function labNormalizerMockFactory() {
  return {
    normalizeLabEvent: normalizeLabEventMock,
    deriveLabEventCueFacts: deriveLabEventCueFactsMock,
  };
}

function createLabState(): {
  normalizeValue: unknown;
  cueValue: unknown;
} {
  return {
    normalizeValue: null,
    cueValue: [],
  };
}

function normalizeLabEventMock(): unknown {
  return { status: "ok", value: labState.normalizeValue };
}

function deriveLabEventCueFactsMock(): unknown {
  return { status: "ok", value: labState.cueValue };
}

async function insertDevelopmentOrganisation(
  db: SingleDatabase,
  organisationId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, 'Commerce lab', 'beta', 1, 'active')`,
    )
    .bind(organisationId)
    .run();
  await db
    .prepare(
      `INSERT INTO organisation_onboarding (
         organisation_id, environment, lifecycle, capability_profile,
         configuration_version, projection_revision, updated_at
       ) VALUES (?, 'development', 'configuring', 'read_and_propose', 1, 1, 1)`,
    )
    .bind(organisationId)
    .run();
}

function readScenarioRun(raw: unknown): {
  readonly runId: string;
  readonly scenarioId: string;
  readonly events: readonly Record<string, unknown>[];
} {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("run" in raw) ||
    typeof raw.run !== "object" ||
    raw.run === null ||
    !("runId" in raw.run) ||
    typeof raw.run.runId !== "string" ||
    !("scenarioId" in raw.run) ||
    typeof raw.run.scenarioId !== "string" ||
    !("events" in raw.run) ||
    !Array.isArray(raw.run.events)
  ) {
    throw new Error("scenario response is invalid");
  }
  return {
    runId: raw.run.runId,
    scenarioId: raw.run.scenarioId,
    events: raw.run.events,
  };
}

function canonicalPaymentFailure(
  organisationId: string,
  integrationAccountId: string,
  observedAt: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const payload = readPaymentFailurePayload(event);
  const eventId = readText(event, "eventId");
  const occurredAt = readText(event, "occurredAt");
  const revision = readPositiveInteger(event, "revision");
  return {
    schemaVersion: 1,
    providerDeliveryId: eventId,
    observations: [
      {
        kind: "upsert",
        observationId: `${eventId}:payment:${payload.paymentId}:${revision}`,
        projection: {
          kind: "payment",
          projection: {
            provenance: {
              organisationId,
              integrationAccountId,
              source: "lab",
              resourceType: "payment",
              resourceId: payload.paymentId,
              revision,
              occurredAt,
              observedAt,
            },
            orderId: payload.orderId,
            amount: {
              amountMinor: payload.amountMinor,
              currency: payload.currency,
            },
            lifecycle: {
              state: "failed",
              failedAt: occurredAt,
              reason: payload.reason,
            },
          },
        },
      },
    ],
  };
}

function paymentFailureCueFacts(
  event: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const payload = readPaymentFailurePayload(event);
  return [
    {
      kind: "payment_failed",
      orderId: payload.orderId,
      paymentId: payload.paymentId,
      amountMinor: payload.amountMinor,
      currency: payload.currency,
      reason: payload.reason,
    },
  ];
}

function readPaymentFailurePayload(event: Record<string, unknown>): {
  readonly orderId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string;
} {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new Error("payment failure payload is invalid");
  }
  return {
    orderId: readText(payload, "orderId"),
    paymentId: readText(payload, "resourceId"),
    amountMinor: readInteger(payload, "amountMinor"),
    currency: readText(payload, "currency"),
    reason: readText(payload, "reason"),
  };
}

function readText(value: object, field: string): string {
  const raw = Reflect.get(value, field);
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${field} is invalid`);
  }
  return raw;
}

function readInteger(value: object, field: string): number {
  const raw = Reflect.get(value, field);
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    throw new Error(`${field} is invalid`);
  }
  return raw;
}

function readPositiveInteger(value: object, field: string): number {
  const raw = readInteger(value, field);
  if (raw <= 0) {
    throw new Error(`${field} is invalid`);
  }
  return raw;
}

async function signLabRequest(
  timestamp: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v1:${timestamp}:${body}`),
  );
  return `v1=${bytesToHex(new Uint8Array(signature))}`;
}
