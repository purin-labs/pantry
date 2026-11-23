import { describe, expect, it } from "vitest";

import { createCommerceDeliveryQueueMessage } from "@purin-labs/area-commerce/server/contract/queue-messages";
import { parseIngressQueueMessage } from "../src/ingress-queue";
import { slackConversationAuthorityKind } from "@purin-labs/surface-slack/server/case-command-message";
import {
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";

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
