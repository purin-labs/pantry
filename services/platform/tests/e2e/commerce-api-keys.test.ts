import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import {
  COMMERCE_API_SCOPES,
  CommerceAdminClient,
  type CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import {
  parseInventoryReceiptContext,
  type InventoryReceiptContext,
} from "@purin-labs/kitchen-control-api";
import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

declare module "vitest" {
  interface TaskMeta {
    commerceApiKeys?: Record<string, unknown>;
  }
}

const OPERATOR = "Bearer underclerk-e2e-token";

it(
  "lets an owner give the shop's own systems a scoped key, and names the key or the member on each stock change",
  { timeout: 180_000 },
  commerceApiKeysJourney,
);

/**
 * Plan 80 step 3. A café installed Pantry before merchant keys existed, so
 * Pantry's installation cannot manage keys. The owner creates a key for the
 * café's stock system in the Portal; Pantry widens its own installation and
 * the key exists. The key corrects a stock count on Commerce, and the
 * receipt names the key. The owner corrects a count in the Portal, and the
 * receipt names the owner. The key opens nothing of a second shop, a key
 * cannot record payments, a viewer cannot see or create keys, and a retry of
 * the create request does not show the secret again. When the owner revokes
 * the key, the key stops at once.
 */
async function commerceApiKeysJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`api-keys-owner-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`api-keys-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "API keys café");
  const merchantId = `merchant_api_keys_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
    { installSatyr: false },
  );
  // Pantry's installation from before Plan 80 step 3.
  const before = COMMERCE_API_SCOPES.filter(
    (scope) => scope !== "credentials:write",
  );
  await operator(`${merchantId}/app-installations/satyr`, "PUT", {
    scopes: before,
    externalReference: organisationId,
    label: "Satyr",
  });
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_api_keys_viewer', 'Viewer')",
      )
      .bind(organisationId),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_api_keys_viewer', 'viewer', 'active', ?, NULL)",
      )
      .bind(organisationId, viewer.identity.userId, Date.now()),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { privateMember: viewer },
  });
  const native = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  const provisioned = await native.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);
  const portal = (
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
    session: IssuedControlSession = owner.session,
    key: string = crypto.randomUUID(),
  ) => {
    const headers = commerceHeaders(session);
    headers.set("idempotency-key", key);
    return exports.default.fetch(
      `https://localhost/v1/control/organisations/${organisationId}/commerce${suffix}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  };

  // 1. The owner creates a key for the stock system.
  const created = await answer(
    portal(
      "POST",
      "/api-keys",
      { label: "Stock system", scopes: ["inventory:read", "inventory:write"] },
      owner.session,
      "create-stock-key",
    ),
  );
  expect(created.status).toBe(200);
  const apiKey = record(created.body.apiKey);
  const secret = created.body.key;
  if (typeof secret !== "string" || typeof apiKey.credentialId !== "string")
    throw new Error(`Key missing: ${JSON.stringify(created.body)}`);
  const pantryScopes = (await credentials(merchantId)).find(
    (entry) => entry.appId === "satyr" && !entry.revoked,
  )?.scopes;
  expect(pantryScopes).toEqual([...COMMERCE_API_SCOPES]);
  const retried = await answer(
    portal(
      "POST",
      "/api-keys",
      { label: "Stock system", scopes: ["inventory:read", "inventory:write"] },
      owner.session,
      "create-stock-key",
    ),
  );
  expect({
    status: retried.status,
    sameKey: record(retried.body.apiKey).credentialId === apiKey.credentialId,
    secretShown: "key" in retried.body,
  }).toEqual({ status: 200, sameKey: true, secretShown: false });

  // 2. The key corrects a count on Commerce; the owner corrects one in
  // the Portal. Each receipt names who acted.
  const keyClient = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: secret,
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  const context = async (positionId: string) =>
    parseInventoryReceiptContext(
      (
        await answer(
          portal("GET", `/inventory/receipts?position=${positionId}`),
        )
      ).body,
    );
  const positionId = await countedPosition(
    await required(native.readStockSnapshot(merchantId)),
    context,
  );
  const { merchantRevision, ...counted } = correction(
    await context(positionId),
  );
  const byKey = await required(
    keyClient.reconcileInventory({
      merchantId,
      idempotencyKey: "count_by_stock_system",
      expectedMerchantRevision: merchantRevision,
      ...counted,
    }),
  );
  const ownerPerson = await fixtureDatabase()
    .prepare(
      "SELECT person_id FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND status = 'active'",
    )
    .bind(organisationId, owner.identity.userId)
    .first<string>("person_id");
  const byOwner = await answer(
    portal("POST", "/inventory/reconciliations", {
      ...correction(await context(positionId)),
      requestedAt: new Date().toISOString(),
    }),
  );
  expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
  const actors = {
    key: actorOf(byKey),
    owner: actorOf(record(byOwner.body.result)),
  };
  expect(actors).toEqual({
    key: { kind: "api_key", credentialId: apiKey.credentialId },
    owner: { kind: "app", appId: "satyr", person: ownerPerson },
  });

  // 3. What the key and the people may not do.
  const neighbour = await commerceClient(
    `api-keys-neighbour-${crypto.randomUUID()}`,
  );
  const neighbourOrganisation = await commerceWorkspace(
    neighbour,
    "Neighbour shop",
  );
  const neighbourMerchant = `merchant_api_keys_neighbour_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    neighbourOrganisation,
    neighbour.identity.userId,
    neighbourMerchant,
  );
  const refusals = {
    keyOnNeighbourShop: await httpStatus(
      keyClient.readStockSnapshot(neighbourMerchant),
    ),
    paymentsScope: (
      await answer(
        portal("POST", "/api-keys", {
          label: "Payments",
          scopes: ["payments:record"],
        }),
      )
    ).body.error,
    viewerLists: (await portal("GET", "/api-keys", undefined, viewer.session))
      .status,
    viewerCreates: (
      await portal(
        "POST",
        "/api-keys",
        { label: "Mine", scopes: ["inventory:read"] },
        viewer.session,
      )
    ).status,
  };
  expect(refusals).toEqual({
    keyOnNeighbourShop: 401,
    paymentsScope: "api_key_rejected",
    // The Platform hides commerce settings from a member without the role.
    viewerLists: 404,
    viewerCreates: 404,
  });

  // 4. The owner revokes the key; the key stops at once.
  const revoked = await answer(
    portal("POST", `/api-keys/${apiKey.credentialId}/revocation`, {}),
  );
  expect(revoked.status).toBe(200);
  const afterRevoke = await httpStatus(keyClient.readStockSnapshot(merchantId));
  expect(afterRevoke).toBe(401);
  const listed = await answer(portal("GET", "/api-keys"));
  const keys = Array.isArray(listed.body.apiKeys)
    ? listed.body.apiKeys.filter(isRecord).map((entry) => ({
        label: entry.label,
        scopes: entry.scopes,
        revoked: entry.revokedAt !== null,
      }))
    : null;
  expect(keys).toEqual([
    {
      label: "Stock system",
      scopes: ["inventory:read", "inventory:write"],
      revoked: true,
    },
  ]);

  // Ids are random; the evidence names them by role.
  task.meta.commerceApiKeys = {
    satyrInstallationAfterFirstKey: pantryScopes,
    retryShowsSecret: false,
    actors: {
      key: { kind: "api_key", credentialId: "<the stock system key>" },
      owner: { kind: "app", appId: "satyr", person: "<the owner>" },
    },
    refusals,
    afterRevoke,
    keys,
  };
}

/** A counted lot of the demo café, as the Portal shows it to staff. */
async function countedPosition(
  stock: CommerceStockSnapshot,
  context: (positionId: string) => Promise<InventoryReceiptContext>,
): Promise<string> {
  for (const position of stock.commerce.resources.inventoryPositions) {
    if (position.balance.kind !== "accounted") continue;
    if ((await context(position.id)).lots.length > 0) return position.id;
  }
  throw new Error("The demo café has no counted lot");
}

/** One more unit found at a count, at the lot's current revisions. */
function correction(context: InventoryReceiptContext) {
  const lot = context.lots[0];
  if (lot === undefined) throw new Error("Counted lot missing");
  return {
    merchantRevision: context.merchantRevision,
    inventoryPositionId: context.inventoryPositionId,
    inventoryPositionRevision: context.inventoryPositionRevision,
    target: { kind: "lot" as const, lotId: lot.id, lotRevision: lot.revision },
    change: {
      kind: "adjustment" as const,
      direction: "increase" as const,
      reason: "correction" as const,
      quantity: { amount: 1, scale: 0, unit: context.unit },
      explanation: "One more found at the evening count",
    },
  };
}

function actorOf(result: unknown): unknown {
  const value = record(result);
  if (value.outcome !== "applied")
    throw new Error(`Change not applied: ${JSON.stringify(value)}`);
  return record(value.receipt).actor;
}

async function operator(path: string, method: "PUT", body: unknown) {
  const response = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${path}`,
    {
      method,
      headers: { authorization: OPERATOR, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

/** The operator's list of a merchant's credentials, without ids or times. */
async function credentials(merchantId: string) {
  const response = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}/api-credentials`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.credentials))
    throw new Error(`Credential list failed: ${JSON.stringify(body)}`);
  return body.credentials.filter(isRecord).map((entry) => ({
    appId: entry.appId,
    scopes: entry.scopes,
    revoked: entry.revokedAt !== null,
  }));
}

async function answer(pending: Promise<Response>) {
  const response = await pending;
  return { status: response.status, body: record(await response.json()) };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`Not a record: ${String(value)}`);
  return value;
}

async function required<T>(
  result: Promise<
    Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>
  >,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  return resolved.value;
}

async function httpStatus(
  result: Promise<
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: { kind: string; status?: number } }>
  >,
): Promise<number | "ok" | "other"> {
  const resolved = await result;
  if (resolved.ok) return "ok";
  return resolved.error.kind === "http" && resolved.error.status !== undefined
    ? resolved.error.status
    : "other";
}
