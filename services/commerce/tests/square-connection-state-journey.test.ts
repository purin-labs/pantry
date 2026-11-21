// Refactor 15: a café's Square connection says why it stopped, so the
// Payouts page can ask the operator for the right step. Square is a fake
// that only answers. The café connects without PAYOUTS_READ: the connection
// keeps Square's scope list, and the payouts read names the missing scope.
// It connects again with every scope. Near the token's expiry Square refuses
// the refresh: the token still reads until it expires, and then the read
// names the refresh, with no payouts call to Square. It connects again, and
// the seller removes the application in Square: the next read names the
// removal, and no later call sends the dead token. Set
// SQUARE_CONNECTION_STATE_ARTIFACT_DIR to keep the evidence; it repeats byte
// for byte.
import { isRecord } from "@purin-labs/std";
import { expect, it } from "vitest";

import {
  BASE_URL,
  NOW,
  SERVICE_TOKEN,
  merchantId,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const OAUTH = { clientId: "sq0idp-cafe-app", clientSecret: "sq0csp-secret" };
const SELLER = "MLCAFESELLER";
const LOCATION = "LCAFEFRONT";
const DAY = 86_400_000;
const EVERY_SCOPE = [
  "DEVICE_CREDENTIAL_MANAGEMENT",
  "DEVICES_READ",
  "MERCHANT_PROFILE_READ",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
  "PAYOUTS_READ",
];
const WITHOUT_PAYOUTS = EVERY_SCOPE.filter((scope) => scope !== "PAYOUTS_READ");

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "names a missing scope, a refused refresh and a removed application on the Square connection and its payouts read",
  { timeout: 60_000 },
  async () => {
    let clock = Date.parse(NOW);
    const square = new FakeSquare(() => clock);
    const backend = await startBackend({
      square: { fetch: square.fetch, oauth: OAUTH },
      now: () => new Date(clock).toISOString(),
    });
    const evidence: Evidence = { clock: NOW, merchantId };
    const payouts = async (): Promise<unknown> => {
      const day = (at: number) => new Date(at).toISOString().slice(0, 10);
      const answer = await call(
        backend,
        "GET",
        `reports/bank-payouts?start=${day(clock - 10 * DAY)}&end=${day(clock + DAY)}`,
      );
      expect(answer.status).toBe(200);
      return isRecord(answer.body) ? answer.body.sources : undefined;
    };
    const connection = async (): Promise<unknown> => {
      const answer = await call(backend, "GET", "square/connection");
      return isRecord(answer.body)
        ? { state: answer.body.state, scopes: answer.body.scopes }
        : answer.status;
    };
    try {
      // 1. The café grants every scope but PAYOUTS_READ.
      square.scopes = WITHOUT_PAYOUTS;
      square.payouts = "no_scope";
      await connect(backend, "code-without-payouts");
      const link = await call(backend, "PUT", "payment-accounts/square", {
        paymentProviderBindingId: "payment_binding_square",
        locationId: LOCATION,
      });
      expect(link.status).toBe(200);
      const withoutScope = {
        connection: await connection(),
        sources: await payouts(),
      };
      expect(withoutScope).toEqual({
        connection: { state: "scope_missing", scopes: WITHOUT_PAYOUTS },
        sources: [{ provider: "square", state: "scope_missing" }],
      });
      evidence.withoutScope = withoutScope;

      // 2. The café connects again with every scope.
      square.scopes = EVERY_SCOPE;
      square.payouts = "ok";
      await connect(backend, "code-with-payouts");
      const connected = {
        connection: await connection(),
        sources: await payouts(),
      };
      expect(connected).toEqual({
        connection: { state: "connected", scopes: EVERY_SCOPE },
        sources: [{ provider: "square", state: "read" }],
      });
      evidence.connected = connected;

      // 3. In the token's last day Square refuses the refresh. The token
      //    reads until it expires; then no payouts call goes to Square.
      square.refuseRefresh = true;
      clock += 29.5 * DAY;
      const lastDay = {
        sources: await payouts(),
        connection: await connection(),
      };
      clock += DAY;
      const payoutCalls = square.payoutCalls;
      const expired = {
        sources: await payouts(),
        connection: await connection(),
        payoutCallsToSquare: square.payoutCalls - payoutCalls,
      };
      expect({ lastDay, expired }).toEqual({
        lastDay: {
          sources: [{ provider: "square", state: "read" }],
          connection: { state: "refresh_failed", scopes: EVERY_SCOPE },
        },
        expired: {
          sources: [{ provider: "square", state: "refresh_failed" }],
          connection: { state: "refresh_failed", scopes: EVERY_SCOPE },
          payoutCallsToSquare: 0,
        },
      });
      evidence.refusedRefresh = { lastDay, expired };

      // 4. The café connects again; then the seller removes the application
      //    in Square. The dead token is sent once, and never again.
      square.refuseRefresh = false;
      await connect(backend, "code-after-refresh");
      square.payouts = "revoked";
      const removed = await payouts();
      const callsAfterRemoval = square.payoutCalls;
      const removedAgain = await payouts();
      const locations = await call(backend, "GET", "square/locations");
      const afterRemoval = {
        removed,
        removedAgain,
        connection: await connection(),
        payoutCallsToSquare: square.payoutCalls - callsAfterRemoval,
        locations: locations.status,
      };
      expect(afterRemoval).toEqual({
        removed: [{ provider: "square", state: "revoked" }],
        removedAgain: [{ provider: "square", state: "revoked" }],
        connection: { state: "revoked", scopes: EVERY_SCOPE },
        payoutCallsToSquare: 0,
        locations: 409,
      });
      evidence.applicationRemoved = afterRemoval;

      writeEvidence(
        "SQUARE_CONNECTION_STATE_ARTIFACT_DIR",
        "square-connection-state",
        evidence,
      );
    } finally {
      backend.close();
    }
  },
);

async function connect(backend: Backend, code: string): Promise<void> {
  const answer = await call(backend, "PUT", "square/connection", {
    environment: "production",
    grant: {
      kind: "authorization_code",
      code,
      redirectUri: "https://pantry.example/callback",
    },
  });
  if (answer.status !== 200)
    throw new Error(`The connection answered ${String(answer.status)}`);
}

async function call(
  backend: Backend,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, body: await response.json() };
}

/** Square's OAuth, token status, seller, location and payouts list. */
class FakeSquare {
  readonly #clock: () => number;
  #issued = 0;
  scopes: readonly string[] = EVERY_SCOPE;
  payouts: "ok" | "no_scope" | "revoked" = "ok";
  refuseRefresh = false;
  payoutCalls = 0;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    if (path === "/oauth2/token") return this.#token(init);
    if (path === "/oauth2/token/status")
      return Response.json({
        scopes: this.scopes,
        client_id: OAUTH.clientId,
        merchant_id: SELLER,
      });
    if (path === "/v2/merchants/me")
      return Response.json({
        merchant: {
          id: SELLER,
          business_name: "Pantry Café",
          country: "JP",
          currency: "JPY",
        },
      });
    if (path === `/v2/locations/${LOCATION}` || path === "/v2/locations")
      return this.#location(path);
    if (path === "/v2/payouts") return this.#payouts();
    return Response.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  };

  #token(init: RequestInit | undefined): Response {
    const body: unknown = JSON.parse(String(init?.body ?? "{}"));
    if (
      isRecord(body) &&
      body.grant_type === "refresh_token" &&
      this.refuseRefresh
    )
      return Response.json(
        {
          errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }],
        },
        { status: 401 },
      );
    this.#issued += 1;
    return Response.json({
      access_token: `sq-access-${String(this.#issued)}`,
      refresh_token: `sq-refresh-${String(this.#issued)}`,
      token_type: "bearer",
      expires_at: new Date(this.#clock() + 30 * DAY).toISOString(),
      merchant_id: SELLER,
    });
  }

  #location(path: string): Response {
    const location = {
      id: LOCATION,
      name: "Café front",
      merchant_id: SELLER,
      country: "JP",
      currency: "JPY",
      status: "ACTIVE",
      capabilities: ["CREDIT_CARD_PROCESSING"],
    };
    if (this.payouts === "revoked") return this.#revoked();
    return Response.json(
      path === "/v2/locations" ? { locations: [location] } : { location },
    );
  }

  #payouts(): Response {
    this.payoutCalls += 1;
    if (this.payouts === "revoked") return this.#revoked();
    if (this.payouts === "no_scope")
      return Response.json(
        {
          errors: [
            { category: "AUTHENTICATION_ERROR", code: "INSUFFICIENT_SCOPES" },
          ],
        },
        { status: 403 },
      );
    return Response.json({ payouts: [] });
  }

  #revoked(): Response {
    return Response.json(
      {
        errors: [
          { category: "AUTHENTICATION_ERROR", code: "ACCESS_TOKEN_REVOKED" },
        ],
      },
      { status: 401 },
    );
  }
}
