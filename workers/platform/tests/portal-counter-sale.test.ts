import { describe, expect, it } from "vitest";

import {
  collectCounterSale,
  counterSaleGuidance,
  handOverCounterSale,
  markCounterSalePickupReady,
  readCounterSale,
  refundCounterSale,
  type CounterSaleMutationTransport,
  type CounterSaleReadTransport,
} from "@purin-labs/area-cafe/ui/features/terminals/counter-sale-api";
import type { CounterSale } from "@purin-labs/control-api/portal/counter-sale";

const ORGANISATION = "organisation_1";
const CHECKOUT = "checkout_counter_1";
const DIGEST = `quote_${"ab".repeat(32)}`;
const PATH = `/v1/control/organisations/${ORGANISATION}/commerce/counter-sales/${CHECKOUT}`;

function sale(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    counterSale: {
      schemaVersion: "pantry.counter-sale.v1",
      checkoutId: CHECKOUT,
      pantryLocationId: "location_cafe",
      revision: 2,
      state: "awaiting_collection",
      collectable: true,
      recoverable: null,
      quote: {
        quoteDigest: DIGEST,
        checkoutRevision: 2,
        lineCount: 1,
        amount: { amountMinor: 1320, currency: "JPY" },
      },
      orderId: null,
      capturedPaymentReference: null,
      afterSale: null,
      ...overrides,
    },
  };
}

describe("Portal counter-sale boundary", function counterSaleBoundarySuite() {
  it("parses a sale the till may collect", async function collectable() {
    const read: CounterSaleReadTransport = async (path) => {
      expect(path).toBe(PATH);
      return sale();
    };
    const parsed = await readCounterSale(ORGANISATION, CHECKOUT, read);
    expect(parsed.state).toBe("awaiting_collection");
    expect(parsed.collectable).toBe(true);
    expect(parsed.quote?.quoteDigest).toBe(DIGEST);
  });

  it("carries the recovery reference for an unknown submission", async function unknown() {
    const parsed = await readCounterSale(ORGANISATION, CHECKOUT, async () =>
      sale({
        state: "submission_unknown",
        collectable: false,
        recoverable: {
          paymentAttemptId: "payment_attempt_1",
          reasonCode: "provider_timeout",
          reconcileAfter: "2026-09-05T00:00:00.000Z",
        },
      }),
    );
    expect(parsed.collectable).toBe(false);
    expect(parsed.recoverable?.paymentAttemptId).toBe("payment_attempt_1");
    expect(counterSaleGuidance(parsed)).toMatch(/does not yet know/u);
  });

  it("never re-derives collectability from the state name", async function trusted() {
    // A payload claiming a collectable captured sale is nonsense, but the
    // portal reports what the platform said rather than second-guessing it in
    // a second place. One authority, not two that can disagree.
    const parsed = await readCounterSale(ORGANISATION, CHECKOUT, async () =>
      sale({
        state: "captured_unplaced",
        collectable: false,
        capturedPaymentReference: "square_payment_1",
      }),
    );
    expect(parsed.collectable).toBe(false);
    expect(counterSaleGuidance(parsed)).toMatch(/do not take payment again/u);
  });

  it("refuses a readback in a version it cannot read", async function versioned() {
    await expect(
      readCounterSale(ORGANISATION, CHECKOUT, async () =>
        sale({ schemaVersion: "pantry.counter-sale.v2" }),
      ),
    ).rejects.toThrow(/version/u);
  });

  it("refuses a state it does not recognise", async function unknownState() {
    await expect(
      readCounterSale(ORGANISATION, CHECKOUT, async () =>
        sale({ state: "refunded" }),
      ),
    ).rejects.toThrow(/invalid/u);
  });

  it("refuses a sale carrying a field it does not model", async function exactKeys() {
    await expect(
      readCounterSale(ORGANISATION, CHECKOUT, async () =>
        sale({ buyerEmail: "someone@example.test" }),
      ),
    ).rejects.toThrow(/fields are invalid/u);
  });

  it("binds a collection to the exact quote it was rung up at", async function bound() {
    const parsed = await readCounterSale(ORGANISATION, CHECKOUT, async () =>
      sale(),
    );
    const mutate: CounterSaleMutationTransport = async (
      path,
      method,
      body,
      intent,
    ) => {
      expect(path).toBe(`${PATH}/collection`);
      expect(method).toBe("POST");
      expect(body).toEqual({
        pantryLocationId: "location_cafe",
        checkoutRevision: 2,
        quoteDigest: DIGEST,
        amount: { amountMinor: 1320, currency: "JPY" },
      });
      // A re-presented sale whose quote moved is a different attempt.
      expect(intent).toBe(`counter-collect:${CHECKOUT}:${DIGEST}`);
      return {
        ok: true,
        collection: {
          outcome: "ready",
          paymentAttemptId: "payment_attempt_1",
          session: null,
        },
      };
    };
    await collectCounterSale(
      ORGANISATION,
      parsed,
      { amountMinor: 1320, currency: "JPY" },
      mutate,
    );
  });

  it("routes pickup, handover, and refund through distinct stable intents", async function afterSale() {
    const calls: Array<Readonly<{ path: string; intent: string }>> = [];
    const mutate: CounterSaleMutationTransport = async (
      path,
      _method,
      _body,
      intent,
    ) => {
      calls.push({ path, intent });
      return sale({
        state: "complete",
        collectable: false,
        orderId: "order_counter_1",
        capturedPaymentReference: "square_payment_1",
        afterSale: {
          order: {
            id: "order_counter_1",
            revision: 1,
            state: "fulfillment_pending",
          },
          payment: { id: "payment_counter_1", revision: 1, state: "captured" },
          fulfillment: {
            id: "fulfillment_counter_1",
            revision: 1,
            state: "requested",
          },
          refundState: "none",
        },
      });
    };

    await markCounterSalePickupReady(ORGANISATION, CHECKOUT, mutate);
    await handOverCounterSale(ORGANISATION, CHECKOUT, mutate);
    await refundCounterSale(ORGANISATION, CHECKOUT, mutate);

    expect(calls).toEqual([
      { path: `${PATH}/ready`, intent: `counter-ready:${CHECKOUT}` },
      { path: `${PATH}/handover`, intent: `counter-handover:${CHECKOUT}` },
      { path: `${PATH}/refund`, intent: `counter-refund:${CHECKOUT}` },
    ]);
  });

  it("parses a pending refund as an explicit recoverable after-sale state", async function pendingRefund() {
    const parsed = await readCounterSale(ORGANISATION, CHECKOUT, async () =>
      sale({
        state: "complete",
        collectable: false,
        orderId: "order_counter_1",
        capturedPaymentReference: "square_payment_1",
        afterSale: {
          order: { id: "order_counter_1", revision: 2, state: "fulfilled" },
          payment: { id: "payment_counter_1", revision: 1, state: "captured" },
          fulfillment: {
            id: "fulfillment_counter_1",
            revision: 3,
            state: "completed",
          },
          refundState: "pending",
        },
      }),
    );

    expect(parsed.afterSale).toMatchObject({
      payment: { state: "captured" },
      fulfillment: { state: "completed" },
      refundState: "pending",
    });
  });

  it("will not collect a sale that has no quote", async function noQuote() {
    const parsed = await readCounterSale(ORGANISATION, CHECKOUT, async () =>
      sale({
        state: "expired",
        collectable: false,
        quote: null,
      }),
    );
    const mutate: CounterSaleMutationTransport = async () => {
      throw new Error("must not be called");
    };
    await expect(
      collectCounterSale(
        ORGANISATION,
        parsed as CounterSale,
        { amountMinor: 1, currency: "JPY" },
        mutate,
      ),
    ).rejects.toThrow(/no quote/u);
  });
});
