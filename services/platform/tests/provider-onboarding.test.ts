// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { hashOpaqueSecret, upsertUser } from "@purin-labs/tenancy/data/control-plane";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import { createAuthorizingProviderAttempt } from "@purin-labs/connections/data/provider-attempt";
import { gmailProductFromScopes } from "@purin-labs/connections/mail/gmail-authorization";
import { parseWorkspaceId, type WorkspaceId } from "@purin-labs/kernel/ids";
import type { ProviderStartContext } from "@purin-labs/area-integrations/server/contract/provider-adapter";
import {
  discoverSlackChannels,
  parseSlackChannelPage,
  parseSlackInstallation,
  observeSlackProviderIdentity,
} from "@purin-labs/area-integrations/server/provider-adapters/slack";
import { parseShopifyIdentityResponse } from "../src/shopify/provider-adapter";
import {
  parseStripeAccountSummary,
  stripeCredentialEnvironment,
} from "@purin-labs/area-integrations/server/provider-adapters/stripe";
import { providerOAuthStateTtlMs } from "@purin-labs/area-integrations/server/provider-lifecycle/authorization";
import { completeProviderOAuth } from "@purin-labs/area-integrations/server/provider-lifecycle/completion";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { createFakeGraph } from "./whatsapp/fake-graph";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv } from "./worker-fakes";

const NOW = 1_784_390_000_000;
const SCOPE_ORIGIN = "https://pantry.example.test";
const SCOPE_ENV = {
  PANTRY_PUBLIC_ORIGIN: SCOPE_ORIGIN,
  PANTRY_DEPLOYMENT_PROFILE: "local",
  SHOPIFY_CLIENT_ID: "shopify-client-id",
  SHOPIFY_CLIENT_SECRET: "shopify-client-secret",
  SLACK_APP_ID: "A0SCOPE0001",
  SLACK_CLIENT_ID: "slack-client-id",
  SLACK_CLIENT_SECRET: "slack-client-secret",
  STRIPE_CONNECT_CLIENT_SECRET: "sk_test_platform",
  STRIPE_CONNECT_WEBHOOK_ID: "we_scope",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_scope",
  WHATSAPP_APP_ID: "1000000000000001",
  WHATSAPP_APP_SECRET: "whatsapp-app-secret",
} as const;
const WHATSAPP_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
  "business_management",
];

describe("provider onboarding OAuth state", providerOnboardingOAuthStateSuite);

function providerOnboardingOAuthStateSuite(): void {
  it(
    "allows enough time to complete Stripe's hosted onboarding form",
    providerStateLifetimeTest,
  );
  it(
    "rejects missing provider scopes and missing Slack bot identity",
    providerScopeTest,
  );
  it(
    "normalizes Slack channel discovery and typed API failures",
    slackChannelDiscoveryTest,
  );
  it(
    "retries transient Slack channel discovery failures",
    slackChannelDiscoveryRetryTest,
  );
  it(
    "verifies Slack bot identity with typed failure states",
    slackIdentityObservationTest,
  );
  it(
    "classifies Stripe mode and validates account eligibility",
    stripeEligibilityTest,
  );
  it(
    "classifies Shopify development shops from canonical identity",
    shopifyIdentityTest,
  );
}

async function slackIdentityObservationTest(): Promise<void> {
  await expect(
    observeSlackProviderIdentity({
      providerAccountId: "T12345678",
      bearer: "xoxb-test",
      fetcher: successfulSlackIdentityFetcher,
    }),
  ).resolves.toEqual({ kind: "healthy" });
  await expect(
    observeSlackProviderIdentity({
      providerAccountId: "T12345678",
      bearer: "xoxb-test",
      fetcher: rejectedSlackIdentityFetcher,
    }),
  ).resolves.toEqual({
    kind: "provider_rejected",
    httpStatus: 200,
    slackError: "invalid_auth",
  });
  await expect(
    observeSlackProviderIdentity({
      providerAccountId: "T12345678",
      bearer: "xoxb-test",
      fetcher: mismatchedSlackIdentityFetcher,
    }),
  ).resolves.toEqual({
    kind: "workspace_mismatch",
    expectedWorkspaceId: "T12345678",
    observedWorkspaceId: "T87654321",
  });
}

async function successfulSlackIdentityFetcher(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  expect(this).toBeUndefined();
  expect(String(input)).toBe("https://slack.com/api/auth.test");
  expect(init).toMatchObject({
    method: "POST",
    headers: {
      authorization: "Bearer xoxb-test",
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  return Response.json({ ok: true, team_id: "T12345678" });
}

async function rejectedSlackIdentityFetcher(): Promise<Response> {
  return Response.json({ ok: false, error: "invalid_auth" });
}

async function mismatchedSlackIdentityFetcher(): Promise<Response> {
  return Response.json({ ok: true, team_id: "T87654321" });
}

function providerStateLifetimeTest(): void {
  expect(providerOAuthStateTtlMs("slack")).toBe(10 * 60 * 1_000);
  expect(providerOAuthStateTtlMs("shopify")).toBe(10 * 60 * 1_000);
  expect(providerOAuthStateTtlMs("stripe")).toBe(2 * 60 * 60 * 1_000);
}

// A grant that passes the scope check stops at the next completion step: the
// live Stripe token mismatches the test-mode platform, Shopify identity
// discovery is unavailable, and the fixture has no Vault key to store a Slack
// or WhatsApp credential.
async function providerScopeTest(): Promise<void> {
  await expect(
    connectionFailure({ provider: "stripe" }, stripeScopeFetcher("read_write")),
  ).resolves.toBe("provider_environment_mismatch");
  await expect(
    connectionFailure({ provider: "stripe" }, stripeScopeFetcher("read_only")),
  ).resolves.toBe("provider_scope_missing");
  // Google token responses grant "email" only as the canonical
  // userinfo.email identifier, in Google's own order.
  expect(
    gmailProductFromScopes([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ]),
  ).toBe("full_mailbox_pilot");
  expect(
    gmailProductFromScopes([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ]),
  ).toBeNull();
  await expect(
    connectionFailure(
      { provider: "slack" },
      slackScopeFetcher([
        "app_mentions:read",
        "chat:write",
        "channels:history",
        "channels:read",
        "files:read",
        "groups:history",
        "groups:read",
        "im:history",
      ]),
    ),
  ).resolves.toBe("credential_verification_failed");
  await expect(
    connectionFailure(
      { provider: "slack" },
      slackScopeFetcher([
        "app_mentions:read",
        "chat:write",
        "channels:history",
        "groups:history",
        "im:history",
      ]),
    ),
  ).resolves.toBe("provider_scope_missing");
  await expect(
    connectionFailure(
      SHOPIFY_CONTEXT,
      shopifyScopeFetcher(["read_inventory", "read_orders", "write_inventory"]),
    ),
  ).resolves.toBe("provider_scope_missing");
  await expect(
    connectionFailure(
      SHOPIFY_CONTEXT,
      shopifyScopeFetcher([
        "read_products",
        "read_publications",
        "write_inventory",
        "write_orders",
      ]),
    ),
  ).resolves.toBe("provider_temporarily_unavailable");
  await expect(
    connectionFailure(
      SHOPIFY_CONTEXT,
      shopifyScopeFetcher(["write_inventory", "write_orders"]),
    ),
  ).resolves.toBe("provider_scope_missing");
  await expect(
    connectionFailure(
      { provider: "whatsapp" },
      createFakeGraph({ grantedScopes: WHATSAPP_SCOPES }).fetcher,
    ),
  ).resolves.toBe("credential_verification_failed");
  await expect(
    connectionFailure(
      { provider: "whatsapp" },
      createFakeGraph({ grantedScopes: WHATSAPP_SCOPES.slice(0, 2) }).fetcher,
    ),
  ).resolves.toBe("provider_scope_missing");
  await expect(
    connectionFailure(
      { provider: "whatsapp" },
      createFakeGraph({ grantedScopes: [] }).fetcher,
    ),
  ).resolves.toBe("provider_scope_missing");
  // No extra permission is demanded beyond the three the flow exercises.
  await expect(
    connectionFailure(
      { provider: "whatsapp" },
      createFakeGraph({
        grantedScopes: [...WHATSAPP_SCOPES, "pages_messaging"],
      }).fetcher,
    ),
  ).resolves.toBe("credential_verification_failed");
  expect(
    parseSlackInstallation({
      ok: true,
      access_token: "xoxb-secret",
      scope:
        "app_mentions:read,chat:write,channels:history,groups:history,im:history",
      team: { id: "T12345678", name: "Merchant" },
    }),
  ).toEqual({
    ok: false,
    error: { code: "provider_oauth_response_invalid" },
  });
}

const SHOPIFY_CONTEXT: ProviderStartContext = {
  provider: "shopify",
  shopDomain: "merchant.myshopify.com",
};

async function connectionFailure(
  context: ProviderStartContext,
  fetcher: typeof fetch,
): Promise<string> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "scope-owner",
      email: "scope@example.com",
      displayName: "Scope Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Scope Merchant",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const attempt = await createAuthorizingProviderAttempt({
    db,
    organisationId: organisation.organisationId,
    provider: context.provider,
    userId: owner.userId,
    existingIntegrationAccountId: null,
    purpose: "connect",
    portalSubjectHash: "scope-subject-hash",
    stateHash: await hashOpaqueSecret("scope-state"),
    nonceHash: await hashOpaqueSecret("scope-nonce"),
    pkceVerifier: null,
    providerContext: JSON.stringify(context),
    returnPath: `/portal/${organisation.organisationId}`,
    expiresAt: NOW + 10,
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "scope-start-0001",
        requestHash: "scope-start-request",
        expectedConfigurationVersion: 1,
      },
      scope: {
        userId: owner.userId,
        organisationScope: organisation.organisationId,
        route: `/v1/control/organisations/${organisation.organisationId}/providers/${context.provider}/start`,
        operation: "provider.attempt.start",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "scope-subject-hash",
        causationId: "scope-start",
        now: NOW,
      }),
    },
    now: NOW,
  });
  if (!attempt.ok) {
    throw new Error(attempt.error.code);
  }
  const url = new URL(
    `${SCOPE_ORIGIN}/v1/control/providers/${context.provider}/callback`,
  );
  url.searchParams.set("code", "scope-code");
  url.searchParams.set("state", "scope-state");
  if (context.provider === "shopify") {
    url.searchParams.set("hmac", await shopifyCallbackHmac(url));
  }
  const env = platformEnv({
    ...SCOPE_ENV,
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const completed = await completeProviderOAuth({
    env,
    scope: await requireOrganisationExecutionScope(
      env,
      organisation.organisationId,
    ),
    provider: context.provider,
    url,
    now: NOW + 1,
    fetcher,
  });
  if (!completed.ok || completed.value.attempt.state.kind !== "failed") {
    throw new Error(`unexpected completion ${JSON.stringify(completed)}`);
  }
  return completed.value.attempt.state.reason_code;
}

function stripeScopeFetcher(scope: string): typeof fetch {
  return async (input) =>
    String(input) === "https://connect.stripe.com/oauth/token"
      ? Response.json({
          access_token: "sk_live_merchant",
          stripe_user_id: "acct_merchant",
          scope,
        })
      : Response.json({
          id: SCOPE_ENV.STRIPE_CONNECT_WEBHOOK_ID,
          status: "enabled",
          livemode: false,
          enabled_events: [
            "charge.failed",
            "invoice.payment_failed",
            "refund.failed",
            "customer.subscription.deleted",
            "account.application.deauthorized",
          ],
        });
}

function slackScopeFetcher(scopes: readonly string[]): typeof fetch {
  return async () =>
    Response.json({
      ok: true,
      access_token: "xoxb-secret",
      app_id: SCOPE_ENV.SLACK_APP_ID,
      team: { id: "T12345678", name: "Merchant" },
      bot_user_id: "U12345678",
      scope: scopes.join(","),
    });
}

function shopifyScopeFetcher(scopes: readonly string[]): typeof fetch {
  return async (input) =>
    String(input).endsWith("/admin/oauth/access_token")
      ? Response.json({
          access_token: "shpat_merchant",
          scope: scopes.join(","),
        })
      : new Response(null, { status: 503 });
}

async function shopifyCallbackHmac(url: URL): Promise<string> {
  const message = [...url.searchParams.entries()]
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .sort()
    .join("&");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SCOPE_ENV.SHOPIFY_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Buffer.from(signature).toString("hex");
}

function slackChannelDiscoveryTest(): void {
  expect(
    parseSlackChannelPage(
      {
        ok: true,
        channels: [
          {
            id: "C12345678",
            name: "general",
            is_private: false,
            is_member: true,
            updated: 17,
          },
          {
            id: "G12345678",
            name: "operators",
            is_private: true,
            is_member: false,
            updated: 18,
          },
        ],
        response_metadata: { next_cursor: "next-page" },
      },
      testWorkspaceId(),
    ),
  ).toEqual({
    ok: true,
    value: {
      resources: [
        {
          canonicalResourceId: "C12345678",
          providerResourceId: "C12345678",
          providerAccountId: "T12345678",
          displayLabel: "#general",
          accessState: "accessible",
          providerRevision: "slack-channel:17:member",
          resourceKind: "public_channel",
        },
        {
          canonicalResourceId: "G12345678",
          providerResourceId: "G12345678",
          providerAccountId: "T12345678",
          displayLabel: "#operators",
          accessState: "inaccessible",
          providerRevision: "slack-channel:18:outside",
          resourceKind: "private_channel",
        },
      ],
      nextCursor: "next-page",
    },
  });
  expect(
    parseSlackChannelPage(
      {
        ok: false,
        error: "missing_scope",
      },
      testWorkspaceId(),
    ),
  ).toEqual({
    ok: false,
    error: { code: "provider_scope_missing" },
  });
  expect(
    parseSlackChannelPage(
      {
        ok: false,
        error: "service_unavailable",
      },
      testWorkspaceId(),
    ),
  ).toEqual({
    ok: false,
    error: {
      code: "provider_oauth_exchange_failed",
      status: 503,
      requestId: null,
    },
  });
}

let slackDiscoveryAttempts = 0;

async function slackChannelDiscoveryRetryTest(): Promise<void> {
  slackDiscoveryAttempts = 0;
  await expect(
    discoverSlackChannels({
      providerAccountId: testWorkspaceId(),
      accessToken: "xoxb-test",
      fetcher: transientSlackChannelFetcher,
    }),
  ).resolves.toEqual({
    ok: true,
    value: [
      {
        canonicalResourceId: "C12345678",
        providerResourceId: "C12345678",
        providerAccountId: "T12345678",
        displayLabel: "#general",
        accessState: "accessible",
        providerRevision: "slack-channel:17:member",
        resourceKind: "public_channel",
      },
    ],
  });
  expect(slackDiscoveryAttempts).toBe(3);
}

async function transientSlackChannelFetcher(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  expect(this).toBeUndefined();
  expect(String(input)).toContain("https://slack.com/api/conversations.list?");
  expect(init).toMatchObject({
    headers: { authorization: "Bearer xoxb-test" },
  });
  slackDiscoveryAttempts += 1;
  if (slackDiscoveryAttempts === 1) {
    throw new TypeError("simulated transport failure");
  }
  if (slackDiscoveryAttempts === 2) {
    return new Response(null, { status: 502 });
  }
  return Response.json({
    ok: true,
    channels: [
      {
        id: "C12345678",
        name: "general",
        is_private: false,
        is_member: true,
        updated: 17,
      },
    ],
    response_metadata: { next_cursor: "" },
  });
}

function testWorkspaceId(): WorkspaceId {
  const parsed = parseWorkspaceId("T12345678");
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

function stripeEligibilityTest(): void {
  expect(stripeCredentialEnvironment("sk_test_secret")).toBe("development");
  expect(stripeCredentialEnvironment("sk_live_secret")).toBe("production");
  expect(stripeCredentialEnvironment("rk_test_secret")).toBeNull();
  expect(
    parseStripeAccountSummary(
      {
        id: "acct_merchant",
        country: "US",
        charges_enabled: true,
        capabilities: {
          card_payments: "active",
          transfers: "active",
        },
        business_profile: { name: "Merchant, Inc." },
        details_submitted: true,
      },
      "acct_merchant",
      "production",
    ),
  ).toEqual({
    ok: true,
    value: {
      accountId: "acct_merchant",
      country: "US",
      displayName: "Merchant, Inc.",
      activeCapabilities: ["card_payments", "transfers"],
    },
  });
  expect(
    parseStripeAccountSummary(
      {
        id: "acct_merchant",
        country: "US",
        charges_enabled: false,
        capabilities: { card_payments: "inactive" },
        details_submitted: true,
      },
      "acct_merchant",
      "development",
    ),
  ).toEqual({
    ok: true,
    value: {
      accountId: "acct_merchant",
      country: "US",
      displayName: "acct_merchant",
      activeCapabilities: [],
    },
  });
  expect(
    parseStripeAccountSummary(
      {
        id: "acct_merchant",
        country: "US",
        charges_enabled: false,
        capabilities: { card_payments: "inactive" },
        details_submitted: true,
      },
      "acct_merchant",
      "production",
    ),
  ).toEqual({
    ok: false,
    error: { code: "provider_account_ineligible" },
  });
}

function shopifyIdentityTest(): void {
  expect(
    parseShopifyIdentityResponse({
      data: {
        shop: {
          id: "gid://shopify/Shop/123",
          name: "Merchant Store",
          myshopifyDomain: "merchant.myshopify.com",
          plan: {
            displayName: "Development",
            partnerDevelopment: true,
          },
        },
      },
    }),
  ).toEqual({
    ok: true,
    value: {
      shopId: "gid://shopify/Shop/123",
      myshopifyDomain: "merchant.myshopify.com",
      displayName: "Merchant Store",
      planDisplayName: "Development",
      environment: "development",
    },
  });
}
