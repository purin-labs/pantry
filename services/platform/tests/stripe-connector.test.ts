/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import {
  parseStripeConnectAccountId,
  parseStripeCueEvent,
  registerStripeWebhook,
  verifyStripeWebhookSignature,
} from "../src/stripe/connector";

type CapturedStripeRequest = {
  url: string;
  method: string;
  body: string;
};

let capturedStripeRequests: CapturedStripeRequest[] = [];
let capturedStripeFetcherReceiver: unknown = null;
let existingStripeWebhookEndpoint = true;

const expectedStripeWebhookEvents = [
  "charge.failed",
  "invoice.payment_failed",
  "refund.failed",
  "customer.subscription.deleted",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.succeeded",
];

describe("Stripe failed-charge webhook", function stripeWebhookSuite() {
  it("verifies the organisation secret and normalizes charge.failed", async function verifiesEvent() {
    const organisationId = requireOrganisationId();
    const integrationAccountId = requireIntegrationAccountId();
    const rawBody = JSON.stringify({
      id: "evt_failed_1",
      type: "charge.failed",
      created: 1_000,
      data: {
        object: {
          id: "ch_failed_1",
          amount: 1_000,
          currency: "usd",
          failure_code: "card_declined",
          failure_message: "The card was declined.",
        },
      },
    });
    const signingSecret = "whsec_fixture";
    const signature = await stripeSignature(signingSecret, 1_000, rawBody);
    const verified = await verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: `t=1000,v1=${signature}`,
      signingSecret,
      nowMs: 1_000_000,
    });
    const event = parseStripeCueEvent(
      rawBody,
      organisationId,
      integrationAccountId,
    );

    expect(verified).toEqual({ ok: true, value: null });
    expect(event).toEqual({
      ok: true,
      value: {
        organisationId,
        integrationAccountId,
        source: "stripe",
        nativeId: "evt_failed_1",
        eventType: "charge.failed",
        payload: {
          chargeId: "ch_failed_1",
          amountMinor: 1_000,
          currency: "usd",
          failureCode: "card_declined",
          failureMessage: "The card was declined.",
        },
        at: 1_000_000,
      },
    });
  });

  it("normalizes invoice, refund, and subscription failures", function normalizesEventBreadth() {
    const organisationId = requireOrganisationId();
    const integrationAccountId = requireIntegrationAccountId();
    const invoice = parseStripeCueEvent(
      JSON.stringify({
        id: "evt_invoice_failed_1",
        type: "invoice.payment_failed",
        created: 2_000,
        data: {
          object: {
            id: "in_failed_1",
            customer: "cus_1",
            subscription: "sub_1",
            amount_due: 2_500,
            currency: "usd",
            attempt_count: 2,
            next_payment_attempt: 2_100,
          },
        },
      }),
      organisationId,
      integrationAccountId,
    );
    const refund = parseStripeCueEvent(
      JSON.stringify({
        id: "evt_refund_failed_1",
        type: "refund.failed",
        created: 3_000,
        data: {
          object: {
            id: "re_failed_1",
            charge: "ch_1",
            payment_intent: "pi_1",
            amount: 1_500,
            currency: "usd",
            failure_reason: "lost_or_stolen_card",
          },
        },
      }),
      organisationId,
      integrationAccountId,
    );
    const subscription = parseStripeCueEvent(
      JSON.stringify({
        id: "evt_subscription_deleted_1",
        type: "customer.subscription.deleted",
        created: 4_000,
        data: {
          object: {
            id: "sub_1",
            customer: "cus_1",
            status: "canceled",
            cancel_at_period_end: false,
            canceled_at: 3_900,
            ended_at: 4_000,
          },
        },
      }),
      organisationId,
      integrationAccountId,
    );

    expect(invoice).toMatchObject({
      ok: true,
      value: {
        eventType: "invoice.payment_failed",
        payload: { nextPaymentAttemptAt: 2_100_000 },
      },
    });
    expect(refund).toMatchObject({
      ok: true,
      value: {
        eventType: "refund.failed",
        payload: {
          refundId: "re_failed_1",
          failureReason: "lost_or_stolen_card",
        },
      },
    });
    expect(subscription).toMatchObject({
      ok: true,
      value: {
        eventType: "customer.subscription.deleted",
        payload: { subscriptionId: "sub_1", endedAt: 4_000_000 },
      },
    });
  });

  it("reads the connected account from a Connect event envelope", function parsesConnectAccount() {
    expect(
      parseStripeConnectAccountId(
        JSON.stringify({ account: "acct_123connected" }),
      ),
    ).toEqual({
      ok: true,
      value: "acct_123connected",
    });
    expect(
      parseStripeConnectAccountId(
        JSON.stringify({ account: "organisation_1" }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "stripe_connect_account_missing" },
    });
  });

  it("updates an existing webhook endpoint with the complete event set", async function updatesWebhook() {
    resetStripeWebhookCapture(true);
    const registration = await registerStripeWebhook({
      stripeTestKey: "sk_test_fixture",
      endpointUrl: "https://example.test/hook/stripe/organisation_1",
      idempotencyKey: "connector-1",
      existingSigningSecret: true,
      fetcher: stripeWebhookFetcher,
    });
    const update = capturedStripeRequests[1];

    expect(registration).toEqual({
      ok: true,
      value: { kind: "updated", endpointId: "we_existing", status: "enabled" },
    });
    expect(update?.method).toBe("POST");
    expect(update?.body).toBeDefined();
    expect(readEnabledStripeWebhookEvents(update?.body)).toEqual(
      expectedStripeWebhookEvents,
    );
    expect(update?.body).toContain("disabled=false");
    expect(capturedStripeFetcherReceiver).toBeUndefined();
  });

  it("creates a new webhook endpoint with the complete event set", async function createsWebhook() {
    resetStripeWebhookCapture(false);
    const registration = await registerStripeWebhook({
      stripeTestKey: "sk_test_fixture",
      endpointUrl: "https://example.test/hook/stripe/organisation_1",
      idempotencyKey: "connector-1",
      existingSigningSecret: false,
      fetcher: stripeWebhookFetcher,
    });
    const create = capturedStripeRequests[1];

    expect(registration).toEqual({
      ok: true,
      value: {
        kind: "created",
        endpointId: "we_created",
        signingSecret: "whsec_created",
        status: "enabled",
      },
    });
    expect(create?.method).toBe("POST");
    expect(readEnabledStripeWebhookEvents(create?.body)).toEqual(
      expectedStripeWebhookEvents,
    );
    expect(create?.body).not.toContain("disabled=false");
    expect(capturedStripeFetcherReceiver).toBeUndefined();
  });
});

function resetStripeWebhookCapture(existingEndpoint: boolean): void {
  capturedStripeRequests = [];
  capturedStripeFetcherReceiver = null;
  existingStripeWebhookEndpoint = existingEndpoint;
}

function readEnabledStripeWebhookEvents(body: string | undefined): string[] {
  if (body === undefined) return [];
  return new URLSearchParams(body).getAll("enabled_events[]");
}

async function stripeWebhookFetcher(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  capturedStripeFetcherReceiver = this;
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? "GET";
  const body =
    init?.body instanceof URLSearchParams ? init.body.toString() : "";
  capturedStripeRequests.push({ url, method, body });

  if (method === "GET") {
    return Response.json({
      object: "list",
      data: existingStripeWebhookEndpoint
        ? [
            {
              id: "we_existing",
              url: "https://example.test/hook/stripe/organisation_1",
            },
          ]
        : [],
    });
  }

  return existingStripeWebhookEndpoint
    ? Response.json({ id: "we_existing", status: "enabled" })
    : Response.json({
        id: "we_created",
        secret: "whsec_created",
        status: "enabled",
      });
}

async function stripeSignature(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return Array.from(new Uint8Array(signed), hexByte).join("");
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function requireOrganisationId() {
  const parsed = parseOrganisationId("organisation_stripe_webhook");

  if (!parsed.ok) {
    throw new Error("invalid organisation fixture");
  }

  return parsed.value;
}

function requireIntegrationAccountId() {
  const parsed = parseIntegrationAccountId("integration_stripe_webhook");

  if (!parsed.ok) {
    throw new Error("invalid Stripe integration account fixture");
  }

  return parsed.value;
}
