// Plan 80 step 4, Square inside Commerce: an operator's app connects the
// café's Square account with an authorization code, and Commerce exchanges
// it with the application's secret; a code that Square refuses connects
// nothing. The café's payment location takes payments, and a location that
// cannot take cards is refused. A Terminal is paired with a device code. A
// barista rings up a tin; the merchant's own alarm reads the Terminal until
// the card is paid and places the order, with no call from the partner.
// Near its expiry the token is refreshed once for two reads at the same
// time. When the app disconnects Square, Commerce revokes the tokens at
// Square, and the next Terminal sale cannot start. Square is a fake that
// only answers. Set SQUARE_CONNECTION_ARTIFACT_DIR to keep the evidence; it
// repeats byte for byte for the same commit.
import type { CommerceCounterSaleV1 } from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";
import { expect, it } from "vitest";

import {
  BASE_URL,
  NOW,
  SERVICE_TOKEN,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { SquareCounterDesk } from "./square-counter-desk.ts";

const OAUTH = { clientId: "sq0idp-cafe-app", clientSecret: "sq0csp-secret" };
const SELLER = "MLCAFESELLER";
const CAFE = "LCAFEFRONT";
const BACK_OFFICE = "LBACKOFFICE";
const DEVICE = "DEVICE_TERMINAL_1";
const CALLBACK = "https://pantry.example/v1/control/providers/square/callback";
const DAY = 86_400_000;
const PAYMENT_EVENTS = [
  "checkout.created",
  "checkout.payment_resolved",
  "order.created",
];

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "connects Square with a code, sells at a paired Terminal that the merchant's alarm reads, and revokes on disconnect",
  { timeout: 60_000 },
  squareConnection,
);

async function squareConnection(): Promise<void> {
  let clock = Date.parse(NOW);
  const square = new FakeSquare(() => clock);
  const backend = await startBackend({
    square: { fetch: square.fetch, oauth: OAUTH },
    now: () => new Date(clock).toISOString(),
  });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const key = await issueKey(backend, ["settings:read", "settings:write"]);
    const counter = new SquareCounterDesk(backend.admin, 1);
    await counter.createTea();
    expect(await counter.listTin("JPY")).toMatchObject({ outcome: "applied" });
    await counter.publishPolicy("JPY");

    // 1. A refused code connects nothing; the café's code connects Square.
    const connect = (code: string) =>
      call(backend, key, "PUT", "square/connection", {
        environment: "production",
        grant: { kind: "authorization_code", code, redirectUri: CALLBACK },
      });
    const refusedCode = await connect("code-that-square-refuses");
    const noConnection = await call(backend, key, "GET", "square/connection");
    const connected = await connect("code-from-the-cafe");
    expect({
      refusedCode: refusedCode.status,
      noConnection: noConnection.status,
      connected: connected.status,
    }).toEqual({ refusedCode: 409, noConnection: 404, connected: 200 });
    expect(connected.body).toMatchObject({
      provider: "square",
      environment: "production",
      applicationId: OAUTH.clientId,
      providerAccountId: SELLER,
      businessName: "Satyr Café",
      state: "connected",
    });
    expect(square.exchanges).toEqual([
      {
        code: "code-from-the-cafe",
        clientSecret: OAUTH.clientSecret,
        redirectUri: CALLBACK,
      },
    ]);

    // 2. The café's front takes payments; the back office cannot take cards.
    const locations = await call(backend, key, "GET", "square/locations");
    const link = (locationId: string) =>
      call(backend, key, "PUT", "payment-accounts/square", {
        paymentProviderBindingId: `square_${locationId}`,
        locationId,
      });
    const backOffice = await link(BACK_OFFICE);
    const front = await link(CAFE);
    expect({
      locations: (locations.body.locations as Record<string, unknown>[]).map(
        (location) => [location.locationId, location.cardPayments],
      ),
      backOffice: backOffice.status,
      front: front.status,
    }).toEqual({
      locations: [
        [CAFE, true],
        [BACK_OFFICE, false],
      ],
      backOffice: 409,
      front: 200,
    });

    // 3. A Terminal pairs with a device code.
    const code = await call(
      backend,
      key,
      "POST",
      "square/device-codes",
      { locationId: CAFE, name: "Front counter" },
      "pair-front-counter",
    );
    expect(code.body).toMatchObject({ status: "UNPAIRED", locationId: CAFE });
    square.pair();
    const paired = await call(
      backend,
      key,
      "GET",
      `square/device-codes/${String(code.body.deviceCodeId)}`,
    );
    expect(paired.body).toMatchObject({ status: "PAIRED", deviceId: DEVICE });

    // 4. A sale at the Terminal: the alarm reads it until the card is paid.
    const sale = await ring(backend, counter, "checkout_counter_tin");
    const collected = await counter.collect(sale, terminalBinding());
    expect(collected).toMatchObject({ outcome: "ready" });
    const reads: string[] = [];
    let state = sale.checkout.lifecycle.state;
    for (let round = 0; round < 6 && state !== "accepted"; round += 1) {
      clock += 5_000;
      await backend.runDueWork();
      state = (
        await required(
          backend.admin.readCounterSale(merchantId, "checkout_counter_tin"),
        )
      ).checkout.lifecycle.state;
      reads.push(state);
    }
    // The buyer taps the card on the fourth read; the waiting reads write
    // one event, not one each.
    expect(reads).toEqual([
      "payment_pending",
      "payment_pending",
      "payment_pending",
      "accepted",
    ]);
    const events = (await feedKinds(backend)).filter(
      (kind) => kind.startsWith("checkout.") || kind.startsWith("order."),
    );
    expect(events).toEqual(PAYMENT_EVENTS);

    // 5. Near the expiry, two reads at once share one refresh.
    clock += 29 * DAY + 12 * 60 * 60_000;
    const [first, second] = await Promise.all([
      call(backend, key, "GET", "square/locations"),
      call(backend, key, "GET", "square/devices"),
    ]);
    expect({
      first: first.status,
      second: second.status,
      refreshes: square.refreshes,
      lastToken: square.lastToken,
    }).toEqual({
      first: 200,
      second: 200,
      refreshes: 1,
      lastToken: "sq-access-2",
    });

    // 6. Disconnect revokes at Square; the next sale cannot start.
    const disconnected = await call(
      backend,
      key,
      "POST",
      "square/connection/revocation",
      {},
    );
    const accounts = await call(backend, key, "GET", "payment-accounts");
    const next = await ring(backend, counter, "checkout_counter_after");
    // A new sale is a new payment attempt.
    const refused = await new SquareCounterDesk(backend.admin, 2).collect(
      next,
      terminalBinding(),
    );
    expect({
      disconnected: disconnected.status,
      revocations: square.revocations,
      accounts: accounts.body.accounts,
      next: refused.outcome,
    }).toEqual({
      disconnected: 200,
      revocations: [
        { authorization: `Client ${OAUTH.clientSecret}`, seller: SELLER },
      ],
      accounts: [],
      next: "unavailable",
    });

    Object.assign(evidence, {
      connect: { refusedCode: 409, connected: connected.body },
      locations: { backOffice: 409, front: front.body },
      pairing: { code: code.body.status, paired: paired.body.status },
      counter: { collected: collected.outcome, reads, events },
      refresh: { concurrentReads: 2, refreshes: square.refreshes },
      disconnect: {
        revocations: square.revocations.length,
        next: refused.outcome,
      },
    });
  } finally {
    writeEvidence(
      "SQUARE_CONNECTION_ARTIFACT_DIR",
      "square-connection",
      evidence,
    );
    backend.close();
  }
}

/** Square's API as the café's account answers it. */
class FakeSquare {
  readonly exchanges: Record<string, unknown>[] = [];
  readonly revocations: Record<string, unknown>[] = [];
  refreshes = 0;
  lastToken = "";
  #tokens = new Set<string>();
  #paired = false;
  #checkout: Record<string, unknown> | undefined;
  #checkoutReads = 0;
  readonly #clock: () => number;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  pair(): void {
    this.#paired = true;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init?.headers);
    const path = url.pathname;
    if (path === "/oauth2/token" && isRecord(body)) return this.#token(body);
    if (path === "/oauth2/revoke" && isRecord(body)) {
      this.revocations.push({
        authorization: headers.get("authorization"),
        seller: body.merchant_id,
      });
      this.#tokens.clear();
      return json({ success: true });
    }
    const bearer = headers.get("authorization")?.replace(/^Bearer /u, "");
    if (bearer === undefined || !this.#tokens.has(bearer))
      return json({ errors: [{ code: "UNAUTHORIZED" }] }, 401);
    this.lastToken = bearer;
    if (path === "/v2/merchants/me")
      return json({
        merchant: {
          id: SELLER,
          business_name: "Satyr Café",
          country: "JP",
          currency: "JPY",
        },
      });
    if (path === "/v2/locations")
      return json({
        locations: [location(CAFE, true), location(BACK_OFFICE, false)],
      });
    if (path.startsWith("/v2/locations/")) {
      const id = path.slice("/v2/locations/".length);
      return json({ location: location(id, id === CAFE) });
    }
    if (path === "/v2/devices")
      return json({
        devices: this.#paired
          ? [
              {
                id: DEVICE,
                attributes: { name: "Front counter" },
                status: { category: "AVAILABLE" },
              },
            ]
          : [],
      });
    if (path === "/v2/devices/codes" && method === "POST")
      return json({ device_code: this.#deviceCode() });
    if (path.startsWith("/v2/devices/codes/"))
      return json({ device_code: this.#deviceCode() });
    if (
      path === "/v2/terminals/checkouts" &&
      isRecord(body) &&
      isRecord(body.checkout)
    ) {
      this.#checkout = {
        id: "TERMINAL_CHECKOUT_1",
        reference_id: body.checkout.reference_id,
        amount_money: body.checkout.amount_money,
        device_options: body.checkout.device_options,
        status: "PENDING",
      };
      return json({ checkout: this.#checkout });
    }
    if (
      path.startsWith("/v2/terminals/checkouts/") &&
      this.#checkout !== undefined
    ) {
      this.#checkoutReads += 1;
      return json({
        checkout:
          this.#checkoutReads < 4
            ? this.#checkout
            : {
                ...this.#checkout,
                status: "COMPLETED",
                payment_ids: ["PAYMENT_1"],
              },
      });
    }
    if (path === "/v2/payments/PAYMENT_1" && this.#checkout !== undefined)
      return json({
        payment: {
          id: "PAYMENT_1",
          status: "COMPLETED",
          source_type: "CARD",
          location_id: CAFE,
          amount_money: this.#checkout.amount_money,
          reference_id: this.#checkout.reference_id,
        },
      });
    return json({ errors: [{ code: "NOT_FOUND" }] }, 404);
  };

  async #token(body: Record<string, unknown>): Promise<Response> {
    if (
      body.client_id !== OAUTH.clientId ||
      body.client_secret !== OAUTH.clientSecret
    )
      return json({ errors: [{ code: "UNAUTHORIZED" }] }, 401);
    if (body.grant_type === "authorization_code") {
      if (body.code !== "code-from-the-cafe")
        return json({ errors: [{ code: "invalid_grant" }] }, 400);
      this.exchanges.push({
        code: body.code,
        clientSecret: body.client_secret,
        redirectUri: body.redirect_uri,
      });
      return this.#issue("sq-access-1");
    }
    if (
      body.grant_type === "refresh_token" &&
      body.refresh_token === "sq-refresh"
    ) {
      this.refreshes += 1;
      // Square takes a moment; a second refresh would arrive meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return this.#issue(`sq-access-${this.refreshes + 1}`);
    }
    return json({ errors: [{ code: "invalid_grant" }] }, 400);
  }

  #issue(accessToken: string): Response {
    this.#tokens.add(accessToken);
    return json({
      access_token: accessToken,
      refresh_token: "sq-refresh",
      token_type: "bearer",
      merchant_id: SELLER,
      expires_at: new Date(this.#clock() + 30 * DAY).toISOString(),
    });
  }

  #deviceCode(): Record<string, unknown> {
    return {
      id: "DEVICE_CODE_1",
      code: "TQVWXY",
      name: "Front counter",
      product_type: "TERMINAL_API",
      location_id: CAFE,
      status: this.#paired ? "PAIRED" : "UNPAIRED",
      pair_by: new Date(this.#clock() + 5 * 60_000).toISOString(),
      ...(this.#paired ? { device_id: DEVICE } : {}),
    };
  }
}

function location(id: string, cards: boolean): Record<string, unknown> {
  return {
    id,
    name: id === CAFE ? "Café front" : "Back office",
    merchant_id: SELLER,
    country: "JP",
    currency: "JPY",
    status: "ACTIVE",
    capabilities: cards ? ["CREDIT_CARD_PROCESSING"] : [],
  };
}

function terminalBinding() {
  return {
    provider: "square_terminal" as const,
    account: {
      integrationAccountId: "integration_square_counter",
      providerAccountId: SELLER,
      environment: "production" as const,
      capabilityRevision: 1,
      country: "JP",
      currency: "JPY",
    },
    locationId: CAFE,
    deviceId: DEVICE,
    transport: "server_terminal" as const,
  };
}

async function ring(
  backend: Backend,
  counter: SquareCounterDesk,
  checkoutId: string,
): Promise<CommerceCounterSaleV1> {
  expect(await counter.ring(checkoutId)).toMatchObject({ outcome: "applied" });
  return required(backend.admin.readCounterSale(merchantId, checkoutId));
}

async function feedKinds(backend: Backend): Promise<string[]> {
  const page = await required(
    backend.admin.readEvents(merchantId, { limit: 300 }),
  );
  return page.events.map((event) => event.kind);
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
  idempotencyKey?: string,
): Promise<Readonly<{ status: number; body: Record<string, unknown> }>> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined
          ? {}
          : { "idempotency-key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const parsed: unknown = await response.json();
  return { status: response.status, body: isRecord(parsed) ? parsed : {} };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
