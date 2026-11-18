// Refactor 15: a merchant removes Pantry at the provider. Shopify's
// `app/uninstalled` and Stripe's `account.application.deauthorized` take the
// account through the credential revocation, as an operator's revoke does:
// the account, its connection and its webhooks are revoked, the Vault secret
// is revoked, and one revocation is recorded. A signed order body with a
// changed topic, an event of another application and an event for an unknown
// account change nothing. A repeated event records no second revocation.
// Each journey asserts one evidence object that repeats for the same commit.
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

import { bytesToHex, encodeBase64 } from "@seams/std";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { storeVaultSecret, type VaultHandle } from "../../src/credential-vault";
import { upsertUser, type User } from "../../src/data/control-plane";
import {
  newControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "../../src/data/control-mutation";
import {
  createActiveConnectedIntegration,
  requireConnectionCredentialAuthority,
  upsertProviderWebhook,
} from "../../src/data/integration-account";
import type { OrganisationId } from "../../src/ids";
import { parseInitialOrganisationPlacement } from "../../src/placement";
import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { requireVaultHandle } from "../test-ids";
import { fixtureDatabase } from "./organisation-database";

const ORIGIN = "https://localhost";
const SHOP = "removed-access-e2e.myshopify.com";
const SHOP_SECRET = "shopify-removed-access-secret";
const STRIPE_ACCOUNT = "acct_removedaccesse2e";
// The Connect webhook of the E2E Worker (vitest.e2e.config.ts).
const CONNECT_WEBHOOK_ID = "we_e2e";
const CONNECT_WEBHOOK_SECRET = "whsec_e2e";
const CONNECT_CLIENT_ID = "stripe-e2e-client";

type Seeded = Readonly<{
  organisationId: OrganisationId;
  credentialRef: VaultHandle;
}>;

it("revokes a Shopify account when the merchant uninstalls the app", async () => {
  const seeded = await seed({
    provider: "shopify",
    providerAccountId: SHOP,
    nativeId: "wh_removed_access_e2e",
    signingSecret: {
      kind: "header",
      header: "x-shopify-hmac-sha256",
      value: SHOP_SECRET,
    },
  });
  const url = `${ORIGIN}/hook/shopify/${seeded.organisationId}`;
  const uninstalled = JSON.stringify({
    id: 690_933_842,
    name: "Removed Access Café",
    domain: "cafe.example",
    myshopify_domain: SHOP,
  });
  const send = async (
    body: string,
    topic: string,
    shop = SHOP,
  ): Promise<number> => {
    const response = await exports.default.fetch(url, {
      method: "POST",
      headers: {
        "x-shopify-api-version": "2026-07",
        "x-shopify-shop-domain": shop,
        "x-shopify-topic": topic,
        "x-shopify-triggered-at": "2026-11-06T00:00:00.000Z",
        "x-shopify-webhook-id": "wh_removed_access_e2e",
        "x-shopify-hmac-sha256": await hmac(SHOP_SECRET, body, "base64"),
      },
      body,
    });
    await response.body?.cancel();
    return response.status;
  };

  // 1. Shopify does not sign the topic: a signed order body sent as an
  //    uninstall revokes nothing.
  const order = JSON.stringify({ id: 42, name: "#1042", total_price: "1.00" });
  const forged = await send(order, "app/uninstalled");
  // 2. An uninstall for a shop that this Organisation did not connect.
  const unknown = await send(
    JSON.stringify({ id: 1, myshopify_domain: "unknown-e2e.myshopify.com" }),
    "app/uninstalled",
    "unknown-e2e.myshopify.com",
  );
  const before = await authority(seeded, "shopify");
  // 3. The merchant uninstalls the app.
  const removed = await send(uninstalled, "app/uninstalled");
  const after = await authority(seeded, "shopify");
  // 4. Shopify repeats the event, and a later order event arrives.
  const repeated = await send(uninstalled, "app/uninstalled");
  const laterOrder = await send(order, "orders/create");
  const afterRepeat = await authority(seeded, "shopify");

  const evidence = {
    responses: { forged, unknown, removed, repeated, laterOrder },
    before,
    after,
    afterRepeat,
  };
  expect(evidence).toEqual({
    responses: {
      forged: 400,
      unknown: 404,
      removed: 200,
      repeated: 404,
      laterOrder: 404,
    },
    before: LIVE,
    after: REVOKED,
    afterRepeat: REVOKED,
  });
});

it("revokes a Stripe account when the seller deauthorizes the application", async () => {
  const seeded = await seed({
    provider: "stripe",
    providerAccountId: STRIPE_ACCOUNT,
    nativeId: CONNECT_WEBHOOK_ID,
    signingSecret: {
      kind: "header",
      header: "stripe-signing-secret",
      value: CONNECT_WEBHOOK_SECRET,
    },
  });
  const send = async (
    event: Readonly<{ account: string; application: string }>,
    secret = CONNECT_WEBHOOK_SECRET,
  ): Promise<Readonly<{ status: number; body: unknown }>> => {
    const timestamp = Math.floor(Date.now() / 1_000);
    const body = JSON.stringify({
      id: "evt_removed_access_e2e",
      object: "event",
      type: "account.application.deauthorized",
      account: event.account,
      created: timestamp,
      data: {
        object: {
          id: event.application,
          object: "application",
          name: "Satyr",
        },
      },
    });
    const signature = await hmac(secret, `${timestamp}.${body}`, "hex");
    const response = await exports.default.fetch(
      `${ORIGIN}/hook/stripe/connect`,
      {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body,
      },
    );
    const answer: unknown = await response.json();
    const reply =
      typeof answer === "object" && answer !== null
        ? Object.fromEntries(
            Object.entries(answer).filter(([key]) => key !== "requestId"),
          )
        : answer;
    return { status: response.status, body: reply };
  };
  const ours = { account: STRIPE_ACCOUNT, application: CONNECT_CLIENT_ID };

  // 1. A signature that is not Stripe's, an event of another application,
  //    and an event for a Stripe account that no Organisation connected.
  const unsigned = await send(ours, "whsec_notstripe");
  const another = await send({ ...ours, application: "ca_another" });
  const unknown = await send({ ...ours, account: "acct_unknowne2e" });
  const before = await authority(seeded, "stripe");
  // 2. The seller deauthorizes Pantry's application.
  const removed = await send(ours);
  const after = await authority(seeded, "stripe");
  // 3. Stripe repeats the event.
  const repeated = await send(ours);
  const afterRepeat = await authority(seeded, "stripe");

  const evidence = {
    responses: {
      unsigned: unsigned.status,
      another: another.body,
      unknown: unknown.body,
      removed: removed.body,
      repeated: repeated.body,
    },
    before,
    after,
    afterRepeat,
  };
  expect(evidence).toEqual({
    responses: {
      unsigned: 401,
      another: { ok: true, ignored: true },
      unknown: { ok: true, ignored: true },
      removed: { ok: true, revoked: 1 },
      repeated: { ok: true, ignored: true },
    },
    before: LIVE,
    after: REVOKED,
    afterRepeat: REVOKED,
  });
});

const LIVE = {
  account: "active",
  connection: "active",
  webhook: "live",
  vaultSecretRevoked: 0,
  revocations: [],
};
const REVOKED = {
  account: "revoked",
  connection: "revoked",
  webhook: "revoked",
  vaultSecretRevoked: 1,
  revocations: [{ state: "policy_activated", integrationAccounts: 1 }],
};

async function authority(
  seeded: Seeded,
  provider: "shopify" | "stripe",
): Promise<unknown> {
  const db = fixtureDatabase();
  const row = await db
    .prepare(
      `SELECT
         (SELECT lifecycle FROM integration_account
          WHERE organisation_id = ?1 AND provider = ?2) AS account,
         (SELECT lifecycle FROM provider_connection
          WHERE organisation_id = ?1 AND provider = ?2) AS connection,
         (SELECT lifecycle FROM provider_webhook
          WHERE organisation_id = ?1 AND provider = ?2) AS webhook,
         (SELECT COUNT(*) FROM vault_secret
          WHERE organisation_id = ?1 AND vault_handle = ?3
            AND revoked_at IS NOT NULL) AS vaultSecretRevoked`,
    )
    .bind(seeded.organisationId, provider, seeded.credentialRef)
    .first<Record<string, unknown>>();
  const revocations = await db
    .prepare(
      `SELECT state, integration_account_count AS integrationAccounts
       FROM credential_revocation_operation
       WHERE organisation_id = ? ORDER BY revocation_id`,
    )
    .bind(seeded.organisationId)
    .all<Record<string, unknown>>();
  return { ...row, revocations: revocations.results };
}

async function seed(
  input: Readonly<{
    provider: "shopify" | "stripe";
    providerAccountId: string;
    nativeId: string;
    signingSecret: Parameters<typeof storeVaultSecret>[0]["secret"];
  }>,
): Promise<Seeded> {
  const now = Date.now() - 1_000;
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `removed-access-${input.provider}`,
      email: `${input.provider}-removed-access@e2e.example`,
      displayName: `${input.provider} Removed Access Owner`,
      emailVerified: true,
    },
    now,
  });
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const organisation = await requireOrganisationBootstrap({
    env,
    owner,
    organisationName: `${input.provider} Removed Access`,
    environment: "development",
    placement: placement.value,
    mutation: bootstrapMutation(owner, now),
    now,
  });
  const organisationId = organisation.organisationId;
  // The Organisation's actor publishes the policy that a revocation needs.
  const actor = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  await actor.ensureOrganisation({
    organisationId,
    name: `${input.provider} Removed Access`,
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  await fixtureDatabase()
    .prepare(
      `UPDATE organisation_onboarding
       SET lifecycle = 'active', activation_receipt_id = ?, activated_at = ?, updated_at = ?
       WHERE organisation_id = ? AND lifecycle = 'configuring'`,
    )
    .bind(`activation_receipt_${crypto.randomUUID()}`, now, now, organisationId)
    .run();
  const prefix = `vault:${organisationId.toLowerCase()}:${input.provider}:e2e`;
  const credentialRef = requireVaultHandle(`${prefix}:api`);
  const signingSecretRef = requireVaultHandle(`${prefix}:webhook`);
  await store(
    organisationId,
    credentialRef,
    {
      kind: "bearer",
      value:
        input.provider === "stripe"
          ? "sk_test_removed_access_credential"
          : "shpat_removed_access_credential",
    },
    now,
  );
  await store(organisationId, signingSecretRef, input.signingSecret, now);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId,
    provider: input.provider,
    providerSubjectId: input.providerAccountId,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes:
      input.provider === "stripe" ? ["read_write"] : ["read_orders"],
    createdByUserId: owner.userId,
    providerAccountId: input.providerAccountId,
    accountKind: input.provider === "stripe" ? "merchant_account" : "store",
    displayName: `${input.provider} Removed Access`,
    capabilities:
      input.provider === "stripe" ? ["payments.read"] : ["orders.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  await upsertProviderWebhook({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    provider: input.provider,
    environment: "development",
    providerNativeId: input.nativeId,
    eventType: "commerce_events",
    signingSecretRef,
    credentialGeneration: requireConnectionCredentialAuthority(
      connected.connection,
    ).credentialGeneration,
    lifecycle: { kind: "live", lastVerifiedAt: now },
    now,
  });
  return { organisationId, credentialRef };
}

function bootstrapMutation(owner: User, now: number) {
  const scope: ControlMutationReceiptScope = {
    userId: owner.userId,
    organisationScope: "organisation:create",
    route: "/v1/control/organisations",
    operation: "organisation.create",
  };
  return {
    scope,
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: `removed-access-${crypto.randomUUID()}`,
      requestHash: "removed-access-bootstrap",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "removed-access-owner",
      causationId: `removed-access-${crypto.randomUUID()}`,
      now,
    }),
  };
}

async function store(
  organisationId: OrganisationId,
  handle: VaultHandle,
  secret: Parameters<typeof storeVaultSecret>[0]["secret"],
  now: number,
): Promise<void> {
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId,
    handle,
    secret,
    now,
  });
  if (!stored.ok) throw new Error(`secret store failed: ${stored.error.code}`);
}

async function hmac(
  secret: string,
  message: string,
  encoding: "hex" | "base64",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return encoding === "hex" ? bytesToHex(bytes) : encodeBase64(bytes);
}
