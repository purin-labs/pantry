// The money that reaches a café's bank, from Stripe and Square, on fakes that
// only answer calls. The café reads a window: each payout has its amount, its
// day at the bank and the first and last sale that it pays out; a refund or a fee
// does not move those, a payout that a person started has none, and a payout
// that Square sent before the window counts by its arrival. A second read asks
// for the sales no more, and shows that the bank returned a payout. Stripe goes
// down: the kept payouts stay and the page can say so. Square refuses a
// connection without the permission, and a sales read that fails is read on the
// next read. Set BANK_PAYOUTS_ARTIFACT_DIR to keep the evidence; it repeats byte
// for byte.
import { isRecord } from "@purin-labs/std";
import { expect, it } from "vitest";

import { FakeStripe } from "./fake-stripe.ts";
import {
  BASE_URL,
  NOW,
  SERVICE_TOKEN,
  merchantId,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const ACCOUNT = "acct_fakecafe";
const LOCATION = "LCAFEFRONT";
const SELLER = "MLCAFESELLER";
const OAUTH = { clientId: "sq0idp-cafe-app", clientSecret: "sq0csp-secret" };
const DAY = 86_400_000;
const START = Date.parse(NOW);

const at = (days: number): number => START + days * DAY;
const iso = (days: number): string => new Date(at(days)).toISOString();
const date = (days: number): string => iso(days).slice(0, 10);
const unix = (days: number): number => Math.floor(at(days) / 1_000);

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "shows each payout's sales and its day at the bank, and keeps them when a provider stops answering",
  { timeout: 60_000 },
  async () => {
    const stripe = new StripeBank();
    const square = new SquareBank();
    const backend = await startBackend({
      now: () => NOW,
      stripe: {
        secretKey: "sk_test_fake_platform",
        publishableKey: "pk_test_fake_platform",
        fetch: stripe.fetch,
      },
      square: { fetch: square.fetch, oauth: OAUTH },
    });
    const evidence: Evidence = { clock: NOW, merchantId };
    try {
      await connect(backend);
      const window = `start=${date(-20)}&end=${date(1)}`;
      const read = async (query = window): Promise<Read> =>
        readPayouts(backend, SERVICE_TOKEN, query);

      // 1. A key may read this with orders:read only, and a window is of days.
      const catalogKey = await issueKey(backend, ["catalog:read"]);
      const ordersKey = await issueKey(backend, ["orders:read"]);
      const refused = await readPayouts(backend, catalogKey, window);
      const notDays = await read(`start=${iso(-20)}&end=${iso(1)}`);
      const backwards = await read(`start=${date(1)}&end=${date(-20)}`);
      expect({
        refused: refused.status,
        notDays: notDays.status,
        backwards: backwards.status,
      }).toEqual({ refused: 403, notDays: 422, backwards: 422 });
      expect(stripe.payoutReads + square.payoutReads).toBe(0);

      // 2. The window's payouts, the latest day at the bank first.
      const first = await readPayouts(backend, ordersKey, window);
      expect(first.status).toBe(200);
      expect(first.body.sources).toEqual([
        { provider: "stripe", state: "read" },
        { provider: "square", state: "read" },
      ]);
      expect(first.body.truncated).toBe(false);
      expect(first.body.payouts).toEqual([
        {
          provider: "stripe",
          payoutId: "po_on_its_way",
          amount: { amountMinor: 31_000, currency: "JPY" },
          status: "on_its_way",
          arrivalDate: date(0),
          sentAt: iso(-2),
          sales: { from: iso(-6), to: iso(-3) },
        },
        {
          provider: "stripe",
          payoutId: "po_by_a_person",
          amount: { amountMinor: 5_000, currency: "JPY" },
          status: "arrived",
          arrivalDate: date(-5),
          sentAt: iso(-6),
          sales: null,
        },
        {
          provider: "square",
          payoutId: "sq_taken_back",
          amount: { amountMinor: -1_030, currency: "JPY" },
          status: "arrived",
          arrivalDate: date(-7),
          sentAt: iso(-8),
          sales: null,
        },
        {
          provider: "square",
          payoutId: "sq_week",
          amount: { amountMinor: 45_000, currency: "JPY" },
          status: "arrived",
          arrivalDate: date(-8),
          sentAt: iso(-9),
          sales: { from: iso(-10), to: iso(-9.5) },
        },
        {
          provider: "stripe",
          payoutId: "po_long_week",
          amount: { amountMinor: 82_400, currency: "JPY" },
          status: "arrived",
          arrivalDate: date(-10),
          sentAt: iso(-11),
          // The fee before these sales and the refund after them do not count.
          sales: { from: iso(-18), to: iso(-12) },
        },
        {
          provider: "square",
          payoutId: "sq_before_the_window",
          amount: { amountMinor: 12_000, currency: "JPY" },
          status: "arrived",
          arrivalDate: date(-19),
          sentAt: iso(-21),
          sales: { from: iso(-23), to: iso(-22) },
        },
      ]);
      evidence.firstRead = first.body;

      // 3. A second read asks for no sales again. The bank returned a payout.
      square.status("sq_week", "FAILED");
      const salesReads = stripe.salesReads + square.salesReads;
      const second = await read();
      expect(stripe.salesReads + square.salesReads - salesReads).toBe(0);
      expect(
        second.body.payouts.find((payout) => payout.payoutId === "sq_week"),
      ).toMatchObject({
        status: "failed",
        sales: { from: iso(-10), to: iso(-9.5) },
      });
      evidence.returnedPayout = { status: "failed", salesReadsAgain: 0 };

      // 4. Stripe stops answering. Its kept payouts stay, and the read says so.
      stripe.down = true;
      const outage = await read();
      stripe.down = false;
      expect(outage.status).toBe(200);
      expect(outage.body.sources).toEqual([
        { provider: "stripe", state: "unavailable" },
        { provider: "square", state: "read" },
      ]);
      expect(outage.body.payouts.map((payout) => payout.payoutId)).toEqual(
        first.body.payouts.map((payout) => payout.payoutId),
      );
      evidence.stripeDown = outage.body.sources;

      // 5. A connection without PAYOUTS_READ: the exact state that the page needs.
      square.scope = false;
      const noScope = await read();
      square.scope = true;
      expect(noScope.body.sources).toEqual([
        { provider: "stripe", state: "read" },
        { provider: "square", state: "scope_missing" },
      ]);
      expect(noScope.body.payouts).toHaveLength(first.body.payouts.length);
      evidence.squareWithoutPermission = noScope.body.sources;

      // 6. A sales read that fails leaves the payout without sales until the
      //    next read finds them. A later window does not hold this payout twice.
      stripe.add("po_new", 9_900, "paid", -1, -2, true, [
        { type: "charge", created: unix(-4) },
        { type: "charge", created: unix(-3) },
      ]);
      stripe.salesDown = true;
      const during = await read();
      stripe.salesDown = false;
      const after = await read();
      expect(
        during.body.payouts.find((payout) => payout.payoutId === "po_new")
          ?.sales,
      ).toBeNull();
      expect(
        after.body.payouts.filter((payout) => payout.payoutId === "po_new"),
      ).toMatchObject([{ sales: { from: iso(-4), to: iso(-3) } }]);
      evidence.lateSales = {
        during: null,
        after: { from: iso(-4), to: iso(-3) },
      };

      writeEvidence("BANK_PAYOUTS_ARTIFACT_DIR", "bank-payouts", evidence);
    } finally {
      backend.close();
    }
  },
);

type Payout = Readonly<{
  payoutId: string;
  [key: string]: unknown;
}>;
type Read = Readonly<{
  status: number;
  body: Readonly<{
    sources: readonly unknown[];
    truncated: boolean;
    payouts: readonly Payout[];
  }>;
}>;

async function readPayouts(
  backend: Backend,
  token: string,
  query: string,
): Promise<Read> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/reports/bank-payouts?${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as Read["body"];
  return { status: response.status, body };
}

async function connect(backend: Backend): Promise<void> {
  const send = async (path: string, body: unknown): Promise<void> => {
    const response = await backend.fetch(
      `${BASE_URL}/v1/admin/merchants/${merchantId}/${path}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (response.status !== 200)
      throw new Error(`${path} answered ${String(response.status)}`);
  };
  await send("payment-accounts/stripe", {
    paymentProviderBindingId: "payment_binding_stripe",
    accountId: ACCOUNT,
  });
  await send("square/connection", {
    environment: "production",
    grant: {
      kind: "authorization_code",
      code: "code-from-the-cafe",
      redirectUri: "https://pantry.example/callback",
    },
  });
  await send("payment-accounts/square", {
    paymentProviderBindingId: "payment_binding_square",
    locationId: LOCATION,
  });
}

async function issueKey(
  backend: Backend,
  scopes: readonly string[],
): Promise<string> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/api-keys`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "Partner", scopes }),
    },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.key !== "string")
    throw new Error("The key was not issued");
  return body.key;
}

type Entry = Readonly<{ type: string; created: number }>;
type StripePayout = Readonly<{
  id: string;
  amount: number;
  status: string;
  arrivalDay: number;
  createdDay: number;
  automatic: boolean;
  entries: readonly Entry[];
}>;

/** Stripe's payouts of one account, listed as Stripe lists them. */
class StripeBank {
  readonly #accounts = new FakeStripe();
  readonly #payouts: StripePayout[] = [];
  payoutReads = 0;
  salesReads = 0;
  down = false;
  salesDown = false;

  constructor() {
    this.#accounts.connect(ACCOUNT);
    // 130 sales need two pages. A fee comes before them and a refund after.
    const sales = Array.from({ length: 130 }, (_, index) => ({
      type: "charge",
      created: unix(-12 - (index / 129) * 6),
    }));
    this.add("po_long_week", 82_400, "paid", -10, -11, true, [
      { type: "payout", created: unix(-11) },
      { type: "refund", created: unix(-11.5) },
      ...sales,
      { type: "stripe_fee", created: unix(-19) },
    ]);
    this.add("po_on_its_way", 31_000, "in_transit", 0, -2, true, [
      { type: "payment", created: unix(-3) },
      { type: "charge", created: unix(-6) },
    ]);
    this.add("po_by_a_person", 5_000, "paid", -5, -6, false, []);
    this.add("po_too_old", 77_000, "paid", -25, -26, true, []);
    this.add("po_tomorrow", 66_000, "pending", 1, -1, true, []);
  }

  add(
    id: string,
    amount: number,
    status: string,
    arrivalDay: number,
    createdDay: number,
    automatic: boolean,
    entries: readonly Entry[],
  ): void {
    this.#payouts.unshift({
      id,
      amount,
      status,
      arrivalDay,
      createdDay,
      automatic,
      entries,
    });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/v1/payouts") return this.#list(url, init);
    if (url.pathname === "/v1/balance_transactions") return this.#sales(url);
    return this.#accounts.fetch(input, init);
  };

  #list(url: URL, init: RequestInit | undefined): Response {
    this.payoutReads += 1;
    if (this.down) return Response.json({}, { status: 503 });
    if (new Headers(init?.headers).get("stripe-account") !== ACCOUNT)
      return Response.json({}, { status: 403 });
    const from = Number(url.searchParams.get("arrival_date[gte]"));
    const to = Number(url.searchParams.get("arrival_date[lt]"));
    const data = this.#payouts
      .map((payout) => ({
        payout,
        // Stripe's arrival date is midnight in UTC on that day.
        arrival: Date.parse(`${date(payout.arrivalDay)}T00:00:00Z`) / 1_000,
      }))
      .filter(({ arrival }) => from <= arrival && arrival < to)
      .map(({ payout, arrival }) => ({
        id: payout.id,
        object: "payout",
        amount: payout.amount,
        currency: "jpy",
        status: payout.status,
        arrival_date: arrival,
        created: unix(payout.createdDay),
        automatic: payout.automatic,
      }));
    return Response.json({ object: "list", has_more: false, data });
  }

  #sales(url: URL): Response {
    this.salesReads += 1;
    if (this.salesDown) return Response.json({}, { status: 503 });
    const payout = this.#payouts.find(
      (item) => item.id === url.searchParams.get("payout"),
    );
    // Stripe refuses a payout that it did not start by itself.
    if (payout === undefined || !payout.automatic)
      return Response.json({}, { status: 400 });
    const rows = [...payout.entries]
      .sort((left, right) => right.created - left.created)
      .map((entry, index) => ({ id: `txn_${String(index)}`, ...entry }));
    const after = url.searchParams.get("starting_after");
    const start =
      after === null ? 0 : rows.findIndex((row) => row.id === after) + 1;
    const limit = Number(url.searchParams.get("limit"));
    return Response.json({
      object: "list",
      has_more: start + limit < rows.length,
      data: rows.slice(start, start + limit),
    });
  }
}

type SquarePayout = {
  readonly id: string;
  readonly amount: number;
  status: string;
  readonly arrivalDay: number;
  readonly createdDay: number;
  readonly entries: readonly Readonly<{ type: string; day: number }>[];
};

/** Square's payouts of one location, listed as Square lists them. */
class SquareBank {
  readonly #payouts: SquarePayout[] = [
    {
      id: "sq_week",
      amount: 45_000,
      status: "PAID",
      arrivalDay: -8,
      createdDay: -9,
      entries: [
        { type: "FEE", day: -10.5 },
        { type: "CHARGE", day: -10 },
        { type: "CHARGE", day: -9.5 },
        { type: "REFUND", day: -9.2 },
      ],
    },
    {
      id: "sq_before_the_window",
      amount: 12_000,
      status: "PAID",
      arrivalDay: -19,
      createdDay: -21,
      entries: [
        { type: "CHARGE", day: -23 },
        { type: "CHARGE", day: -22 },
      ],
    },
    {
      id: "sq_taken_back",
      amount: -1_030,
      status: "PAID",
      arrivalDay: -7,
      createdDay: -8,
      entries: [{ type: "DEPOSIT_FEE", day: -8 }],
    },
    {
      id: "sq_after_the_window",
      amount: 20_000,
      status: "SENT",
      arrivalDay: 1,
      createdDay: -1,
      entries: [],
    },
    {
      id: "sq_long_ago",
      amount: 30_000,
      status: "PAID",
      arrivalDay: -40,
      createdDay: -41,
      entries: [],
    },
  ];
  payoutReads = 0;
  salesReads = 0;
  scope = true;

  status(id: string, status: string): void {
    const payout = this.#payouts.find((item) => item.id === id);
    if (payout === undefined) throw new Error(`No payout ${id}`);
    payout.status = status;
  }

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    if (path === "/oauth2/token")
      return Response.json({
        access_token: "sq-access",
        refresh_token: "sq-refresh",
        token_type: "bearer",
        expires_at: new Date(START + 30 * DAY).toISOString(),
        merchant_id: SELLER,
      });
    if (path === "/v2/merchants/me")
      return Response.json({
        merchant: {
          id: SELLER,
          business_name: "Satyr Café",
          country: "JP",
          currency: "JPY",
        },
      });
    if (path === `/v2/locations/${LOCATION}`)
      return Response.json({
        location: {
          id: LOCATION,
          name: "Café front",
          merchant_id: SELLER,
          country: "JP",
          currency: "JPY",
          status: "ACTIVE",
          capabilities: ["CREDIT_CARD_PROCESSING"],
        },
      });
    if (path === "/v2/payouts") return this.#list(url);
    const entries = /^\/v2\/payouts\/([^/]+)\/payout-entries$/u.exec(path);
    if (entries !== null) return this.#entries(url, entries[1] ?? "");
    return Response.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  };

  #refusal(): Response {
    return Response.json(
      {
        errors: [
          { category: "AUTHENTICATION_ERROR", code: "INSUFFICIENT_SCOPES" },
        ],
      },
      { status: 403 },
    );
  }

  #list(url: URL): Response {
    this.payoutReads += 1;
    if (!this.scope) return this.#refusal();
    if (url.searchParams.get("location_id") !== LOCATION)
      return Response.json({ payouts: [] });
    const from = Date.parse(url.searchParams.get("begin_time") ?? "");
    const to = Date.parse(url.searchParams.get("end_time") ?? "");
    return Response.json({
      payouts: this.#payouts
        .filter((payout) => {
          const created = at(payout.createdDay);
          return from <= created && created < to;
        })
        .map((payout) => ({
          id: payout.id,
          status: payout.status,
          location_id: LOCATION,
          created_at: iso(payout.createdDay),
          amount_money: { amount: payout.amount, currency_code: "JPY" },
          arrival_date: date(payout.arrivalDay),
          type: "BATCH",
        })),
    });
  }

  #entries(url: URL, id: string): Response {
    this.salesReads += 1;
    if (!this.scope) return this.#refusal();
    const payout = this.#payouts.find((item) => item.id === id);
    if (payout === undefined)
      return Response.json({ errors: [] }, { status: 404 });
    const rows = [...payout.entries].sort(
      (left, right) => left.day - right.day,
    );
    if (url.searchParams.get("sort_order") === "DESC") rows.reverse();
    return Response.json({
      payout_entries: rows.map((entry, index) => ({
        id: `entry_${String(index)}`,
        payout_id: id,
        type: entry.type,
        effective_at: iso(entry.day),
      })),
    });
  }
}
