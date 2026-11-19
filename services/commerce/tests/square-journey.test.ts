// Plan 77 step 8, on the real Square sandbox with Platform stopped: a partner
// connects the café's Square account with its token (Plan 80 step 4), a
// token that Square does not know is refused, and the café's location takes
// payments. A buyer in the Australian market pays for tea from a card token;
// the answer to Commerce's first payment request is lost, and the buyer's
// retry places the order from the payment Square already made, so Square
// holds one payment. Staff refund part of the order on Square. A declined
// card places nothing. At the counter, a barista rings up an AUD tin and the
// location's Square Terminal takes the card (Square's sandbox test device);
// the counter sale places its order, and staff refund part of it.
//
// It calls Square's sandbox, so it runs only with
//   UNDERCLERK_SQUARE_SANDBOX_TOKEN           a sandbox access token
//   UNDERCLERK_SQUARE_SANDBOX_APPLICATION_ID  the token's sandbox application
// The buyer's browser would tokenize the card with Square's Web Payments
// SDK; the journey uses Square's sandbox test nonces instead. Set
// SQUARE_ARTIFACT_DIR to keep the evidence; it repeats byte for byte, because
// it holds no Square ids.
import type {
  CommerceAdminClient,
  CommerceBuyerPaymentResultV1,
  CommercePaymentClientConfirmationV1,
} from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";
import { expect, it } from "vitest";

import { SquareApi } from "../src/payments/square/square-api.ts";
import {
  BASE_URL,
  Buyer,
  NOW,
  SERVICE_TOKEN,
  STOREFRONT,
  catalogLine,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
  type Quoted,
} from "./journey-support.ts";
import { SquareCounterDesk } from "./square-counter-desk.ts";

const TOKEN = process.env.UNDERCLERK_SQUARE_SANDBOX_TOKEN ?? "";
const APPLICATION_ID =
  process.env.UNDERCLERK_SQUARE_SANDBOX_APPLICATION_ID ?? "";
// A sandbox access token needs no refresh, so the secret is never sent.
const SANDBOX_APPLICATION = {
  clientId: APPLICATION_ID,
  clientSecret: "not-used-by-this-journey",
};
const BINDING = "payment_binding_primary_online";
// Square keeps idempotency keys, and the journey's other ids repeat from run
// to run, so each run pays and refunds under its own keys.
const RUN = Date.now();
const SMALL = "variant_tea_small_sencha";

type Backend = Awaited<ReturnType<typeof startBackend>>;

it.skipIf(TOKEN.length < 16 || APPLICATION_ID.length === 0)(
  "takes and partly refunds a Square sandbox payment with Platform stopped, across a lost answer",
  { timeout: 180_000 },
  async () => {
    // A minute early, for a difference between this clock and Square's.
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    // The connection drops after Square took the first payment request.
    let lose = true;
    const squareFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (lose && init?.method === "POST" && url.pathname === "/v2/payments") {
        lose = false;
        await response.arrayBuffer();
        throw new TypeError("The connection was lost");
      }
      return response;
    };
    // Commerce asks Square again only after a try's `reconcileAfter`; the
    // journey moves the clock past it.
    let clock = Date.parse(NOW);
    const later = () => {
      clock += 2 * 60_000;
    };
    const backend = await startBackend({
      square: { fetch: squareFetch, oauth: SANDBOX_APPLICATION },
      now: () => new Date(clock).toISOString(),
    });
    const square = new SquareApi();
    try {
      const evidence: Evidence = {};
      const location = await sandboxLocation(square);
      const staff = new SquareDesk(backend.admin);
      await staff.createTea();
      expect(await staff.createAustralia(location.currency)).toMatchObject({
        outcome: "applied",
      });

      // 1. A partner key with settings:write connects the location; a token
      //    that cannot see it is refused.
      const partnerKey = await issueKey(backend, [
        "settings:read",
        "settings:write",
      ]);
      const connect = (accessToken: string) =>
        call(backend, partnerKey, "PUT", "square/connection", {
          environment: "development",
          grant: { kind: "tokens", accessToken },
        });
      const refused = await connect("EAAAnot-a-real-square-token-0000");
      expect(refused.status).toBe(409);
      expect((await connect(TOKEN)).status).toBe(200);
      const linked = await call(
        backend,
        partnerKey,
        "PUT",
        "payment-accounts/square",
        { paymentProviderBindingId: BINDING, locationId: location.id },
      );
      expect(linked.status).toBe(200);
      expect(linked.body).toMatchObject({
        provider: "square",
        locationId: location.id,
        currency: location.currency,
        state: "active",
      });

      // 2. A buyer in the Australian market starts a payment: the session
      //    holds what Square's Web Payments SDK needs.
      const kai = await Buyer.start(backend.buyer, `square_kai_${RUN}`);
      kai.marketId = "market_au";
      const quoted = await kai.quote([catalogLine(SMALL)]);
      expect(quoted.quote.totals.total.currency).toBe(location.currency);
      const session = await startPayment(backend, kai, quoted, "kai");
      expect(session.publicConfiguration).toEqual({
        provider: "square_online",
        applicationId: APPLICATION_ID,
        locationId: location.id,
        environment: "development",
      });

      // 3. The answer to the first payment request is lost; the buyer's
      //    retry places the order from the payment that Square made.
      const card = {
        kind: "square_source_token",
        sourceToken: "cnon:card-nonce-ok",
      } as const;
      const lost = await reconcile(backend, kai, quoted, "kai", card);
      later();
      const placed = await reconcile(backend, kai, quoted, "kai", card);
      expect(lost.state).toBe("indeterminate");
      if (placed.state !== "placed")
        throw new Error(`Kai's payment ended ${placed.state}`);
      expect(placed.total).toEqual(quoted.quote.totals.total);
      const payments = await paymentsFor(
        square,
        location.id,
        startedAt,
        session.paymentAttemptId,
      );
      expect(payments).toHaveLength(1);
      // The list is behind on a payment's status; the payment itself is not.
      const read = await square.request(
        "development",
        TOKEN,
        "GET",
        `/v2/payments/${encodeURIComponent(String(payments[0]?.id))}`,
      );
      const squarePayment = read.kind === "ok" ? read.body.payment : undefined;
      expect(squarePayment).toMatchObject({
        status: "COMPLETED",
        amount_money: {
          amount: quoted.quote.totals.total.amountMinor,
          currency: location.currency,
        },
      });

      // 4. Staff refund five dollars on Square; the alarm reads the pending
      //    refund again until Square completes it.
      const snapshot = await required(backend.admin.readSnapshot(merchantId));
      const order = snapshot.resources.orders.find(
        (item) => item.id === placed.orderId,
      );
      const payment = snapshot.resources.payments.find(
        (item) => item.orderId === placed.orderId,
      );
      const line = order?.lineItems[0];
      if (order === undefined || payment === undefined || line === undefined)
        throw new Error("Kai's order is incomplete");
      const refund = await staff.refund(order, payment, line.id, {
        amountMinor: 500,
        currency: location.currency,
      });
      expect(refund.outcome).toBe("applied");
      const paymentState = async () =>
        (
          await required(backend.admin.readSnapshot(merchantId))
        ).resources.payments.find((item) => item.id === payment.id)?.lifecycle;
      let refundedPayment = await paymentState();
      for (
        let attempt = 0;
        attempt < 30 && refundedPayment?.state === "captured";
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        later();
        await backend.reconcileRefunds();
        refundedPayment = await paymentState();
      }
      expect(refundedPayment).toMatchObject({
        state: "partially_refunded",
        refundedAmount: { amountMinor: 500, currency: location.currency },
      });
      const refundedRead = await square.request(
        "development",
        TOKEN,
        "GET",
        `/v2/payments/${encodeURIComponent(String(payments[0]?.id))}`,
      );
      const refundedOnSquare =
        refundedRead.kind === "ok" &&
        isRecord(refundedRead.body.payment) &&
        isRecord(refundedRead.body.payment.refunded_money)
          ? refundedRead.body.payment.refunded_money.amount
          : 0;
      expect(refundedOnSquare).toBe(500);

      // 5. A declined card places nothing.
      const mio = await Buyer.start(backend.buyer, `square_mio_${RUN}`);
      mio.marketId = "market_au";
      const mioQuote = await mio.quote([catalogLine(SMALL)]);
      await startPayment(backend, mio, mioQuote, "mio");
      const declined = await reconcile(backend, mio, mioQuote, "mio", {
        kind: "square_source_token",
        sourceToken: "cnon:card-nonce-declined",
      });
      expect(declined.state).toBe("declined");
      const ordersAfter = (
        await required(backend.admin.readSnapshot(merchantId))
      ).resources.orders.length;
      expect(ordersAfter).toBe(snapshot.resources.orders.length);

      Object.assign(evidence, {
        connect: {
          refused: refused.status,
          linked: linked.status,
          state: linked.body.state,
        },
        payment: {
          market: "market_au",
          currency: location.currency,
          firstAnswer: lost.state,
          retry: placed.state,
          squarePayments: payments.length,
          squareStatus: (squarePayment as Record<string, unknown>).status,
        },
        refund: {
          outcome: refund.outcome,
          refundedOnSquare,
          paymentState: refundedPayment?.state,
        },
        declinedCard: declined.state,
      });
      writeEvidence("SQUARE_ARTIFACT_DIR", "square-payments", evidence);
    } finally {
      backend.close();
    }
  },
);

class SquareDesk extends SquareCounterDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, RUN);
  }

  createAustralia(currency: string) {
    return this.edit(
      this.admin.createMarket({
        ...this.editBase("create_market_au"),
        marketId: "market_au",
        name: "Australia",
        countries: ["AU"],
        currency,
        storefrontIds: [STOREFRONT],
        pricing: {
          kind: "converted",
          rate: { value: "0.0102", setAt: NOW, source: "staff" },
          roundingIncrement: 5,
        },
      }),
    );
  }

}

async function startPayment(
  backend: Backend,
  buyer: Buyer,
  checkout: Quoted,
  name: string,
) {
  const session = await required(
    backend.buyer.createPaymentSession(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      buyer.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: `square_payment_${name}_${RUN}`,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        returnUrl: `${BASE_URL}/store/cafe`,
      },
    ),
  );
  if (
    session.state !== "ready" ||
    session.session.kind !== "embedded_public_session"
  )
    throw new Error(`The payment session is ${session.state}`);
  return {
    paymentAttemptId: session.session.providerSessionReference,
    publicConfiguration: session.session.publicConfiguration,
  };
}

function reconcile(
  backend: Backend,
  buyer: Buyer,
  checkout: Quoted,
  name: string,
  confirmation: CommercePaymentClientConfirmationV1,
): Promise<CommerceBuyerPaymentResultV1> {
  return required(
    backend.buyer.reconcilePayment(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      buyer.token,
      {
        schemaVersion: "underclerk.reconcile-buyer-payment.v1",
        idempotencyKey: `square_payment_${name}_${RUN}`,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        confirmation,
      },
    ),
  );
}

/** The sandbox account's first location that takes card payments. */
async function sandboxLocation(
  square: SquareApi,
): Promise<Readonly<{ id: string; currency: string }>> {
  const listed = await square.request(
    "development",
    TOKEN,
    "GET",
    "/v2/locations",
  );
  const locations =
    listed.kind === "ok" && Array.isArray(listed.body.locations)
      ? (listed.body.locations as Record<string, unknown>[])
      : [];
  const location = locations.find(
    (item) =>
      item.status === "ACTIVE" &&
      Array.isArray(item.capabilities) &&
      item.capabilities.includes("CREDIT_CARD_PROCESSING"),
  );
  if (
    location === undefined ||
    typeof location.id !== "string" ||
    typeof location.currency !== "string"
  )
    throw new Error("The sandbox account has no location for card payments");
  return { id: location.id, currency: location.currency };
}

/**
 * Square's payments at the location since the run started, for one attempt.
 * Square's list shows a new payment after a few seconds, so the list is read
 * once more after the first payment shows, for a second one made just after.
 */
async function paymentsFor(
  square: SquareApi,
  locationId: string,
  since: string,
  paymentAttemptId: string,
): Promise<Record<string, unknown>[]> {
  const list = async () => {
    const listed = await square.request(
      "development",
      TOKEN,
      "GET",
      `/v2/payments?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(since)}&limit=100`,
    );
    const payments =
      listed.kind === "ok" && Array.isArray(listed.body.payments)
        ? (listed.body.payments as Record<string, unknown>[])
        : [];
    return payments.filter(
      (item) => item.note === `Underclerk ${paymentAttemptId}`,
    );
  };
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if ((await list()).length > 0) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  return list();
}

async function issueKey(
  backend: Backend,
  scopes: readonly string[],
): Promise<string> {
  const issued = await call(backend, SERVICE_TOKEN, "POST", "api-keys", {
    label: "Payments partner",
    scopes,
  });
  if (issued.status !== 201)
    throw new Error(`Key issue failed: ${issued.status}`);
  return String(issued.body.key);
}

async function call(
  backend: Backend,
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: Record<string, unknown> }>> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Square's sandbox Terminal that completes every card checkout. */
const SANDBOX_TERMINAL = "9fa747a2-25ff-48ee-b078-04381f7c828f";

it.skipIf(TOKEN.length < 16 || APPLICATION_ID.length === 0)(
  "takes and partly refunds a Square Terminal counter payment with Platform stopped",
  { timeout: 180_000 },
  async () => {
    let clock = Date.parse(NOW);
    const later = () => {
      clock += 2 * 60_000;
    };
    const backend = await startBackend({
      square: { oauth: SANDBOX_APPLICATION },
      now: () => new Date(clock).toISOString(),
    });
    const square = new SquareApi();
    try {
      const evidence: Evidence = {};
      const location = await sandboxLocation(square);
      const counter = new SquareCounterDesk(backend.admin, RUN);
      await counter.createTea();
      expect(await counter.listTin(location.currency)).toMatchObject({
        outcome: "applied",
      });
      await counter.publishPolicy(location.currency);
      const partnerKey = await issueKey(backend, ["settings:write"]);
      const connected = await call(
        backend,
        partnerKey,
        "PUT",
        "square/connection",
        { environment: "development", grant: { kind: "tokens", accessToken: TOKEN } },
      );
      expect(connected.status).toBe(200);
      const linked = await call(
        backend,
        partnerKey,
        "PUT",
        "payment-accounts/square",
        { paymentProviderBindingId: BINDING, locationId: location.id },
      );
      expect(linked.status).toBe(200);

      // 1. A barista rings up the tin; the Terminal takes the card.
      const checkoutId = `checkout_counter_${RUN}`;
      expect(await counter.ring(checkoutId)).toMatchObject({
        outcome: "applied",
      });
      const rung = await required(
        backend.admin.readCounterSale(merchantId, checkoutId),
      );
      const quote = rung.checkout.lifecycle.quote;
      const collected = await counter.collect(rung, {
        provider: "square_terminal",
        account: {
          integrationAccountId: "integration_square_counter",
          providerAccountId: String(linked.body.providerAccountId),
          environment: "development",
          capabilityRevision: 1,
          country: String(linked.body.country),
          currency: location.currency,
        },
        locationId: location.id,
        deviceId: SANDBOX_TERMINAL,
        transport: "server_terminal",
      });
      expect(collected).toMatchObject({
        outcome: "ready",
        session: {
          kind: "server_terminal_checkout",
          deviceId: SANDBOX_TERMINAL,
        },
      });

      // 2. The counter sale reads the Terminal until its payment completes,
      //    and places the order.
      let sale = rung;
      for (
        let attempt = 0;
        attempt < 15 && sale.checkout.lifecycle.state !== "accepted";
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        later();
        sale = await required(
          backend.admin.reconcileCounterSalePayment(merchantId, checkoutId),
        );
      }
      expect(sale.checkout.lifecycle.state).toBe("accepted");
      const attempt = sale.paymentAttempt?.lifecycle;
      if (attempt?.state !== "captured")
        throw new Error("The counter payment was not captured");
      const read = await square.request(
        "development",
        TOKEN,
        "GET",
        `/v2/payments/${encodeURIComponent(attempt.providerPaymentReference)}`,
      );
      const taken = read.kind === "ok" ? read.body.payment : undefined;
      expect(taken).toMatchObject({
        status: "COMPLETED",
        source_type: "CARD",
        location_id: location.id,
        amount_money: {
          amount: quote.totals.total.amountMinor,
          currency: location.currency,
        },
      });

      // 3. Staff refund five dollars of the counter order on Square.
      const snapshot = await required(backend.admin.readSnapshot(merchantId));
      const order = snapshot.resources.orders.find(
        (item) =>
          item.origin.kind === "point_of_sale" &&
          item.origin.checkoutId === checkoutId,
      );
      const payment = snapshot.resources.payments.find(
        (item) => item.orderId === order?.id,
      );
      const line = order?.lineItems[0];
      if (order === undefined || payment === undefined || line === undefined)
        throw new Error("The counter order is incomplete");
      const refund = await counter.refund(order, payment, line.id, {
        amountMinor: 500,
        currency: location.currency,
      });
      expect(refund.outcome).toBe("applied");
      const paymentState = async () =>
        (
          await required(backend.admin.readSnapshot(merchantId))
        ).resources.payments.find((item) => item.id === payment.id)?.lifecycle;
      let refunded = await paymentState();
      for (
        let round = 0;
        round < 30 && refunded?.state === "captured";
        round += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        later();
        await backend.reconcileRefunds();
        refunded = await paymentState();
      }
      expect(refunded).toMatchObject({
        state: "partially_refunded",
        refundedAmount: { amountMinor: 500, currency: location.currency },
      });

      Object.assign(evidence, {
        counter: {
          currency: location.currency,
          collection: collected.outcome,
          saleState: sale.checkout.lifecycle.state,
          origin: order.origin.kind,
          squareStatus: isRecord(taken) ? taken.status : null,
          squareSource: isRecord(taken) ? taken.source_type : null,
        },
        refund: { outcome: refund.outcome, paymentState: refunded?.state },
      });
      writeEvidence("SQUARE_ARTIFACT_DIR", "square-terminal", evidence);
    } finally {
      backend.close();
    }
  },
);
