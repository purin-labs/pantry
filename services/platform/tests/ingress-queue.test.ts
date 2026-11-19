import { describe, expect, it } from "vitest";

import {
  createCommerceDeliveryQueueMessage,
  createShopifyCommerceRefreshQueueMessage,
  createCommerceOutboxReconcileQueueMessage,
  parseIngressQueueMessage,
  slackConversationAuthorityKind,
} from "../src/ingress-queue";
import {
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
} from "../src/ids";
import { createContextProjectionCommand } from "../src/context/projection";
import { createFileProjectionCommand } from "../src/context/files";

describe("ingress queue boundary", function ingressQueueSuite() {
  it("classifies only canonical Slack direct and shared channel prefixes", function classifiesSlackChannels() {
    expect(slackConversationAuthorityKind("D0DIRECT")).toBe(
      "direct_conversation",
    );
    expect(slackConversationAuthorityKind("C0CHANNEL")).toBe(
      "shared_conversation",
    );
    expect(slackConversationAuthorityKind("G0GROUP")).toBe(
      "shared_conversation",
    );
    expect(slackConversationAuthorityKind("X0UNKNOWN")).toBeNull();
  });

  it("round-trips normalized commerce events without provider payloads", function roundTripsCommerceEvent() {
    const message = createCommerceDeliveryQueueMessage({
      requestId: requiredRequestId(),
      receivedAt: 100,
      organisationId: requiredOrganisationId(),
      integrationAccountId: requiredIntegrationAccountId(),
      labRunId: "lab_run_queue_fixture",
      canonicalDeliveryJson: JSON.stringify({
        schemaVersion: 1,
        eventId: "commerce_event_queue_fixture",
        projection: { kind: "commerce_order", projection: {} },
      }),
      canonicalCueFactsJson: "[]",
    });

    expect(parseIngressQueueMessage(message)).toEqual({
      ok: true,
      value: message,
    });
  });

  it("round-trips a bounded Shopify order refresh command", function roundTripsShopifyRefresh() {
    const message = createShopifyCommerceRefreshQueueMessage({
      requestId: requiredRequestId(),
      receivedAt: 100,
      organisationId: requiredOrganisationId(),
      integrationAccountId: requiredIntegrationAccountId(),
      shopDomain: "pantry-test.myshopify.com",
      webhookId: "webhook_order_42",
      target: { kind: "order", orderGid: "gid://shopify/Order/42" },
    });
    expect(parseIngressQueueMessage(message)).toEqual({
      ok: true,
      value: message,
    });
    expect(
      parseIngressQueueMessage({
        ...message,
        target: { kind: "order", orderGid: "42" },
      }),
    ).toEqual({ ok: false, error: { code: "invalid_field", field: "target" } });
  });

  it("round-trips one exact Underclerk outbox acknowledgement command", function roundTripsCommerceOutbox() {
    const message = createCommerceOutboxReconcileQueueMessage({
      requestId: requiredRequestId(),
      receivedAt: 100,
      organisationId: requiredOrganisationId(),
      integrationAccountId: requiredIntegrationAccountId(),
    });
    expect(parseIngressQueueMessage(message)).toEqual({
      ok: true,
      value: message,
    });
  });

  it("round-trips one exact Case context projection command", function roundTripsContextProjection() {
    const message = createContextProjectionCommand({
      organisationId: requiredOrganisationId(),
      source: {
        kind: "case_entry",
        caseId: "case_queue_fixture",
        entryId: "trigger:fixture",
      },
      sourceRevision: 1,
    });

    expect(parseIngressQueueMessage(message)).toEqual({
      ok: true,
      value: message,
    });
    expect(
      parseIngressQueueMessage({
        ...message,
        source: { ...message.source, caseId: " " },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_field", field: "source.caseId" },
    });
  });

  it("round-trips one exact file projection command", function roundTripsFileProjection() {
    const message = createFileProjectionCommand({
      organisationId: requiredOrganisationId(),
      grantId: "grant_queue_file",
      grantRevision: 1,
      integrationAccountId: requiredIntegrationAccountId(),
      provider: "dropbox",
      providerFileId: "id:file",
      sourceSequence: 1,
      providerRevision: { kind: "dropbox", rev: "015" },
      visibilityKey: "person:person_queue",
    });

    expect(parseIngressQueueMessage(message)).toEqual({
      ok: true,
      value: message,
    });
    expect(
      parseIngressQueueMessage({
        ...message,
        providerRevision: {
          kind: "gdrive",
          version: "1",
          modifiedTime: "2026-08-29T00:00:00Z",
          headRevisionId: null,
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_field", field: "providerRevision" },
    });
  });

  it("rejects non-object commerce event JSON", function rejectsInvalidCommerceEventJson() {
    const message = createCommerceDeliveryQueueMessage({
      requestId: requiredRequestId(),
      receivedAt: 100,
      organisationId: requiredOrganisationId(),
      integrationAccountId: requiredIntegrationAccountId(),
      labRunId: null,
      canonicalDeliveryJson: "[]",
      canonicalCueFactsJson: "[]",
    });

    expect(parseIngressQueueMessage(message)).toEqual({
      ok: false,
      error: { code: "invalid_field", field: "canonicalDeliveryJson" },
    });
  });

  it("rejects non-array canonical cue facts", function rejectsInvalidCueFactsJson() {
    const message = createCommerceDeliveryQueueMessage({
      requestId: requiredRequestId(),
      receivedAt: 100,
      organisationId: requiredOrganisationId(),
      integrationAccountId: requiredIntegrationAccountId(),
      labRunId: null,
      canonicalDeliveryJson: JSON.stringify({
        schemaVersion: 1,
        eventId: "commerce_event_queue_fixture",
        projection: { kind: "commerce_order", projection: {} },
      }),
      canonicalCueFactsJson: "{}",
    });

    expect(parseIngressQueueMessage(message)).toEqual({
      ok: false,
      error: { code: "invalid_field", field: "canonicalCueFactsJson" },
    });
  });
});

function requiredRequestId() {
  const parsed = parseRequestId("req_01HZXQUEUE0000000000000000");
  if (!parsed.ok) throw new Error("request fixture invalid");
  return parsed.value;
}

function requiredOrganisationId() {
  const parsed = parseOrganisationId("organisation_queue_fixture");
  if (!parsed.ok) throw new Error("organisation fixture invalid");
  return parsed.value;
}

function requiredIntegrationAccountId() {
  const parsed = parseIntegrationAccountId("integration_account_queue_fixture");
  if (!parsed.ok) throw new Error("integration account fixture invalid");
  return parsed.value;
}
