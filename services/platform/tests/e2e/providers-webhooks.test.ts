import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

import { upsertUser, type User } from "../../src/data/control-plane";
import {
  createActiveConnectedIntegration,
  requireConnectionCredentialAuthority,
  upsertProviderWebhook,
  type ActiveIntegrationAccount,
} from "../../src/data/integration-account";
import {
  newControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "../../src/data/control-mutation";
import { storeVaultSecret, type VaultHandle } from "../../src/credential-vault";
import type { OrganisationId } from "../../src/ids";
import { parseInitialOrganisationPlacement } from "../../src/placement";
import type { VariantBy } from "@seams/type-utils";
import { assertNever, bytesToHex, encodeBase64 } from "@seams/std";
import { requireVaultHandle } from "../test-ids";

const PUBLIC_ORIGIN = "https://localhost";

type WebhookCase =
  | Readonly<{
      provider: "stripe";
      providerAccountId: "acct_webhook_e2e";
      signingSecret: "whsec_webhook_e2e";
      credential: "sk_test_webhook_e2e_credential";
      expectedInvalidError: "stripe_signature_invalid";
    }>
  | Readonly<{
      provider: "shopify";
      providerAccountId: "webhook-e2e.myshopify.com";
      signingSecret: "shopify-webhook-e2e-secret";
      credential: "shpat_webhook_e2e_credential";
      expectedInvalidError: "shopify_signature_invalid";
    }>;

type WebhookScenario = Readonly<{
  organisationId: OrganisationId;
  account: ActiveIntegrationAccount;
  signingSecretRef: VaultHandle;
}>;

type SignedWebhook = Readonly<{
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  invalidHeaders: Readonly<Record<string, string>>;
}>;

const WEBHOOK_CASES: readonly WebhookCase[] = [
  {
    provider: "stripe",
    providerAccountId: "acct_webhook_e2e",
    signingSecret: "whsec_webhook_e2e",
    credential: "sk_test_webhook_e2e_credential",
    expectedInvalidError: "stripe_signature_invalid",
  },
  {
    provider: "shopify",
    providerAccountId: "webhook-e2e.myshopify.com",
    signingSecret: "shopify-webhook-e2e-secret",
    credential: "shpat_webhook_e2e_credential",
    expectedInvalidError: "shopify_signature_invalid",
  },
];

const TEST_PLACEMENT = requireTestPlacement();

it.each(WEBHOOK_CASES)(
  "$provider verifies and admits its signed public webhook",
  signedWebhookContract,
);

async function signedWebhookContract(row: WebhookCase): Promise<void> {
  const scenario = await seedActiveWebhookScenario(row);
  const webhook = await signedWebhook(row, scenario.organisationId);

  const rejected = await postWebhook(
    webhook.url,
    webhook.body,
    webhook.invalidHeaders,
  );
  expect(rejected.status).toBe(401);
  await expect(rejected.json()).resolves.toMatchObject({
    ok: false,
    error: { code: row.expectedInvalidError },
  });

  const accepted = await postWebhook(
    webhook.url,
    webhook.body,
    webhook.headers,
  );
  expect(accepted.status).toBe(200);
  const acceptedBody = await accepted.text();
  expect(JSON.parse(acceptedBody)).toMatchObject({ ok: true });
  expect(acceptedBody).not.toContain(row.signingSecret);
  expect(acceptedBody).not.toContain(row.credential);

  const replayed = await postWebhook(
    webhook.url,
    webhook.body,
    webhook.headers,
  );
  expect(replayed.status).toBe(200);
  await expect(replayed.json()).resolves.toMatchObject({ ok: true });

  await assertWebhookAuthorityUnchanged(row, scenario);
}

async function seedActiveWebhookScenario(
  row: WebhookCase,
): Promise<WebhookScenario> {
  const now = Date.now() - 1_000;
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `webhook-e2e-${row.provider}`,
      email: `${row.provider}-webhook@e2e.example`,
      displayName: `${row.provider} Webhook E2E Owner`,
      emailVerified: true,
    },
    now,
  });
  const organisation = await requireOrganisationBootstrap({
    env,
    owner,
    organisationName: `${row.provider} Webhook E2E`,
    environment: "development",
    placement: TEST_PLACEMENT,
    mutation: organisationBootstrapMutation(owner, now),
    now,
  });
  await activateOrganisationForWebhook(organisation.organisationId, now);

  const credentialRef = requireVaultHandle(
    `vault:${organisation.organisationId.toLowerCase()}:${row.provider}:e2e:api`,
  );
  const signingSecretRef = requireVaultHandle(
    `vault:${organisation.organisationId.toLowerCase()}:${row.provider}:e2e:webhook`,
  );
  await storeTestSecret(
    organisation.organisationId,
    credentialRef,
    { kind: "bearer", value: row.credential },
    now,
  );
  await storeTestSecret(
    organisation.organisationId,
    signingSecretRef,
    row.provider === "stripe"
      ? {
          kind: "header",
          header: "stripe-signing-secret",
          value: row.signingSecret,
        }
      : {
          kind: "header",
          header: "x-shopify-hmac-sha256",
          value: row.signingSecret,
        },
    now,
  );

  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: organisation.organisationId,
    provider: row.provider,
    providerSubjectId: row.providerAccountId,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes:
      row.provider === "stripe"
        ? ["read_write"]
        : ["read_orders", "write_orders"],
    createdByUserId: owner.userId,
    providerAccountId: row.providerAccountId,
    accountKind: row.provider === "stripe" ? "merchant_account" : "store",
    displayName: `${row.provider} Webhook E2E`,
    capabilities:
      row.provider === "stripe"
        ? ["payments.read"]
        : ["orders.read", "orders.events"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  await upsertProviderWebhook({
    db: fixtureDatabase(),
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    provider: row.provider,
    environment: "development",
    providerNativeId:
      row.provider === "stripe" ? "we_webhook_e2e" : "wh_webhook_e2e",
    eventType: "commerce_events",
    signingSecretRef,
    credentialGeneration: requireConnectionCredentialAuthority(
      connected.connection,
    ).credentialGeneration,
    lifecycle: { kind: "live", lastVerifiedAt: now },
    now,
  });
  return {
    organisationId: organisation.organisationId,
    account: connected.account,
    signingSecretRef,
  };
}

function organisationBootstrapMutation(owner: User, now: number) {
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
      idempotencyKey: `webhook-e2e-${crypto.randomUUID()}`,
      requestHash: "webhook-e2e-bootstrap",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "webhook-e2e-owner",
      causationId: `webhook-e2e-${crypto.randomUUID()}`,
      now,
    }),
  };
}

async function activateOrganisationForWebhook(
  organisationId: OrganisationId,
  now: number,
): Promise<void> {
  await fixtureDatabase()
    .prepare(
      `UPDATE organisation_onboarding
     SET lifecycle = 'active', activation_receipt_id = ?, activated_at = ?, updated_at = ?
     WHERE organisation_id = ? AND lifecycle = 'configuring'`,
    )
    .bind(
      `activation_receipt_webhook_${crypto.randomUUID()}`,
      now,
      now,
      organisationId,
    )
    .run();
}

async function storeTestSecret(
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
  if (!stored.ok)
    throw new Error(`test secret store failed: ${stored.error.code}`);
}

async function signedWebhook(
  row: WebhookCase,
  organisationId: OrganisationId,
): Promise<SignedWebhook> {
  switch (row.provider) {
    case "stripe":
      return signedStripeWebhook(row, organisationId);
    case "shopify":
      return signedShopifyWebhook(row, organisationId);
    default:
      return assertNever(row, "unexpected webhook row");
  }
}

async function signedStripeWebhook(
  row: VariantBy<WebhookCase, "provider", "stripe">,
  organisationId: OrganisationId,
): Promise<SignedWebhook> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const body = JSON.stringify({
    id: "evt_webhook_e2e",
    type: "charge.failed",
    created: timestamp,
    data: {
      object: {
        id: "ch_webhook_e2e",
        amount: 1_250,
        currency: "usd",
        failure_code: "card_declined",
        failure_message: "The card was declined.",
      },
    },
  });
  const signature = await hmac(
    row.signingSecret,
    `${timestamp}.${body}`,
    "hex",
  );
  return {
    url: `${PUBLIC_ORIGIN}/hook/stripe/${organisationId}`,
    body,
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    invalidHeaders: {
      "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)}`,
    },
  };
}

async function signedShopifyWebhook(
  row: VariantBy<WebhookCase, "provider", "shopify">,
  organisationId: OrganisationId,
): Promise<SignedWebhook> {
  const body = JSON.stringify({
    id: 42,
    name: "#1042",
    total_price: "125.50",
    currency: "USD",
    financial_status: "paid",
  });
  const signature = await hmac(row.signingSecret, body, "base64");
  const common = {
    "x-shopify-api-version": "2026-07",
    "x-shopify-shop-domain": row.providerAccountId,
    "x-shopify-topic": "orders/create",
    "x-shopify-triggered-at": "2026-08-24T00:00:00.000Z",
    "x-shopify-webhook-id": "wh_webhook_e2e",
  };
  return {
    url: `${PUBLIC_ORIGIN}/hook/shopify/${organisationId}`,
    body,
    headers: { ...common, "x-shopify-hmac-sha256": signature },
    invalidHeaders: {
      ...common,
      "x-shopify-hmac-sha256": btoa("invalid-shopify-signature"),
    },
  };
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
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  const bytes = new Uint8Array(signed);
  return encoding === "hex" ? bytesToHex(bytes) : encodeBase64(bytes);
}

function postWebhook(
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  return exports.default.fetch(url, { method: "POST", headers, body });
}

async function assertWebhookAuthorityUnchanged(
  row: WebhookCase,
  scenario: WebhookScenario,
): Promise<void> {
  const authority = await fixtureDatabase()
    .prepare(
      `SELECT
       (SELECT COUNT(*) FROM integration_account
        WHERE organisation_id = ? AND provider = ? AND lifecycle = 'active') AS accounts,
       (SELECT COUNT(*) FROM provider_connection
        WHERE organisation_id = ? AND provider = ? AND lifecycle = 'active'
          AND credential_generation = 1) AS connections,
       (SELECT COUNT(*) FROM provider_webhook
        WHERE organisation_id = ? AND provider = ? AND lifecycle = 'live'
          AND credential_generation = 1) AS webhooks,
       (SELECT ciphertext_b64 FROM vault_secret
        WHERE organisation_id = ? AND vault_handle = ?) AS signingCiphertext`,
    )
    .bind(
      scenario.organisationId,
      row.provider,
      scenario.organisationId,
      row.provider,
      scenario.organisationId,
      row.provider,
      scenario.organisationId,
      scenario.signingSecretRef,
    )
    .first<{
      accounts: number;
      connections: number;
      webhooks: number;
      signingCiphertext: string;
    }>();
  expect(authority).toMatchObject({ accounts: 1, connections: 1, webhooks: 1 });
  expect(authority?.signingCiphertext).not.toContain(row.signingSecret);
  expect(scenario.account.providerAccountId).toBe(row.providerAccountId);
}

function requireTestPlacement() {
  const parsed = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!parsed.ok) throw new Error(parsed.error.path);
  return parsed.value;
}
