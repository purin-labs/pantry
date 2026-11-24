import { describe, expect, it, vi } from "vitest";

import { airtableCleanupAdapter } from "@purin-labs/area-integrations/server/provider-adapters/airtable";
import { gmailCleanupAdapter } from "@purin-labs/area-integrations/server/provider-adapters/gmail";
import { notionCleanupAdapter } from "@purin-labs/area-integrations/server/provider-adapters/notion";
import { shopifyCleanupAdapter } from "@purin-labs/area-integrations/shopify/provider-adapter";
import { slackCleanupAdapter } from "@purin-labs/area-integrations/server/provider-adapters/slack";
import { stripeCleanupAdapter } from "@purin-labs/area-integrations/server/provider-adapters/stripe";
import { whatsappCleanupAdapter } from "@purin-labs/area-integrations/server/provider-adapters/whatsapp";
import type { ProviderCleanupCredentials } from "@purin-labs/area-integrations-contract/server/provider-adapter";
import { requireIntegrationAccountId, requireOrganisationId } from "./test-ids";

const ORGANISATION_ID = requireOrganisationId("organisation_cleanup_adapters");
const ACCOUNT_ID = requireIntegrationAccountId("account_cleanup_adapters");
const BEARER_CREDENTIALS: ProviderCleanupCredentials = {
  bearer: { kind: "bearer", value: "provider-bearer" },
  expiringBearer: null,
  oauthTokens: null,
  squareDelegation: null,
};
const OAUTH_CREDENTIALS: ProviderCleanupCredentials = {
  bearer: null,
  expiringBearer: null,
  oauthTokens: {
    kind: "oauth_tokens",
    accessToken: "provider-access",
    refreshToken: "provider-refresh",
    expiry: { kind: "provider_managed" },
  },
  squareDelegation: null,
};
const NO_CREDENTIALS: ProviderCleanupCredentials = {
  bearer: null,
  expiringBearer: null,
  oauthTokens: null,
  squareDelegation: null,
};
const EXPIRING_BEARER_CREDENTIALS: ProviderCleanupCredentials = {
  bearer: null,
  expiringBearer: {
    kind: "expiring_bearer",
    value: "customer-business-token",
    expiresAt: 1_800_000_000_000,
  },
  oauthTokens: null,
  squareDelegation: null,
};

describe("compiled provider cleanup adapters", providerCleanupAdapterSuite);

function providerCleanupAdapterSuite(): void {
  it("uninstalls the exact Slack application grant", removesSlackInstallation);
  it(
    "deauthorizes the exact Stripe connected account",
    removesStripeConnection,
  );
  it("uninstalls the Shopify application", removesShopifyApplication);
  it("revokes the Notion OAuth token", removesNotionGrant);
  it("revokes the Google refresh token", removesGmailGrant);
  it(
    "removes Meta app subscription only for the last WhatsApp account",
    removesWhatsAppAccess,
  );
  it(
    "settles Airtable removal with an explicit manual action",
    settlesAirtableManually,
  );
}

async function removesSlackInstallation(): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ok: true }));
  const result = await slackCleanupAdapter.remove({
    cleanup: {
      cleanupId: "cleanup-slack",
      organisationId: ORGANISATION_ID,
      integrationAccountId: ACCOUNT_ID,
      provider: "slack",
      environment: "development",
      providerAccountId: "T123",
      providerConnectionId: "connection-slack",
      credentialHandles: ["vault:slack"],
    },
    env: {
      SLACK_CLIENT_ID: "slack-client",
      SLACK_CLIENT_SECRET: "slack-secret",
    },
    credentials: BEARER_CREDENTIALS,
    fetcher,
  });
  expect(result).toEqual({ kind: "removed" });
  expect(fetcher).toHaveBeenCalledWith(
    "https://slack.com/api/apps.uninstall",
    expect.objectContaining({
      method: "POST",
      body: new URLSearchParams({
        client_id: "slack-client",
        client_secret: "slack-secret",
        token: "provider-bearer",
      }),
    }),
  );
}

async function removesStripeConnection(): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ stripe_user_id: "acct_cleanup" }));
  const result = await stripeCleanupAdapter.remove({
    cleanup: {
      cleanupId: "cleanup-stripe",
      organisationId: ORGANISATION_ID,
      integrationAccountId: ACCOUNT_ID,
      provider: "stripe",
      environment: "development",
      providerAccountId: "acct_cleanup",
      providerConnectionId: "connection-stripe",
      credentialHandles: [],
    },
    env: {
      STRIPE_CONNECT_CLIENT_ID: "stripe-client",
      STRIPE_CONNECT_CLIENT_SECRET: "stripe-secret",
    },
    credentials: NO_CREDENTIALS,
    fetcher,
  });
  expect(result).toEqual({ kind: "removed" });
  expect(fetcher).toHaveBeenCalledWith(
    "https://connect.stripe.com/oauth/deauthorize",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: `Basic ${btoa("stripe-secret:")}`,
      }),
      body: new URLSearchParams({
        client_id: "stripe-client",
        stripe_user_id: "acct_cleanup",
      }),
    }),
  );
}

async function removesShopifyApplication(): Promise<void> {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      data: {
        appUninstall: { app: { id: "gid://shopify/App/1" }, userErrors: [] },
      },
    }),
  );
  const result = await shopifyCleanupAdapter.remove({
    cleanup: {
      cleanupId: "cleanup-shopify",
      organisationId: ORGANISATION_ID,
      integrationAccountId: ACCOUNT_ID,
      provider: "shopify",
      environment: "development",
      providerAccountId: "merchant.myshopify.com",
      providerConnectionId: "connection-shopify",
      credentialHandles: ["vault:shopify"],
    },
    env: {},
    credentials: BEARER_CREDENTIALS,
    fetcher,
  });
  expect(result).toEqual({ kind: "removed" });
  expect(fetcher).toHaveBeenCalledWith(
    "https://merchant.myshopify.com/admin/api/2026-07/graphql.json",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "x-shopify-access-token": "provider-bearer",
      }),
    }),
  );
}

async function removesNotionGrant(): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ request_id: "request-1" }));
  const result = await notionCleanupAdapter.remove({
    cleanup: {
      cleanupId: "cleanup-notion",
      organisationId: ORGANISATION_ID,
      integrationAccountId: ACCOUNT_ID,
      provider: "notion",
      environment: "development",
      providerAccountId: "workspace-notion",
      providerConnectionId: "connection-notion",
      credentialHandles: ["vault:notion"],
    },
    env: {
      NOTION_OAUTH_CLIENT_ID: "notion-client",
      NOTION_OAUTH_CLIENT_SECRET: "notion-secret",
    },
    credentials: OAUTH_CREDENTIALS,
    fetcher,
  });
  expect(result).toEqual({ kind: "removed" });
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.notion.com/v1/oauth/revoke",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ token: "provider-access" }),
    }),
  );
}

async function removesGmailGrant(): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 200 }));
  const result = await gmailCleanupAdapter.remove({
    cleanup: {
      cleanupId: "cleanup-gmail",
      organisationId: ORGANISATION_ID,
      integrationAccountId: ACCOUNT_ID,
      provider: "gmail",
      environment: "development",
      providerAccountId: "owner@example.com",
      providerConnectionId: "connection-gmail",
      credentialHandles: ["vault:gmail"],
    },
    env: {},
    credentials: OAUTH_CREDENTIALS,
    fetcher,
  });
  expect(result).toEqual({ kind: "removed" });
  expect(fetcher).toHaveBeenCalledWith(
    "https://oauth2.googleapis.com/revoke",
    expect.objectContaining({
      method: "POST",
      body: new URLSearchParams({ token: "provider-refresh" }),
    }),
  );
}

async function removesWhatsAppAccess(): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true }));
  const result = await whatsappCleanupAdapter.remove({
    cleanup: {
      cleanupId: "cleanup-whatsapp",
      organisationId: ORGANISATION_ID,
      integrationAccountId: ACCOUNT_ID,
      provider: "whatsapp",
      environment: "development",
      providerAccountId: "phone-number-1",
      providerConnectionId: "connection-whatsapp",
      credentialHandles: [],
      wabaId: "123456789",
      removeApplicationSubscription: true,
    },
    env: {
      WHATSAPP_APP_ID: "app-id",
      WHATSAPP_APP_SECRET: "app-secret",
    },
    credentials: EXPIRING_BEARER_CREDENTIALS,
    fetcher,
  });
  expect(result).toEqual({ kind: "removed" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toContain("123456789/subscribed_apps");
}

async function settlesAirtableManually(): Promise<void> {
  const fetcher = vi.fn<typeof fetch>();
  const result = await airtableCleanupAdapter.remove({
    cleanup: {
      cleanupId: "cleanup-airtable",
      organisationId: ORGANISATION_ID,
      integrationAccountId: ACCOUNT_ID,
      provider: "airtable",
      environment: "development",
      providerAccountId: "airtable-user",
      providerConnectionId: "connection-airtable",
      credentialHandles: ["vault:airtable"],
    },
    env: {},
    credentials: OAUTH_CREDENTIALS,
    fetcher,
  });
  expect(result).toEqual({
    kind: "manual_action_required",
    reason: "provider_cleanup_provider_rejected",
    instruction: "revoke_airtable_access_in_airtable",
  });
  expect(fetcher).not.toHaveBeenCalled();
}
