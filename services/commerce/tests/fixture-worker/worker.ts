// The Commerce Worker that client test suites, such as Pantry Platform's, run
// as a built artifact (Plan 76 phase 1). It is the production Worker with
// four test settings: a deterministic payment gateway, an optional fixed
// clock (COMMERCE_FIXTURE_NOW), named seed scenarios at
// POST /v1/admin/merchants/:merchantId/test-fixture, and webhook posts to
// https://localhost, the client suite's own Worker. A client reaches it only
// over HTTP, so a client suite never imports Commerce source.
import { createPrivateKey, createPublicKey } from "node:crypto";

import { DurableObjectCommerceDatabase } from "../../src/durable-object-database.ts";
import { DeterministicPaymentGateway } from "../../src/payments/provider.ts";
import { parseRoute } from "../../src/http-routes.ts";
import worker, { CommerceMerchantDO, type Env } from "../../src/worker.ts";
import {
  EFFECT_EVIDENCE_KEY,
  runFixtureScenario,
  type EffectEvidence,
  type FixtureScenarioContext,
} from "./scenarios.ts";

export default worker;
export { CommerceShopNameDO } from "../../src/worker.ts";

type FixtureEnv = Env &
  Readonly<{
    COMMERCE_FIXTURE_NOW?: string;
  }>;

const FIXTURE_ROUTE =
  /^\/v1\/admin\/merchants\/([^/]+)\/(test-fixture|test-signing-key|test-request-counts)$/u;
const MERCHANT_ROUTE =
  /^\/v1\/admin\/merchants\/([^/]+)\/(e2e-evidence|command-receipts\/[^/]+|actions\/publish-catalog-listing)$/u;

export class CommerceFixtureMerchantDO extends CommerceMerchantDO {
  readonly #fixtureEnv: FixtureEnv;
  readonly #fixtureDatabase: DurableObjectCommerceDatabase;
  /** Requests that reached this object, by route kind; a journey reads them. */
  readonly #requestCounts = new Map<string, number>();
  /** Changes each time the object starts; a journey sees a restart by it. */
  readonly #instance = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    super(ctx, env);
    this.#fixtureEnv = env;
    this.#fixtureDatabase = new DurableObjectCommerceDatabase(ctx.storage);
  }

  protected override now(): string {
    // The base constructor reads the clock before this class sets its fields.
    const fixed = (this.env as FixtureEnv).COMMERCE_FIXTURE_NOW;
    return fixed === undefined || fixed === "" ? super.now() : fixed;
  }

  // The suite routes this Worker's outbound requests to its own Worker.
  protected override webhookAddressAllowed(url: string): boolean {
    return url.startsWith("https://localhost/") || super.webhookAddressAllowed(url);
  }

  protected override paymentGateways(): ReturnType<CommerceMerchantDO["paymentGateways"]> {
    return { paymentGateway: new DeterministicPaymentGateway(() => this.now()) };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = FIXTURE_ROUTE.exec(url.pathname);
    if (match === null) {
      const kind = parseRoute(url.pathname, request.method)?.kind ?? "unknown";
      this.#requestCounts.set(kind, (this.#requestCounts.get(kind) ?? 0) + 1);
      return this.#merchantRoute(request);
    }
    if (
      request.headers.get("authorization") !==
      `Bearer ${this.#fixtureEnv.COMMERCE_SERVICE_TOKEN}`
    )
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    const merchantId = decodeURIComponent(match[1] ?? "");
    if (match[2] === "test-request-counts") {
      const counts = Object.fromEntries(this.#requestCounts);
      if (request.method === "DELETE") this.#requestCounts.clear();
      return Response.json(counts);
    }
    if (match[2] === "test-signing-key") {
      if (request.method !== "GET") return Response.json({ message: "Method not allowed" }, { status: 405 });
      return Response.json({ keyId: this.#fixtureEnv.COMMERCE_SIGNING_KEY_ID, publicKeyB64: this.#publicKeyB64() });
    }
    if (request.method !== "POST") return Response.json({ message: "Method not allowed" }, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ message: "Invalid fixture request" }, { status: 400 });
    }
    const context: FixtureScenarioContext = {
      database: this.#fixtureDatabase,
      storage: this.ctx.storage,
      merchantId,
      now: () => this.now(),
      env: this.#fixtureEnv,
      api: (forwarded) => super.fetch(forwarded),
      instance: this.#instance,
      // The answer leaves first; the next request then starts a new object.
      stopAfterAnswer: () => void setTimeout(() => this.ctx.abort("fixture restart"), 0),
    };
    return runFixtureScenario(context, body);
  }

  // A behaviour that a scenario switches on for one merchant: a lost
  // response with its evidence counters.
  async #merchantRoute(request: Request): Promise<Response> {
    const match = MERCHANT_ROUTE.exec(new URL(request.url).pathname);
    if (match === null) return super.fetch(request);
    const route = match[2] ?? "";
    const evidence = await this.ctx.storage.get<EffectEvidence>(EFFECT_EVIDENCE_KEY);
    if (route === "e2e-evidence" && request.method === "GET")
      return Response.json(evidence ?? { mutations: 0, receiptReads: 0, committed: null });
    if (evidence === undefined) return super.fetch(request);
    if (route.startsWith("command-receipts/") && request.method === "GET") {
      const response = await super.fetch(request);
      if (response.status !== 401)
        await this.ctx.storage.put(EFFECT_EVIDENCE_KEY, { ...evidence, receiptReads: evidence.receiptReads + 1 });
      return response;
    }
    if (route === "actions/publish-catalog-listing" && request.method === "POST") {
      const response = await super.fetch(request);
      const mutations = evidence.mutations + 1;
      const lose = response.ok && mutations === 1;
      await this.ctx.storage.put(EFFECT_EVIDENCE_KEY, {
        ...evidence,
        mutations,
        committed: lose ? await response.clone().json() : evidence.committed,
      });
      return lose ? Response.json({ error: "e2e_committed_response_lost" }, { status: 503 }) : response;
    }
    return super.fetch(request);
  }

  #publicKeyB64(): string {
    const key = createPrivateKey({
      key: Buffer.from(this.#fixtureEnv.COMMERCE_SIGNING_PRIVATE_KEY_PKCS8_B64, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const jwk = createPublicKey(key).export({ format: "jwk" });
    if (jwk.x === undefined) throw new Error("Commerce signing key must be Ed25519");
    return jwk.x;
  }
}
