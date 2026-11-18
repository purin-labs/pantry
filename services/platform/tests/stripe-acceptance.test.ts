/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import { triggerStripeFailedCharge } from "../src/stripe/acceptance";

let capturedFetcherReceiver: unknown = null;

describe("Stripe M8 acceptance trigger", function stripeAcceptanceSuite() {
  it("requires the fixed declined test token and expected Stripe response", async function triggersFailure() {
    capturedFetcherReceiver = null;
    const result = await triggerStripeFailedCharge({
      credential: { kind: "bearer", value: "sk_test_fixture_secret_123456" },
      fetcher: declinedChargeFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "charge_failed_triggered",
        provider: "stripe",
        errorCode: "card_declined",
        declineCode: "generic_decline",
        chargeId: "ch_failed_m8",
        requestId: "req_m8",
      },
    });
    expect(capturedFetcherReceiver).toBeUndefined();
  });

  it("rejects a live key before provider I/O", async function rejectsLiveKey() {
    const result = await triggerStripeFailedCharge({
      credential: { kind: "bearer", value: "sk_live_fixture_secret_123456" },
      fetcher: unexpectedFetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "stripe_test_credential_invalid" },
    });
  });
});

async function declinedChargeFetch(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  capturedFetcherReceiver = this;
  expect(String(input)).toBe("https://api.stripe.com/v1/payment_intents");
  expect(String(init?.body)).toContain(
    "payment_method=pm_card_visa_chargeDeclined",
  );
  expect(String(init?.body)).toContain("confirm=true");
  return Response.json(
    {
      error: {
        code: "card_declined",
        decline_code: "generic_decline",
        charge: "ch_failed_m8",
        message: "Your card was declined.",
      },
    },
    { status: 402, headers: { "request-id": "req_m8" } },
  );
}

async function unexpectedFetch(): Promise<Response> {
  throw new Error("live key reached Stripe");
}
