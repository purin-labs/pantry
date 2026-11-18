import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { resolveProviderManifestCredential } from "../../src/credential-vault";
import { storeOrganisationPlacementVaultSecret } from "../../src/credential-vault/service";
import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type OrganisationId,
} from "../../src/ids";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { reconcileProviderAccountCleanup } from "../../src/provider-lifecycle/cleanup-reconciliation";
import { reconcileProviderManifestObservations } from "../../src/provider-lifecycle/observation";
import { createCommerceClient } from "../../src/commerce/outbox-worker";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { network } from "./network";
import { PlanJourney } from "./production-plan-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";
import {
  commerceEngine,
  configurationHeaders,
} from "./commerce-journey-support";

declare module "vitest" {
  interface TaskMeta {
    squareInUnderclerk?: Record<string, unknown>;
  }
}

const PUBLIC_ORIGIN = "https://localhost";
const SQUARE = "https://connect.squareup.com";
const OPERATOR = "Bearer underclerk-e2e-token";
const SELLER = "MLSQUARECAFE01";
const CAFE = "LSQUARECAFE01";
const BACK_OFFICE = "LSQUAREBACK01";
const DEVICE = "device:995CS397A6475287";
const COUNTER = "location_cafe";
const TOKENS = [
  "sq-access-1",
  "sq-refresh-1",
  "sq-legacy-access",
  "sq-legacy-refresh",
];

it(
  "connects Square in Underclerk, pairs a Terminal, sells and refunds at the counter, and keeps no Square token in Satyr",
  { timeout: 180_000 },
  squareInCommerceJourney,
);

/**
 * Plan 80 step 4. A production café connects Square from the Portal: Pantry
 * hands the authorization code to Commerce, which exchanges it and keeps
 * the tokens. Pantry's vault holds only the name of the Commerce merchant
 * that holds the connection. The owner pairs the café's Terminal through
 * Commerce, a barista sells a cookie that the Terminal takes, Commerce's
 * own alarm reads the Terminal and places the order, and the owner refunds
 * it. A connection from before this step still has tokens in Pantry's vault:
 * the next provider check hands them to Commerce and keeps only the
 * delegation. When the owner removes the Square account, Commerce revokes
 * the tokens at Square. Square is a fake that only answers.
 */
async function squareInCommerceJourney({ task }: TestContext): Promise<void> {
  const square = new FakeSquare();
  network.use(
    http.all(`${SQUARE}/*`, ({ request }) => square.answer(request)),
  );
  // The café's Pantry runs Square's production application.
  const settings = env as unknown as Record<string, string | undefined>;
  const sandboxApplication = {
    SQUARE_OAUTH_ENVIRONMENT: settings.SQUARE_OAUTH_ENVIRONMENT,
    SQUARE_OAUTH_CLIENT_ID: settings.SQUARE_OAUTH_CLIENT_ID,
  };
  settings.SQUARE_OAUTH_ENVIRONMENT = "production";
  settings.SQUARE_OAUTH_CLIENT_ID = "sq0idp-cafe-e2e";
  try {
    const owner = await commerceClient(`square-cafe-${crypto.randomUUID()}`);
    const organisationId = await commerceWorkspace(
      owner,
      "Square café",
      "production",
    );
    await ensureCreatedOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    });
    const merchantId = `merchant_square_cafe_${crypto.randomUUID().replaceAll("-", "")}`;
    await connectCommerceFixture(
      organisationId,
      owner.identity.userId,
      merchantId,
      { environment: "production" },
    );
    await attachSharedAccountNativeOrganisation({
      organisationId,
      owner,
      members: {},
    });
    await openCafeCounter(organisationId, merchantId, owner);

    // 1. The owner connects Square; Commerce exchanges the code.
    await connectSquare(organisationId, owner.session);
    expect(square.exchanges).toEqual([
      { code: "square-code-cafe", clientId: "sandbox-sq0idb-e2e" },
    ]);
    const linked = (await commerceEngine(merchantId, "payment-accounts"))
      .accounts as Record<string, unknown>[];
    expect(linked.map((account) => account.locationId)).toEqual([CAFE]);
    const account = await squareAccount(organisationId);
    const afterConnect = await pantryCredential(organisationId, account);
    expect(afterConnect).toEqual({
      kind: "opaque_profile",
      format: "underclerk_square_connection_v1",
      holder: { merchantId, providerAccountId: SELLER },
    });

    // 2. The owner refreshes the account's resources and pairs the Terminal.
    await refreshResources(organisationId, owner.session, account);
    // Input: the café finished production activation (its own journey);
    // only an active organisation's counter takes a Terminal.
    await fixtureDatabase().prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = ?, activated_at = ? WHERE organisation_id = ?",
    )
      .bind(
        `activation_receipt_${crypto.randomUUID()}`,
        Date.now(),
        organisationId,
      )
      .run();
    const started = await terminalControl(
      organisationId,
      owner.session,
      "/pairings",
      {
        satyrLocationId: COUNTER,
        integrationAccountId: account,
        providerLocationId: CAFE,
        deviceName: "Front counter",
      },
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const pairing = record(record(started.body).pairing);
    expect(pairing).toMatchObject({ providerLocationId: CAFE, status: "open" });
    square.pair();
    const activated = await terminalControl(
      organisationId,
      owner.session,
      `/pairings/${String(pairing.deviceCodeId)}/activation`,
      { satyrLocationId: COUNTER, integrationAccountId: account },
    );
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);

    // Input: the morning batch of cookies arrives at the counter.
    await receiveCookies(organisationId, merchantId, owner.session);

    // 3. A barista sells a cookie; the Terminal takes the card, and
    //    Commerce's alarm reads it and places the order.
    const opened = await counterControl(organisationId, owner.session, "", {
      satyrLocationId: COUNTER,
      checkoutId: "checkout_counter_cookie",
      lines: [
        {
          cartLineId: "cart_line_cookie",
          checkoutLineId: "checkout_line_cookie",
          source: { kind: "catalog", variantId: "variant_sesame_cookie" },
          quantity: { amount: 1, scale: 0, unit: "each" },
        },
      ],
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const rung = await counterSale(organisationId, owner.session);
    const quote = record(rung.quote);
    const collected = await counterControl(
      organisationId,
      owner.session,
      "/checkout_counter_cookie/collection",
      {
        satyrLocationId: COUNTER,
        checkoutRevision: quote.checkoutRevision,
        quoteDigest: quote.quoteDigest,
        amount: quote.amount,
      },
    );
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    let sale = rung;
    for (let round = 0; round < 30 && sale.state !== "complete"; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      sale = await counterSale(organisationId, owner.session);
    }
    expect(sale.state).toBe("complete");
    expect(square.terminalCheckouts).toEqual([
      { deviceId: DEVICE, amount: record(quote.amount).amountMinor },
    ]);

    // 4. The owner refunds the cookie on Square.
    const refunded = await counterControl(
      organisationId,
      owner.session,
      "/checkout_counter_cookie/refund",
      {},
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    expect(
      record(record(record(refunded.body).counterSale).afterSale)
        .refundState,
    ).toBe("completed");

    // 5. A connection from before step 4: Pantry's vault still holds tokens.
    //    The provider check hands them to Commerce once.
    const organisation = requireOrganisation(organisationId);
    const scope = await executionScope(organisation);
    const handle = await credentialHandle(organisationId, account);
    const legacy = await storeOrganisationPlacementVaultSecret({
      scope,
      keys: env,
      handle,
      secret: {
        kind: "oauth_tokens",
        accessToken: "sq-legacy-access",
        refreshToken: "sq-legacy-refresh",
        expiry: { kind: "expires", expiresAt: Date.now() + 20 * 86_400_000 },
      },
      now: Date.now(),
    });
    expect(legacy.ok).toBe(true);
    await reconcileProviderManifestObservations({
      env,
      organisationId: organisation,
      now: Date.now(),
      fetcher: fetch,
    });
    const afterHandOver = await pantryCredential(organisationId, account);
    expect({
      handedTokenUsed: square.sellerReads.includes("sq-legacy-access"),
      credential: afterHandOver,
    }).toEqual({
      handedTokenUsed: true,
      credential: afterConnect,
    });

    // 6. No Square token is anywhere in Pantry's database.
    const tokenRows = await rowsHolding(TOKENS);
    expect(tokenRows).toEqual([]);

    // 7. The owner removes the Square account; Commerce revokes at Square.
    const configurationVersion = async () =>
      String(
        (
          await fixtureDatabase().prepare(
            "SELECT configuration_version AS version FROM organisation_onboarding WHERE organisation_id = ?",
          )
            .bind(organisationId)
            .first<{ version: number }>()
        )?.version ?? 1,
      );
    // Input: the seeded activation above has no activation receipt, which
    // the account routes read; the café is back in setup for the removal.
    await fixtureDatabase().prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'configuring', activation_receipt_id = NULL, activated_at = NULL WHERE organisation_id = ?",
    )
      .bind(organisationId)
      .run();
    const disabled = await exports.default.fetch(
      `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/accounts/${account}/disable`,
      {
        method: "POST",
        headers: {
          ...configurationHeaders(owner.session, "square-disable"),
          "x-satyr-configuration-version": await configurationVersion(),
        },
        body: JSON.stringify({}),
      },
    );
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const removed = await exports.default.fetch(
      `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/accounts/${account}`,
      {
        method: "DELETE",
        headers: {
          ...configurationHeaders(owner.session, "square-remove"),
          "x-satyr-configuration-version": await configurationVersion(),
        },
        body: JSON.stringify({}),
      },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    await reconcileProviderAccountCleanup({
      env,
      organisationId: organisation,
      now: Date.now() + 60_000,
      fetcher: fetch,
    });
    const connection = await env.UNDERCLERK.fetch(
      `http://underclerk.test/v1/admin/merchants/${merchantId}/square/connection`,
      { headers: { authorization: OPERATOR } },
    );
    expect({
      revocations: square.revocations,
      connection: connection.status,
    }).toEqual({
      revocations: [
        { authorization: "Client square-e2e-secret", seller: SELLER },
      ],
      connection: 404,
    });

    task.meta.squareInUnderclerk = {
      codeExchangedBy: "underclerk",
      linkedLocations: [CAFE],
      satyrCredential: { kind: "opaque_profile", holder: "<the merchant>" },
      pairing: "paired_physical",
      counterSale: sale.state,
      terminalCheckouts: square.terminalCheckouts.length,
      refund: "completed",
      legacyHandOver: { handedTokenUsed: true, credential: "delegation" },
      squareTokenRowsInSatyr: tokenRows.length,
      removal: { revocations: square.revocations.length, connection: 404 },
    };
  } finally {
    Object.assign(settings, sandboxApplication);
  }
}

/** Square's production API as the café's seller account answers it. */
class FakeSquare {
  readonly exchanges: Record<string, unknown>[] = [];
  readonly revocations: Record<string, unknown>[] = [];
  readonly sellerReads: string[] = [];
  readonly terminalCheckouts: Record<string, unknown>[] = [];
  #tokens = new Set(["sq-legacy-access"]);
  #paired = false;
  #checkout: Record<string, unknown> | undefined;
  #checkoutReads = 0;

  pair(): void {
    this.#paired = true;
  }

  async answer(
    request: Readonly<{
      url: string;
      method: string;
      headers: Headers;
      text(): Promise<string>;
    }>,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const raw = request.method === "POST" ? await request.text() : "";
    const body: unknown = raw === "" ? null : (JSON.parse(raw) as unknown);
    if (path === "/oauth2/token" && isRecord(body)) {
      if (body.grant_type !== "authorization_code" || body.code !== "square-code-cafe")
        return HttpResponse.json({ errors: [{ code: "invalid_grant" }] }, { status: 400 });
      this.exchanges.push({ code: body.code, clientId: body.client_id });
      this.#tokens.add("sq-access-1");
      return HttpResponse.json({
        access_token: "sq-access-1",
        refresh_token: "sq-refresh-1",
        merchant_id: SELLER,
        token_type: "bearer",
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
    }
    if (path === "/oauth2/revoke" && isRecord(body)) {
      this.revocations.push({
        authorization: request.headers.get("authorization"),
        seller: body.merchant_id,
      });
      this.#tokens.clear();
      return HttpResponse.json({ success: true });
    }
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /u, "");
    if (bearer === undefined || !this.#tokens.has(bearer))
      return HttpResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
    if (path === "/v2/merchants/me") {
      this.sellerReads.push(bearer);
      return HttpResponse.json({
        merchant: { id: SELLER, business_name: "Satyr Café", country: "JP", currency: "JPY" },
      });
    }
    if (path === "/v2/locations")
      return HttpResponse.json({ locations: [location(CAFE, true), location(BACK_OFFICE, false)] });
    if (path.startsWith("/v2/locations/")) {
      const id = path.slice("/v2/locations/".length);
      return HttpResponse.json({ location: location(id, id === CAFE) });
    }
    if (path === "/v2/devices")
      return HttpResponse.json({
        devices: this.#paired
          ? [{ id: DEVICE, attributes: { name: "Front counter" }, status: { category: "AVAILABLE" } }]
          : [],
      });
    if (path === "/v2/devices/codes" || path.startsWith("/v2/devices/codes/"))
      return HttpResponse.json({
        device_code: {
          id: "devcode_front",
          code: "PAIRCAFE",
          name: "Front counter",
          product_type: "TERMINAL_API",
          location_id: CAFE,
          status: this.#paired ? "PAIRED" : "UNPAIRED",
          pair_by: new Date(Date.now() + 5 * 60_000).toISOString(),
          ...(this.#paired ? { device_id: DEVICE } : {}),
        },
      });
    if (path === "/v2/terminals/checkouts" && isRecord(body) && isRecord(body.checkout)) {
      const checkout = body.checkout;
      const options = isRecord(checkout.device_options) ? checkout.device_options : {};
      const money = isRecord(checkout.amount_money) ? checkout.amount_money : {};
      this.terminalCheckouts.push({ deviceId: options.device_id, amount: money.amount });
      this.#checkout = {
        id: "terminal_checkout_cookie",
        reference_id: checkout.reference_id,
        amount_money: checkout.amount_money,
        device_options: checkout.device_options,
        status: "PENDING",
      };
      return HttpResponse.json({ checkout: this.#checkout });
    }
    if (path.startsWith("/v2/terminals/checkouts/") && this.#checkout !== undefined) {
      this.#checkoutReads += 1;
      return HttpResponse.json({
        checkout:
          this.#checkoutReads < 2
            ? this.#checkout
            : { ...this.#checkout, status: "COMPLETED", payment_ids: ["payment_cookie"] },
      });
    }
    if (path === "/v2/payments/payment_cookie" && this.#checkout !== undefined)
      return HttpResponse.json({
        payment: {
          id: "payment_cookie",
          status: "COMPLETED",
          source_type: "CARD",
          location_id: CAFE,
          amount_money: this.#checkout.amount_money,
          reference_id: this.#checkout.reference_id,
          refund_ids: [],
        },
      });
    if (path === "/v2/refunds" && isRecord(body))
      return HttpResponse.json({
        refund: {
          id: "refund_cookie",
          status: "COMPLETED",
          amount_money: body.amount_money,
          payment_id: body.payment_id,
          reason: body.reason,
        },
      });
    return HttpResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
}

function location(id: string, cards: boolean): Record<string, unknown> {
  return {
    id,
    name: id === CAFE ? "Satyr Café counter" : "Back office",
    merchant_id: SELLER,
    country: "JP",
    currency: "JPY",
    status: "ACTIVE",
    capabilities: cards ? ["CREDIT_CARD_PROCESSING"] : [],
  };
}

/** The cafe demo shop and the counter policy of its pickup location. */
async function openCafeCounter(
  organisationId: string,
  merchantId: string,
  owner: Awaited<ReturnType<typeof commerceClient>>,
): Promise<void> {
  const shop = new PlanJourney(organisationId, merchantId, owner.session);
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned));
  const operator = createCommerceClient(env, undefined, { kind: "operator" });
  if (operator === null) throw new Error("No Underclerk client");
  const published = await operator.publishPointOfSaleConfiguration({
    schemaVersion: "underclerk.publish-point-of-sale-configuration.v1",
    merchantId,
    expectedRevision: null,
    publishedAt: new Date().toISOString(),
    publishedBy: owner.identity.userId,
    configuration: {
      configurationId: "pos_configuration_front_counter",
      organisationId,
      satyrLocationId: COUNTER,
      salesChannelId: "sales_channel_cafe",
      currency: "JPY",
      supportedItems: [
        { variantId: "variant_sesame_cookie", maxQuantityPerLine: 6 },
      ],
      quoteTtlSeconds: 900,
      tax: { kind: "percentage", basisPoints: 800 },
      pickupReadyLeadTimeSeconds: 0,
      afterSalePolicy: {
        cancellationPolicyId: "cancellation_counter",
        refundPolicyId: "refund_policy_standard",
        refundGovernance: { kind: "approval_required" },
      },
      presentationPolicy: {
        locale: "ja-JP",
        merchantDisplayName: "Satyr Café",
        termsPolicyId: "terms_counter",
        privacyPolicyId: "privacy_counter",
        supportContact: "support@example.test",
      },
    },
  });
  if (!published.ok) throw new Error(JSON.stringify(published.error));
}

/** Staff receive a lot of twelve cookies at the counter location. */
async function receiveCookies(
  organisationId: string,
  merchantId: string,
  session: IssuedControlSession,
): Promise<void> {
  const operator = createCommerceClient(env, undefined, { kind: "operator" });
  if (operator === null) throw new Error("No Underclerk client");
  const stock = await operator.readStockSnapshot(merchantId);
  if (!stock.ok) throw new Error(JSON.stringify(stock.error));
  const position = stock.value.commerce.resources.inventoryPositions.find(
    (candidate) =>
      candidate.inventoryItemId === "inventory_sesame_cookie" &&
      candidate.locationId === COUNTER,
  );
  if (position === undefined) throw new Error("No cookie position");
  const read = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/inventory/receipts?position=${position.id}`,
    {
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: PUBLIC_ORIGIN,
      },
    },
  );
  const answer = record(await read.json());
  expect(read.status, JSON.stringify(answer)).toBe(200);
  const context = record(answer.context);
  const received = await post(
    `/v1/control/organisations/${organisationId}/commerce/inventory/receipts`,
    session,
    {
      merchantRevision: context.merchantRevision,
      inventoryItemId: context.inventoryItemId,
      inventoryItemRevision: context.inventoryItemRevision,
      inventoryPositionId: context.inventoryPositionId,
      inventoryPositionRevision: context.inventoryPositionRevision,
      locationId: context.locationId,
      receivedQuantity: { amount: 12, scale: 0, unit: context.unit },
      purchase: { kind: "unlinked" },
      lot: {
        kind: "tracked",
        lotId: "lot_morning_cookies",
        lotCode: "morning-cookies",
        expiry: {
          kind: "expires",
          expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
      },
      receiptId: "receipt_morning_cookies",
      receiptLineId: "1",
      receivedAt: new Date().toISOString(),
    },
  );
  expect(received.status, JSON.stringify(received.body)).toBe(200);
}

async function connectSquare(
  organisationId: string,
  session: IssuedControlSession,
): Promise<void> {
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/providers/square/start`,
    {
      method: "POST",
      headers: configurationHeaders(session, "square-cafe-connect"),
      body: JSON.stringify({ returnPath: `/portal/${organisationId}` }),
    },
  );
  expect(started.status, await started.clone().text()).toBe(201);
  const start = (await started.json()) as { authorization_url: string };
  const state = new URL(start.authorization_url).searchParams.get("state");
  if (state === null) throw new Error("The authorization has no state");
  const callback = new URL(
    `${PUBLIC_ORIGIN}/v1/control/providers/square/callback`,
  );
  callback.searchParams.set("code", "square-code-cafe");
  callback.searchParams.set("state", state);
  const completed = await exports.default.fetch(callback.toString());
  await expect(completed.text()).resolves.toContain(
    "satyr.provider-attempt.completed",
  );
}

async function squareAccount(organisationId: string): Promise<string> {
  const row = await fixtureDatabase().prepare(
    "SELECT integration_account_id AS id FROM integration_account WHERE organisation_id = ? AND provider = 'square' AND lifecycle IN ('active', 'degraded')",
  )
    .bind(organisationId)
    .first<{ id: string }>();
  if (row === null) throw new Error("No Square account");
  return row.id;
}

async function credentialHandle(organisationId: string, account: string) {
  const row = await fixtureDatabase().prepare(
    `SELECT connection.credential_ref AS handle FROM integration_account AS account
     JOIN provider_connection AS connection
       ON connection.provider_connection_id = account.provider_connection_id
     WHERE account.organisation_id = ? AND account.integration_account_id = ?`,
  )
    .bind(organisationId, account)
    .first<{ handle: string }>();
  if (row === null) throw new Error("No Square connection");
  return row.handle as Parameters<
    typeof storeOrganisationPlacementVaultSecret
  >[0]["handle"];
}

/** What Pantry's vault holds for the Square connection. */
async function pantryCredential(
  organisationId: string,
  account: string,
): Promise<Record<string, unknown>> {
  const organisation = requireOrganisation(organisationId);
  const scope = await executionScope(organisation);
  const integrationAccountId = parseIntegrationAccountId(account);
  if (!integrationAccountId.ok) throw new Error("Invalid account");
  const resolved = await resolveProviderManifestCredential({
    db: scope.database,
    keys: env,
    organisationId: organisation,
    integrationAccountId: integrationAccountId.value,
    provider: "square",
    environment: "production",
    providerAccountId: SELLER,
    credentialRef: await credentialHandle(organisationId, account),
  });
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  const secret = resolved.value;
  return secret.kind === "opaque_profile"
    ? {
        kind: secret.kind,
        format: secret.format,
        holder: JSON.parse(secret.value) as unknown,
      }
    : { kind: secret.kind };
}

/** Every row of Pantry's two databases that holds one of the values in clear. */
async function rowsHolding(values: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const database of new Set([env.DB, fixtureDatabase()])) {
    const tables = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>();
    for (const { name } of tables.results) {
      const rows = await database.prepare(`SELECT * FROM "${name}"`).all();
      for (const row of rows.results) {
        const text = JSON.stringify(row);
        if (values.some((value) => text.includes(value))) found.push(name);
      }
    }
  }
  return found;
}

async function refreshResources(
  organisationId: string,
  session: IssuedControlSession,
  account: string,
): Promise<void> {
  const version = await fixtureDatabase().prepare(
    "SELECT configuration_version AS version FROM organisation_onboarding WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first<{ version: number }>();
  const refreshed = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/accounts/${account}/resources/refresh`,
    {
      method: "POST",
      headers: {
        ...configurationHeaders(session, "square-cafe-resources"),
        "x-satyr-configuration-version": String(version?.version ?? 1),
      },
      body: JSON.stringify({}),
    },
  );
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
}

async function counterSale(
  organisationId: string,
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/counter-sales/checkout_counter_cookie`,
    {
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: PUBLIC_ORIGIN,
      },
    },
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return record(record(body).counterSale);
}

function terminalControl(
  organisationId: string,
  session: IssuedControlSession,
  suffix: string,
  body: Record<string, unknown>,
) {
  return post(
    `/v1/control/organisations/${organisationId}/commerce/terminal-operations${suffix}`,
    session,
    body,
  );
}

function counterControl(
  organisationId: string,
  session: IssuedControlSession,
  suffix: string,
  body: Record<string, unknown>,
) {
  return post(
    `/v1/control/organisations/${organisationId}/commerce/counter-sales${suffix}`,
    session,
    body,
  );
}

async function post(
  path: string,
  session: IssuedControlSession,
  body: Record<string, unknown>,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(`${PUBLIC_ORIGIN}${path}`, {
    method: "POST",
    headers: configurationHeaders(session, crypto.randomUUID()),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function requireOrganisation(raw: string): OrganisationId {
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) throw new Error("Invalid organisation");
  return parsed.value;
}

async function executionScope(organisationId: OrganisationId) {
  const resolved = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.value;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Not a record: ${String(value)}`);
  return value;
}
