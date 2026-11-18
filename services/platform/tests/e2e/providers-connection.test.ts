import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { HttpResponse, http, type HttpResponseResolver } from "msw";
import { expect, it } from "vitest";

import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseIntegrationAccountId, type OrganisationId } from "../../src/ids";
import { network } from "./network";
import { commerceWorkspace } from "./commerce-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";
import { assertNever, bytesToHex, isRecord } from "@seams/std";

const PUBLIC_ORIGIN = "https://localhost";
const AIRTABLE_BASE_ID = "appE2EBASE01";
const AIRTABLE_TABLE_ID = "tblE2ETABLE1";
const AIRTABLE_REFRESHED_CREDENTIAL = "airtable-provider-e2e-refreshed";
const AIRTABLE_REPLACEMENT_REFRESH_TOKEN = "airtable-refresh-e2e-replacement";
const GMAIL_SUBJECT = "google-subject-e2e";
const GMAIL_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;
// Google reorders granted scopes and would canonicalise any shorthand; the
// fake token endpoint must not simply echo the request.
const GMAIL_GRANTED_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email openid";
const WHATSAPP_APP_ID = "1000000000000001";
const WHATSAPP_WABA_ID = "4000000000000004";
const WHATSAPP_PHONE_NUMBER_ID = "5000000000000005";
const SHOP_DOMAIN = "satyr-e2e.myshopify.com";
const SHOPIFY_CLIENT_SECRET = "shopify-e2e-secret";
const SLACK_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "channels:read",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
] as const;
const SHOPIFY_SCOPES = [
  "read_inventory",
  "read_orders",
  "read_products",
  "read_publications",
  "write_inventory",
  "write_orders",
] as const;
const STRIPE_WEBHOOK_EVENTS = [
  "charge.failed",
  "invoice.payment_failed",
  "refund.failed",
  "customer.subscription.deleted",
  "account.application.deauthorized",
] as const;

type ProviderCase =
  | {
      readonly provider: "slack";
      readonly providerAccountId: "T12345678";
      readonly accountKind: "workspace";
      readonly expectedWebhookCount: 0;
      readonly expectedResourceCount: 1;
      readonly expectedGenerationCount: 1;
      readonly storesOrganisationCredential: true;
    }
  | {
      readonly provider: "stripe";
      readonly providerAccountId: "acct_e2e_merchant";
      readonly accountKind: "merchant_account";
      readonly expectedWebhookCount: 1;
      readonly expectedResourceCount: 1;
      readonly expectedGenerationCount: 1;
      readonly storesOrganisationCredential: true;
    }
  | {
      readonly provider: "shopify";
      readonly providerAccountId: typeof SHOP_DOMAIN;
      readonly accountKind: "store";
      readonly expectedWebhookCount: 6;
      readonly expectedResourceCount: 1;
      readonly expectedGenerationCount: 1;
      readonly storesOrganisationCredential: true;
    }
  | {
      readonly provider: "airtable";
      readonly providerAccountId: "usrAirtableE2E";
      readonly accountKind: "user_grant";
      readonly expectedWebhookCount: 0;
      readonly expectedResourceCount: 0;
      readonly expectedGenerationCount: 1;
      readonly storesOrganisationCredential: true;
    }
  | {
      readonly provider: "notion";
      readonly providerAccountId: "notion-user-e2e";
      readonly accountKind: "workspace";
      readonly expectedWebhookCount: 0;
      readonly expectedResourceCount: 0;
      readonly expectedGenerationCount: 1;
      readonly storesOrganisationCredential: true;
    }
  | {
      readonly provider: "gmail";
      readonly providerAccountId: typeof GMAIL_SUBJECT;
      readonly accountKind: "mailbox";
      readonly expectedWebhookCount: 0;
      readonly expectedResourceCount: 2;
      readonly expectedGenerationCount: 1;
      readonly storesOrganisationCredential: true;
    }
  | {
      readonly provider: "whatsapp";
      readonly providerAccountId: typeof WHATSAPP_PHONE_NUMBER_ID;
      readonly accountKind: "phone_number";
      readonly expectedWebhookCount: 0;
      readonly expectedResourceCount: 1;
      readonly expectedGenerationCount: 1;
      readonly storesOrganisationCredential: true;
    };

type ControlScenario = Readonly<{
  organisationId: OrganisationId;
  session: IssuedControlSession;
}>;

type ProviderStart = Readonly<{
  attemptId: string;
  authorizationUrl: URL;
}>;

type ProviderCall = Readonly<{
  provider: ProviderCase["provider"];
  operation: string;
  method: string;
  url: string;
}>;

type IntegrationAccountRow = Readonly<{
  integrationAccountId: string;
  providerAccountId: string;
  accountKind: string;
  lifecycle: string;
  capabilitySet: string;
}>;

const PROVIDERS: readonly ProviderCase[] = [
  {
    provider: "slack",
    providerAccountId: "T12345678",
    accountKind: "workspace",
    expectedWebhookCount: 0,
    expectedResourceCount: 1,
    expectedGenerationCount: 1,
    storesOrganisationCredential: true,
  },
  {
    provider: "stripe",
    providerAccountId: "acct_e2e_merchant",
    accountKind: "merchant_account",
    expectedWebhookCount: 1,
    expectedResourceCount: 1,
    expectedGenerationCount: 1,
    storesOrganisationCredential: true,
  },
  {
    provider: "shopify",
    providerAccountId: SHOP_DOMAIN,
    accountKind: "store",
    expectedWebhookCount: 6,
    expectedResourceCount: 1,
    expectedGenerationCount: 1,
    storesOrganisationCredential: true,
  },
  {
    provider: "airtable",
    providerAccountId: "usrAirtableE2E",
    accountKind: "user_grant",
    expectedWebhookCount: 0,
    expectedResourceCount: 0,
    expectedGenerationCount: 1,
    storesOrganisationCredential: true,
  },
  {
    provider: "notion",
    providerAccountId: "notion-user-e2e",
    accountKind: "workspace",
    expectedWebhookCount: 0,
    expectedResourceCount: 0,
    expectedGenerationCount: 1,
    storesOrganisationCredential: true,
  },
  {
    provider: "gmail",
    providerAccountId: GMAIL_SUBJECT,
    accountKind: "mailbox",
    expectedWebhookCount: 0,
    expectedResourceCount: 2,
    expectedGenerationCount: 1,
    storesOrganisationCredential: true,
  },
  {
    provider: "whatsapp",
    providerAccountId: WHATSAPP_PHONE_NUMBER_ID,
    accountKind: "phone_number",
    expectedWebhookCount: 0,
    expectedResourceCount: 1,
    expectedGenerationCount: 1,
    storesOrganisationCredential: true,
  },
];

let providerCalls: ProviderCall[] = [];

it.each(PROVIDERS)(
  "$provider connects once through the public OAuth boundary",
  providerConnectionContract,
);

async function providerConnectionContract(row: ProviderCase): Promise<void> {
  providerCalls = [];
  network.use(...PROVIDER_HANDLERS);
  const scenario = await createControlScenario(row.provider);
  const started = await startProviderConnection(row, scenario);

  assertAuthorizationRequest(row, started.authorizationUrl);
  const callbackUrl = await providerCallbackUrl(row, started.authorizationUrl);
  const callback = await exports.default.fetch(callbackUrl);
  expect(callback.status).toBe(200);
  await expect(callback.text()).resolves.toContain(
    "satyr.provider-attempt.completed",
  );

  const attempt = await readProviderAttempt(scenario, started.attemptId);
  expect(attempt.status).toBe(200);
  const attemptBody = await attempt.json();
  expect(
    attemptBody,
    `provider calls: ${JSON.stringify(callsForProvider(row.provider))}`,
  ).toMatchObject({
    kind: "success",
    attempt: {
      attempt_id: started.attemptId,
      provider: row.provider,
      state: { kind: "connected" },
    },
  });

  const account = await readConnectedAccount(row, scenario.organisationId);
  await assertPublicAccountProjection(
    row,
    scenario,
    account.integrationAccountId,
  );
  await assertUsableCapability(row, scenario, account.integrationAccountId);
  await assertConnectionCardinality(row, scenario.organisationId);
  await assertCredentialIsEncrypted(row, scenario.organisationId);

  const providerCallCount = callsForProvider(row.provider).length;
  const replay = await exports.default.fetch(callbackUrl);
  expect(replay.status).toBe(200);
  expect(callsForProvider(row.provider)).toHaveLength(providerCallCount);
  await assertConnectionCardinality(row, scenario.organisationId);
}

async function createControlScenario(
  provider: ProviderCase["provider"],
): Promise<ControlScenario> {
  const now = Date.now() - 1_000;
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `provider-e2e-${provider}`,
      email: `${provider}@provider-e2e.example`,
      displayName: `${provider} E2E Owner`,
      emailVerified: true,
    },
    now,
  });
  const session = await issueControlSession({
    db: env.DB,
    userId: owner.userId,
    now,
    ttlMs: 30 * 60 * 1_000,
  });
  // The shared Console creates Organisations; this journey starts at a
  // Pantry Organisation that the account authority already knows.
  const client = { identity: owner, session };
  const organisationId = await commerceWorkspace(
    client,
    `${provider} Provider E2E`,
  );
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner: client,
    members: {},
  });
  return { organisationId, session };
}

async function startProviderConnection(
  row: ProviderCase,
  scenario: ControlScenario,
): Promise<ProviderStart> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${scenario.organisationId}/providers/${row.provider}/start`,
    {
      method: "POST",
      headers: controlMutationHeaders(
        scenario.session,
        `provider-e2e-start-${row.provider}`,
      ),
      body: JSON.stringify(providerStartBody(row, scenario.organisationId)),
    },
  );
  expect(response.status).toBe(201);
  return parseProviderStart(await response.json());
}

function providerStartBody(
  row: ProviderCase,
  organisationId: OrganisationId,
): Readonly<Record<string, string>> {
  switch (row.provider) {
    case "slack":
    case "stripe":
    case "airtable":
    case "notion":
    case "gmail":
    case "whatsapp":
      return { returnPath: `/portal/${organisationId}` };
    case "shopify":
      return {
        returnPath: `/portal/${organisationId}`,
        shopDomain: row.providerAccountId,
      };
    default:
      return assertNever(row, "unexpected provider row");
  }
}

function parseProviderStart(raw: unknown): ProviderStart {
  if (
    !isRecord(raw) ||
    raw.kind !== "success" ||
    typeof raw.authorization_url !== "string" ||
    !isRecord(raw.attempt) ||
    typeof raw.attempt.attempt_id !== "string"
  ) {
    throw new Error("provider start response is invalid");
  }
  return {
    attemptId: raw.attempt.attempt_id,
    authorizationUrl: new URL(raw.authorization_url),
  };
}

function assertAuthorizationRequest(row: ProviderCase, url: URL): void {
  expect(url.searchParams.get("redirect_uri")).toBe(
    `${PUBLIC_ORIGIN}/v1/control/providers/${row.provider}/callback`,
  );
  switch (row.provider) {
    case "slack":
      expect(url.origin).toBe("https://slack.com");
      expect(url.searchParams.get("scope")?.split(",")).toEqual(SLACK_SCOPES);
      return;
    case "stripe":
      expect(url.origin).toBe("https://connect.stripe.com");
      expect(url.searchParams.get("scope")).toBe("read_write");
      return;
    case "shopify":
      expect(url.origin).toBe(`https://${SHOP_DOMAIN}`);
      expect(url.searchParams.get("scope")?.split(",")).toEqual(SHOPIFY_SCOPES);
      return;
    case "airtable":
      expect(url.origin).toBe("https://airtable.com");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{40,}$/u,
      );
      return;
    case "notion":
      expect(url.origin).toBe("https://api.notion.com");
      expect(url.searchParams.get("owner")).toBe("user");
      return;
    case "gmail":
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("scope")?.split(" ")).toEqual(GMAIL_SCOPES);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{40,}$/u,
      );
      return;
    case "whatsapp":
      expect(url.origin).toBe("https://www.facebook.com");
      expect(url.searchParams.get("client_id")).toBe(WHATSAPP_APP_ID);
      expect(url.searchParams.get("config_id")).toBe("3000000000000003");
      return;
    default:
      return assertNever(row, "unexpected provider row");
  }
}

async function providerCallbackUrl(
  row: ProviderCase,
  authorizationUrl: URL,
): Promise<string> {
  const state = authorizationUrl.searchParams.get("state");
  if (state === null)
    throw new Error("provider authorization state is missing");
  const url = new URL(
    `${PUBLIC_ORIGIN}/v1/control/providers/${row.provider}/callback`,
  );
  url.searchParams.set("code", `provider-code-${row.provider}`);
  url.searchParams.set("state", state);
  if (row.provider === "shopify") {
    url.searchParams.set("shop", row.providerAccountId);
    url.searchParams.set("timestamp", "1787500800");
    url.searchParams.set("hmac", await shopifyCallbackHmac(url));
  }
  return url.toString();
}

async function shopifyCallbackHmac(url: URL): Promise<string> {
  const message = [...url.searchParams.entries()]
    .map(encodeSearchParam)
    .sort()
    .join("&");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SHOPIFY_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(signature));
}

function encodeSearchParam(entry: readonly [string, string]): string {
  return `${encodeURIComponent(entry[0])}=${encodeURIComponent(entry[1])}`;
}

async function readProviderAttempt(
  scenario: ControlScenario,
  attemptId: string,
): Promise<Response> {
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${scenario.organisationId}/provider-attempts/${attemptId}`,
    { headers: controlReadHeaders(scenario.session) },
  );
}

async function readConnectedAccount(
  row: ProviderCase,
  organisationId: OrganisationId,
): Promise<IntegrationAccountRow> {
  const record = await fixtureDatabase()
    .prepare(
      `SELECT integration_account_id AS integrationAccountId,
            provider_account_id AS providerAccountId,
            account_kind AS accountKind, lifecycle,
            capability_set AS capabilitySet
     FROM integration_account
     WHERE organisation_id = ? AND provider = ?`,
    )
    .bind(organisationId, row.provider)
    .first<IntegrationAccountRow>();
  if (record === null)
    throw new Error("connected integration account is missing");
  expect(record).toMatchObject({
    providerAccountId: row.providerAccountId,
    accountKind: row.accountKind,
    lifecycle: "active",
  });
  return record;
}

async function assertPublicAccountProjection(
  row: ProviderCase,
  scenario: ControlScenario,
  integrationAccountId: string,
): Promise<void> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${scenario.organisationId}/accounts`,
    { headers: controlReadHeaders(scenario.session) },
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({
    ok: true,
    accounts: [
      {
        integrationAccountId,
        provider: row.provider,
        providerAccountId: row.providerAccountId,
        accountKind: row.accountKind,
        lifecycle: { kind: "active" },
      },
    ],
  });
  expect(body).not.toContain(providerCredential(row.provider));
}

async function assertUsableCapability(
  row: ProviderCase,
  scenario: ControlScenario,
  integrationAccountIdRaw: string,
): Promise<void> {
  const parsedIntegrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!parsedIntegrationAccountId.ok) {
    throw new Error("connected integration account ID is invalid");
  }
  const integrationAccountId = parsedIntegrationAccountId.value;
  switch (row.provider) {
    case "slack": {
      const response = await exports.default.fetch(
        `${PUBLIC_ORIGIN}/v1/control/organisations/${scenario.organisationId}/accounts/${integrationAccountId}/resources`,
        { headers: controlReadHeaders(scenario.session) },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        kind: "success",
        page: {
          resources: [
            {
              canonical_resource_id: "C12345678",
              display_label: "#orders",
              access_state: "accessible",
            },
          ],
        },
      });
      return;
    }
    case "airtable": {
      await activateOrganisationForAirtableRead(scenario.organisationId);
      const response = await exports.default.fetch(
        `${PUBLIC_ORIGIN}/v1/admin/external-records-read`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            organisationId: scenario.organisationId,
            integrationAccountId,
            request: {
              baseId: AIRTABLE_BASE_ID,
              tableId: AIRTABLE_TABLE_ID,
              viewId: null,
              query: null,
              limit: 1,
            },
          }),
        },
      );
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        ok: true,
        result: {
          kind: "external_records",
          provider: "airtable",
          items: [{ id: "recE2E0001", title: "E2E record" }],
        },
      });
      expect(operationsForProvider("airtable")).toEqual([
        "oauth.exchange",
        "identity.discover",
        "oauth.refresh",
        "records.list",
      ]);
      const rotated = await fixtureDatabase()
        .prepare(
          `SELECT rotated_at AS rotatedAt
         FROM vault_secret
         WHERE organisation_id = ?`,
        )
        .bind(scenario.organisationId)
        .first<{ rotatedAt: number | null }>();
      expect(rotated?.rotatedAt).not.toBeNull();
      return;
    }
    case "stripe":
      expect(
        JSON.parse(
          (await readConnectedAccount(row, scenario.organisationId))
            .capabilitySet,
        ),
      ).toEqual(["payments.read", "refunds.propose", "refunds.execute"]);
      return;
    case "shopify":
      expect(
        JSON.parse(
          (await readConnectedAccount(row, scenario.organisationId))
            .capabilitySet,
        ),
      ).toEqual(expect.arrayContaining(["orders.read", "catalog.events"]));
      return;
    case "notion":
      expect(
        JSON.parse(
          (await readConnectedAccount(row, scenario.organisationId))
            .capabilitySet,
        ),
      ).toEqual(["notion.search"]);
      return;
    case "gmail":
      expect(
        JSON.parse(
          (await readConnectedAccount(row, scenario.organisationId))
            .capabilitySet,
        ),
      ).toEqual(["mailbox.ingress", "email.operational.propose"]);
      return;
    case "whatsapp":
      expect(
        JSON.parse(
          (await readConnectedAccount(row, scenario.organisationId))
            .capabilitySet,
        ),
      ).toEqual(["whatsapp.support.ingress"]);
      await assertWhatsAppSupportResource(scenario.organisationId);
      return;
    default:
      return assertNever(row, "unexpected provider row");
  }
}

async function assertWhatsAppSupportResource(
  organisationId: OrganisationId,
): Promise<void> {
  const resource = await fixtureDatabase()
    .prepare(
      `SELECT resource.canonical_resource_id AS canonicalResourceId,
            resource.display_label AS displayLabel,
            resource.access_state AS accessState,
            resource.resource_kind AS resourceKind
       FROM provider_discovered_resource AS resource
       JOIN provider_resource_snapshot AS snapshot
         ON snapshot.snapshot_revision = resource.snapshot_revision
      WHERE snapshot.organisation_id = ? AND snapshot.provider = 'whatsapp'`,
    )
    .bind(organisationId)
    .first<{
      canonicalResourceId: string;
      displayLabel: string;
      accessState: string;
      resourceKind: string;
    }>();
  expect(resource).toEqual({
    canonicalResourceId: "active_cases",
    displayLabel: "Active support Cases",
    accessState: "accessible",
    resourceKind: "active_support_cases",
  });
}

async function activateOrganisationForAirtableRead(
  organisationId: OrganisationId,
): Promise<void> {
  const now = Date.now();
  const activation = await fixtureDatabase()
    .prepare(
      `UPDATE organisation_onboarding
     SET lifecycle = 'active', activation_receipt_id = ?, activated_at = ?, updated_at = ?
     WHERE organisation_id = ? AND lifecycle = 'configuring'`,
    )
    .bind(
      `activation_receipt_airtable_e2e_${crypto.randomUUID()}`,
      now,
      now,
      organisationId,
    )
    .run();
  expect(activation.meta.changes).toBe(1);
}

async function assertConnectionCardinality(
  row: ProviderCase,
  organisationId: OrganisationId,
): Promise<void> {
  const counts = await fixtureDatabase()
    .prepare(
      `SELECT
       (SELECT COUNT(*) FROM provider_connection_attempt
        WHERE organisation_id = ? AND provider = ?) AS attempts,
       (SELECT COUNT(*) FROM provider_connection
        WHERE organisation_id = ? AND provider = ?) AS connections,
       (SELECT COUNT(*) FROM integration_account
        WHERE organisation_id = ? AND provider = ?) AS accounts,
       (SELECT COUNT(*) FROM provider_credential_generation AS generation
        JOIN provider_connection AS connection
          ON connection.provider_connection_id = generation.provider_connection_id
        WHERE connection.organisation_id = ? AND connection.provider = ?) AS generations,
       (SELECT COUNT(*) FROM provider_webhook
        WHERE organisation_id = ? AND provider = ?) AS webhooks,
       (SELECT COUNT(*) FROM provider_discovered_resource AS resource
        JOIN provider_resource_snapshot AS snapshot
          ON snapshot.snapshot_revision = resource.snapshot_revision
        WHERE snapshot.organisation_id = ? AND snapshot.provider = ?) AS resources`,
    )
    .bind(
      organisationId,
      row.provider,
      organisationId,
      row.provider,
      organisationId,
      row.provider,
      organisationId,
      row.provider,
      organisationId,
      row.provider,
      organisationId,
      row.provider,
    )
    .first<{
      attempts: number;
      connections: number;
      accounts: number;
      generations: number;
      webhooks: number;
      resources: number;
    }>();
  expect(counts).toEqual({
    attempts: 1,
    connections: 1,
    accounts: 1,
    generations: row.expectedGenerationCount,
    webhooks: row.expectedWebhookCount,
    resources: row.expectedResourceCount,
  });
}

async function assertCredentialIsEncrypted(
  row: ProviderCase,
  organisationId: OrganisationId,
): Promise<void> {
  const credential = providerCredential(row.provider);
  const secrets = await fixtureDatabase()
    .prepare(
      `SELECT ciphertext_b64 AS ciphertext
     FROM vault_secret WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .all<{ ciphertext: string }>();
  if (!row.storesOrganisationCredential) {
    expect(secrets.results).toEqual([]);
    return;
  }
  expect(secrets.results.length).toBeGreaterThan(0);
  for (const secret of secrets.results) {
    expect(secret.ciphertext).not.toContain(credential);
    if (row.provider === "airtable") {
      expect(secret.ciphertext).not.toContain(AIRTABLE_REFRESHED_CREDENTIAL);
      expect(secret.ciphertext).not.toContain(
        AIRTABLE_REPLACEMENT_REFRESH_TOKEN,
      );
    }
  }
}

function providerCredential(provider: ProviderCase["provider"]): string {
  switch (provider) {
    case "slack":
      return "xoxb-provider-e2e";
    case "stripe":
      return "sk_test_provider_e2e";
    case "shopify":
      return "shpat_provider_e2e";
    case "airtable":
      return "airtable-provider-e2e";
    case "notion":
      return "notion-provider-e2e";
    case "gmail":
      return "gmail-provider-e2e";
    case "whatsapp":
      return "whatsapp-signup-e2e";
  }
}

function controlMutationHeaders(
  session: IssuedControlSession,
  idempotencyKey: string,
): HeadersInit {
  return {
    ...controlReadHeaders(session),
    origin: PUBLIC_ORIGIN,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-satyr-configuration-version": "1",
    "x-satyr-csrf": session.csrfToken,
  };
}

function controlReadHeaders(
  session: IssuedControlSession,
): Record<string, string> {
  return {
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
  };
}

function callsForProvider(
  provider: ProviderCase["provider"],
): readonly ProviderCall[] {
  const calls: ProviderCall[] = [];
  for (const call of providerCalls) {
    if (call.provider === provider) calls.push(call);
  }
  return calls;
}

function operationsForProvider(
  provider: ProviderCase["provider"],
): readonly string[] {
  const operations: string[] = [];
  for (const call of providerCalls) {
    if (call.provider === provider) operations.push(call.operation);
  }
  return operations;
}

function recordProviderCall(
  provider: ProviderCase["provider"],
  operation: string,
  request: Readonly<{ method: string; url: string }>,
): void {
  providerCalls.push({
    provider,
    operation,
    method: request.method,
    url: request.url,
  });
}

const slackOAuthResolver: HttpResponseResolver = async ({ request }) => {
  recordProviderCall("slack", "oauth.exchange", request);
  const form = await request.formData();
  expect(form.get("client_id")).toBe("slack-e2e-client");
  expect(form.get("client_secret")).toBe("slack-e2e-secret");
  expect(form.get("redirect_uri")).toBe(
    `${PUBLIC_ORIGIN}/v1/control/providers/slack/callback`,
  );
  return HttpResponse.json({
    ok: true,
    app_id: "A12345678",
    access_token: providerCredential("slack"),
    scope: SLACK_SCOPES.join(","),
    bot_user_id: "U12345678",
    team: { id: "T12345678", name: "E2E Workspace" },
  });
};

const slackChannelsResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("slack", "channels.list", request);
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${providerCredential("slack")}`,
  );
  return HttpResponse.json({
    ok: true,
    channels: [
      {
        id: "C12345678",
        name: "orders",
        is_private: false,
        is_member: true,
        updated: 17,
      },
    ],
    response_metadata: { next_cursor: "" },
  });
};

const stripeWebhookResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("stripe", "webhook.verify", request);
  expect(request.headers.get("authorization")).toBe(
    "Bearer sk_test_satyr_platform_e2e",
  );
  return HttpResponse.json({
    id: "we_e2e",
    status: "enabled",
    livemode: false,
    enabled_events: STRIPE_WEBHOOK_EVENTS,
  });
};

const stripeOAuthResolver: HttpResponseResolver = async ({ request }) => {
  recordProviderCall("stripe", "oauth.exchange", request);
  const form = await request.formData();
  expect(form.get("client_secret")).toBe("sk_test_satyr_platform_e2e");
  expect(form.get("grant_type")).toBe("authorization_code");
  return HttpResponse.json({
    access_token: providerCredential("stripe"),
    stripe_user_id: "acct_e2e_merchant",
    scope: "read_write",
  });
};

const stripeAccountResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("stripe", "account.discover", request);
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${providerCredential("stripe")}`,
  );
  return HttpResponse.json({
    id: "acct_e2e_merchant",
    country: "US",
    charges_enabled: false,
    details_submitted: true,
    capabilities: { card_payments: "active", transfers: "active" },
    business_profile: { name: "Stripe E2E Merchant" },
  });
};

const airtableOAuthResolver: HttpResponseResolver = async ({ request }) => {
  expect(request.headers.get("authorization")).toBe(
    `Basic ${btoa("airtable-e2e-client:airtable-e2e-secret")}`,
  );
  const form = await request.formData();
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    recordProviderCall("airtable", "oauth.exchange", request);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    return HttpResponse.json({
      access_token: providerCredential("airtable"),
      refresh_token: "airtable-refresh-e2e",
      expires_in: 1,
    });
  }
  if (grantType === "refresh_token") {
    recordProviderCall("airtable", "oauth.refresh", request);
    expect(form.get("refresh_token")).toBe("airtable-refresh-e2e");
    return HttpResponse.json({
      access_token: AIRTABLE_REFRESHED_CREDENTIAL,
      refresh_token: AIRTABLE_REPLACEMENT_REFRESH_TOKEN,
      expires_in: 3_600,
    });
  }
  throw new Error("unexpected Airtable OAuth grant");
};

const airtableWhoamiResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("airtable", "identity.discover", request);
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${providerCredential("airtable")}`,
  );
  return HttpResponse.json({
    id: "usrAirtableE2E",
    scopes: [
      "data.records:read",
      "data.records:write",
      "schema.bases:read",
      "schema.bases:write",
      "data.recordComments:read",
      "data.recordComments:write",
      "webhook:manage",
    ],
  });
};

const airtableRecordsResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("airtable", "records.list", request);
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${AIRTABLE_REFRESHED_CREDENTIAL}`,
  );
  return HttpResponse.json({
    records: [
      {
        id: "recE2E0001",
        createdTime: "2026-08-24T00:00:00.000Z",
        fields: { fldName: "E2E record" },
      },
    ],
  });
};

const notionOAuthResolver: HttpResponseResolver = async ({ request }) => {
  recordProviderCall("notion", "oauth.exchange", request);
  expect(request.headers.get("authorization")).toBe(
    `Basic ${btoa("notion-e2e-client:notion-e2e-secret")}`,
  );
  expect(await request.json()).toMatchObject({
    grant_type: "authorization_code",
    code: "provider-code-notion",
    redirect_uri: `${PUBLIC_ORIGIN}/v1/control/providers/notion/callback`,
  });
  return HttpResponse.json({
    access_token: providerCredential("notion"),
    refresh_token: "notion-refresh-e2e",
  });
};

const notionIdentityResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("notion", "identity.discover", request);
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${providerCredential("notion")}`,
  );
  return HttpResponse.json({ id: "notion-user-e2e", name: "Notion E2E" });
};

const gmailOAuthResolver: HttpResponseResolver = async ({ request }) => {
  recordProviderCall("gmail", "oauth.exchange", request);
  const form = await request.formData();
  expect(form.get("client_id")).toBe("gmail-e2e-client");
  expect(form.get("client_secret")).toBe("gmail-e2e-secret");
  expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  return HttpResponse.json({
    access_token: providerCredential("gmail"),
    refresh_token: "gmail-refresh-e2e",
    expires_in: 3_600,
    scope: GMAIL_GRANTED_SCOPES,
    id_token: gmailIdToken(),
  });
};

const whatsappOAuthResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("whatsapp", "signup.exchange", request);
  return HttpResponse.json({ access_token: "whatsapp-signup-e2e" });
};

const whatsappDebugResolver: HttpResponseResolver = ({ request }) => {
  recordProviderCall("whatsapp", "signup.inspect", request);
  return HttpResponse.json({
    data: {
      is_valid: true,
      expires_at: 1_800_000_000,
      scopes: [
        "whatsapp_business_management",
        "whatsapp_business_messaging",
        "business_management",
      ],
      granular_scopes: [
        {
          scope: "whatsapp_business_management",
          target_ids: [WHATSAPP_WABA_ID],
        },
        { scope: "business_management", target_ids: ["6000000000000006"] },
      ],
    },
  });
};

const whatsappPhoneNumbersResolver: HttpResponseResolver = ({ request }) => {
  expect(request.headers.get("authorization")).toBe(
    "Bearer whatsapp-signup-e2e",
  );
  recordProviderCall("whatsapp", "phone-numbers.list", request);
  return HttpResponse.json({
    data: [
      {
        id: WHATSAPP_PHONE_NUMBER_ID,
        display_phone_number: "+15550001111",
        verified_name: "WhatsApp E2E",
      },
    ],
  });
};

const whatsappSubscribedAppsResolver: HttpResponseResolver = ({ request }) => {
  expect(request.headers.get("authorization")).toBe(
    "Bearer whatsapp-signup-e2e",
  );
  recordProviderCall(
    "whatsapp",
    request.method === "GET" ? "subscription.verify" : "subscription.create",
    request,
  );
  return request.method === "GET"
    ? HttpResponse.json({
        data: [{ whatsapp_business_api_data: { id: WHATSAPP_APP_ID } }],
      })
    : HttpResponse.json({ success: true });
};

const shopifyOAuthResolver: HttpResponseResolver = async ({ request }) => {
  recordProviderCall("shopify", "oauth.exchange", request);
  const form = await request.formData();
  expect(form.get("client_id")).toBe("shopify-e2e-client");
  expect(form.get("client_secret")).toBe(SHOPIFY_CLIENT_SECRET);
  return HttpResponse.json({
    access_token: providerCredential("shopify"),
    scope: SHOPIFY_SCOPES.join(","),
  });
};

const shopifyGraphqlResolver: HttpResponseResolver = async ({ request }) => {
  expect(request.headers.get("x-shopify-access-token")).toBe(
    providerCredential("shopify"),
  );
  const body = await readGraphqlRequest(request);
  recordProviderCall("shopify", shopifyGraphqlOperation(body.query), request);
  if (body.query.includes("SatyrOnboardingShop")) {
    return HttpResponse.json({
      data: {
        shop: {
          id: "gid://shopify/Shop/123",
          name: "Shopify E2E Merchant",
          myshopifyDomain: SHOP_DOMAIN,
          plan: { displayName: "Development", partnerDevelopment: true },
        },
      },
    });
  }
  if (body.query.includes("SatyrWebhookSubscriptions")) {
    return HttpResponse.json({ data: { webhookSubscriptions: { nodes: [] } } });
  }
  if (body.query.includes("SatyrWebhookSubscriptionCreate")) {
    const topic = requireString(body.variables.topic, "Shopify webhook topic");
    const webhook = requireRecord(
      body.variables.webhookSubscription,
      "Shopify webhook subscription",
    );
    const uri = requireString(webhook.uri, "Shopify webhook URI");
    return HttpResponse.json({
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: {
            id: `gid://shopify/WebhookSubscription/${topic.toLowerCase()}`,
            topic,
            uri,
          },
          userErrors: [],
        },
      },
    });
  }
  return shopifyInitialSnapshot(body.query);
};

function shopifyGraphqlOperation(query: string): string {
  const matched = /(?:query|mutation)\s+(Satyr[A-Za-z]+)/u.exec(query);
  return matched?.[1] ?? "graphql.unknown";
}

const PROVIDER_HANDLERS = [
  http.post("https://slack.com/api/oauth.v2.access", slackOAuthResolver),
  http.get("https://slack.com/api/conversations.list", slackChannelsResolver),
  http.get(
    "https://api.stripe.com/v1/webhook_endpoints/we_e2e",
    stripeWebhookResolver,
  ),
  http.post("https://connect.stripe.com/oauth/token", stripeOAuthResolver),
  http.get(
    "https://api.stripe.com/v1/accounts/acct_e2e_merchant",
    stripeAccountResolver,
  ),
  http.post("https://airtable.com/oauth2/v1/token", airtableOAuthResolver),
  http.get("https://api.airtable.com/v0/meta/whoami", airtableWhoamiResolver),
  http.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`,
    airtableRecordsResolver,
  ),
  http.post("https://api.notion.com/v1/oauth/token", notionOAuthResolver),
  http.get("https://api.notion.com/v1/users/me", notionIdentityResolver),
  http.post("https://oauth2.googleapis.com/token", gmailOAuthResolver),
  http.get(
    "https://graph.facebook.com/v23.0/oauth/access_token",
    whatsappOAuthResolver,
  ),
  http.get(
    "https://graph.facebook.com/v23.0/debug_token",
    whatsappDebugResolver,
  ),
  http.get(
    `https://graph.facebook.com/v23.0/${WHATSAPP_WABA_ID}/phone_numbers`,
    whatsappPhoneNumbersResolver,
  ),
  http.all(
    `https://graph.facebook.com/v23.0/${WHATSAPP_WABA_ID}/subscribed_apps`,
    whatsappSubscribedAppsResolver,
  ),
  http.post(
    `https://${SHOP_DOMAIN}/admin/oauth/access_token`,
    shopifyOAuthResolver,
  ),
  http.post(
    `https://${SHOP_DOMAIN}/admin/api/2026-07/graphql.json`,
    shopifyGraphqlResolver,
  ),
];

function gmailIdToken(): string {
  const now = Math.floor(Date.now() / 1_000);
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson({
      iss: "https://accounts.google.com",
      aud: "gmail-e2e-client",
      exp: now + 3_600,
      iat: now - 30,
      sub: GMAIL_SUBJECT,
      email: "gmail-e2e@example.com",
    }),
    "signature",
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function readGraphqlRequest(request: {
  json(): Promise<unknown>;
}): Promise<{
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}> {
  const raw: unknown = await request.json();
  if (
    !isRecord(raw) ||
    typeof raw.query !== "string" ||
    (raw.variables !== undefined && !isRecord(raw.variables))
  ) {
    throw new Error("Shopify GraphQL request is invalid");
  }
  return {
    query: raw.query,
    variables: raw.variables === undefined ? {} : raw.variables,
  };
}

function shopifyInitialSnapshot(query: string) {
  const pageInfo = { hasNextPage: false, endCursor: null };
  if (
    query.includes("SatyrInitialCatalog") ||
    query.includes("SatyrInitialPublications")
  ) {
    return HttpResponse.json({ data: { products: { nodes: [], pageInfo } } });
  }
  if (query.includes("SatyrInitialInventory")) {
    return HttpResponse.json({
      data: { inventoryItems: { nodes: [], pageInfo } },
    });
  }
  if (query.includes("SatyrInitialOrders")) {
    return HttpResponse.json({ data: { orders: { nodes: [], pageInfo } } });
  }
  throw new Error("unexpected Shopify GraphQL operation");
}

function requireRecord(
  raw: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) throw new Error(`${label} is invalid`);
  return raw;
}

function requireString(raw: unknown, label: string): string {
  if (typeof raw !== "string") throw new Error(`${label} is invalid`);
  return raw;
}
