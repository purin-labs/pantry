import { createOrganisationExecutionFixture } from "../organisation-execution-fixture";
import { createMigratedDatabase } from "../sqlite-d1";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "../fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../src/commerce/commerce-wasm", commerceWasmMock);
vi.mock("../../src/commerce-lab/lab-metadata", labMetadataMock);
vi.mock("@purin-labs/actor-runtime/actors/actor-router", actorRouterMock);

const queueMocks = vi.hoisted(function createQueueMocks() {
  const organisation = {
    readCurrentCommerceProjection: vi.fn(),
    applyCommerceDelivery: vi.fn(),
    markCommerceCuesEnqueued: vi.fn(),
  };
  return {
    organisation,
    requireActiveOrganisationActor: vi.fn().mockResolvedValue(organisation),
  };
});

const labMetadataMocks = vi.hoisted(function createLabMetadataMocks() {
  return {
    failCommerceLabRun: vi.fn(),
    listCommerceLabRuns: vi.fn(),
  };
});

import { cueLogIntegrationAccountId } from "../../src/gateway/cue-delivery";
import { handleCommerceDeliveryQueueMessage } from "../../src/gateway/support";
import { COMMERCE_LAB_INTEGRATION_ACCOUNT_ID } from "../../src/commerce-lab/lab-metadata";
import type { NormalizedCueEvent } from "@purin-labs/agent/cues/engine";
import { createCommerceDeliveryQueueMessage } from "../../src/commerce/contract/queue-messages";
import {
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { platformEnv } from "../worker-fakes";

const ORGANISATION_ID = requiredOrganisationId();
const INTEGRATION_ACCOUNT_ID = requiredIntegrationAccountId();
const CUE_NATIVE_ID = "commerce:event_payment_failed:payment_failed:1";

describe("commerce queue projection recovery", function queueProjectionRecoverySuite() {
  beforeEach(function resetQueueProjectionRecovery() {
    vi.clearAllMocks();
    labMetadataMocks.listCommerceLabRuns.mockResolvedValue({
      ok: true,
      value: [
        {
          runId: "commerce_lab_run_queue_recovery",
          result: "running",
        },
      ],
    });
    queueMocks.organisation.readCurrentCommerceProjection.mockResolvedValue({
      ok: true,
      value: null,
    });
    queueMocks.organisation.applyCommerceDelivery
      .mockResolvedValueOnce(appliedDelivery("accepted"))
      .mockResolvedValueOnce(appliedDelivery("duplicate"));
    queueMocks.organisation.markCommerceCuesEnqueued
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "commerce_projection_corrupt" },
      })
      .mockResolvedValueOnce({ ok: true, value: null });
  });

  it("replays after cue-mark interruption with one projection effect identity", async function queueProjectionReplay() {
    const body = commerceQueueBody();
    const first = queueMessage(body);
    const replay = queueMessage(body);
    const cueSend = vi.fn().mockResolvedValue(undefined);
    const db = createMigratedDatabase();
    await createOrganisationExecutionFixture(db, ORGANISATION_ID);
    const env = platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      CUE_Q: { send: cueSend },
    });

    await handleCommerceDeliveryQueueMessage(first.message, env, body);
    await handleCommerceDeliveryQueueMessage(replay.message, env, body);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(replay.retry).not.toHaveBeenCalled();
    expect(cueSend).toHaveBeenCalledTimes(2);
    expect(cueSend.mock.calls[0]?.[0]).toEqual(cueSend.mock.calls[1]?.[0]);
    expect(cueSend.mock.calls[0]?.[0].event.nativeId).toBe(CUE_NATIVE_ID);
  });

  it("acks a queued lab event after its run was reset", async function staleLabQueueEvent() {
    labMetadataMocks.listCommerceLabRuns.mockResolvedValue({
      ok: true,
      value: [],
    });
    const body = commerceQueueBody();
    const queued = queueMessage(body);
    const cueSend = vi.fn().mockResolvedValue(undefined);
    const db = createMigratedDatabase();
    await createOrganisationExecutionFixture(db, ORGANISATION_ID);
    const env = platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      CUE_Q: { send: cueSend },
    });

    await handleCommerceDeliveryQueueMessage(queued.message, env, body);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(queueMocks.requireActiveOrganisationActor).not.toHaveBeenCalled();
    expect(cueSend).not.toHaveBeenCalled();
  });

  it("keeps provider-neutral commerce cues outside provider-account references", function commerceAuditReference() {
    expect(
      cueLogIntegrationAccountId({
        ...pendingCue().event,
        integrationAccountId: COMMERCE_LAB_INTEGRATION_ACCOUNT_ID,
      }),
    ).toBeNull();
    expect(cueLogIntegrationAccountId(pendingCue().event)).toBeNull();
  });
});

function commerceQueueBody() {
  return createCommerceDeliveryQueueMessage({
    requestId: requiredRequestId(),
    receivedAt: 1_000,
    organisationId: ORGANISATION_ID,
    integrationAccountId: INTEGRATION_ACCOUNT_ID,
    labRunId: "commerce_lab_run_queue_recovery",
    canonicalDeliveryJson: JSON.stringify(paymentFailedEvent()),
    canonicalCueFactsJson: JSON.stringify([paymentFailedFact()]),
  });
}

function paymentFailedEvent() {
  return {
    schemaVersion: 1,
    providerDeliveryId: "event_payment_failed",
    observations: [
      {
        kind: "upsert",
        observationId: "event_payment_failed:payment:payment_queue_recovery:1",
        projection: {
          kind: "payment",
          projection: {
            provenance: {
              organisationId: ORGANISATION_ID,
              integrationAccountId: INTEGRATION_ACCOUNT_ID,
              source: "lab",
              resourceType: "payment",
              resourceId: "payment_queue_recovery",
              revision: 1,
              occurredAt: "2026-07-26T00:00:00.000Z",
              observedAt: "2026-07-26T00:00:00.000Z",
            },
            orderId: "order_queue_recovery",
            amount: { amountMinor: 42_500, currency: "USD" },
            lifecycle: {
              state: "failed",
              failedAt: "2026-07-26T00:00:00.000Z",
              reason: "card_declined",
            },
          },
        },
      },
    ],
  };
}

function paymentFailedFact() {
  return {
    kind: "payment_failed",
    orderId: "order_queue_recovery",
    paymentId: "payment_queue_recovery",
    amountMinor: 42_500,
    currency: "USD",
    reason: "card_declined",
  };
}

function pendingCue() {
  const event: NormalizedCueEvent = {
    organisationId: ORGANISATION_ID,
    integrationAccountId: INTEGRATION_ACCOUNT_ID,
    source: "commerce",
    nativeId: CUE_NATIVE_ID,
    eventType: "payment_failed",
    payload: {
      orderId: "order_queue_recovery",
      paymentId: "payment_queue_recovery",
      amountMinor: 42_500,
      currency: "USD",
      reason: "card_declined",
    },
    at: 1_000,
  };
  return {
    organisationId: ORGANISATION_ID,
    nativeId: CUE_NATIVE_ID,
    eventId: "event_payment_failed",
    integrationAccountId: INTEGRATION_ACCOUNT_ID,
    event,
    state: "pending",
    createdAt: 1_000,
    enqueuedAt: null,
    labRunId: "commerce_lab_run_queue_recovery",
  };
}

function appliedDelivery(disposition: "accepted" | "duplicate") {
  return {
    ok: true,
    value: {
      disposition,
      providerDeliveryId: "event_payment_failed",
      observations: [
        {
          disposition: "applied",
          observationId:
            "event_payment_failed:payment:payment_queue_recovery:1",
          projectionKind: "payment",
          canonicalId: "payment_queue_recovery",
          revision: 1,
        },
      ],
      pendingCues: [pendingCue()],
    },
  };
}

function queueMessage(body: ReturnType<typeof commerceQueueBody>) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    message: {
      id: "queue_message_recovery",
      timestamp: new Date(1_000),
      body,
      attempts: 1,
      ack,
      retry,
    } as unknown as Message<unknown>,
  };
}

function requiredRequestId() {
  const parsed = parseRequestId("req_01HZXCOMMERCEQUEUE000000000");
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

function requiredOrganisationId() {
  const parsed = parseOrganisationId("organisation_commerce_queue_recovery");
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

function requiredIntegrationAccountId() {
  const parsed = parseIntegrationAccountId(
    "integration_account_commerce_queue_recovery",
  );
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

function actorRouterMock() {
  return {
    requireActiveOrganisationActorAtPlacement:
      queueMocks.requireActiveOrganisationActor,
    requireActiveSessionActor: vi.fn(),
  };
}

function commerceWasmMock() {
  return {};
}

function labMetadataMock() {
  return {
    ...labMetadataMocks,
    COMMERCE_LAB_INTEGRATION_ACCOUNT_ID: "integration_account_commerce_lab",
  };
}
