#!/usr/bin/env node

import process from "node:process";

import { promptForHiddenTerminalValue } from "./ensure-app-config-token.mjs";
import {
  assertShopifyClientId,
  assertShopifyClientSecret,
  assertShopifyDomain,
} from "./import-m7-shopify-credential.mjs";
import { upsertLocalEnv } from "./local-env.mjs";

const ENV_PATH = ".env.local";

async function main() {
  const shopDomain = await configuredOrPrompt(
    "SHOPIFY_SHOP_DOMAIN",
    "Paste the exact Shopify development-store .myshopify.com domain (input hidden): ",
  );
  const clientId = await configuredOrPrompt(
    "SHOPIFY_CLIENT_ID",
    "Paste the Shopify app Client ID (input hidden): ",
  );
  const clientSecret = await configuredOrPrompt(
    "SHOPIFY_CLIENT_SECRET",
    "Paste the Shopify app Client Secret (input hidden): ",
  );
  const webhookSigningSecret = await configuredOrPrompt(
    "SHOPIFY_WEBHOOK_SIGNING_SECRET",
    "Paste the Shopify Admin webhook signing secret (input hidden): ",
  );

  assertShopifyDomain(shopDomain);
  assertShopifyClientId(clientId);
  assertShopifyClientSecret(clientSecret);
  assertShopifyWebhookSigningSecret(webhookSigningSecret);
  await upsertLocalEnv(ENV_PATH, {
    SHOPIFY_SHOP_DOMAIN: shopDomain,
    SHOPIFY_CLIENT_ID: clientId,
    SHOPIFY_CLIENT_SECRET: clientSecret,
    SHOPIFY_WEBHOOK_SIGNING_SECRET: webhookSigningSecret,
  });
  console.log(`Saved Shopify development credentials to ${ENV_PATH}.`);
}

export function assertShopifyWebhookSigningSecret(value) {
  if (value.length < 16 || value.length > 255 || /\s/u.test(value)) {
    throw new Error(
      "The pasted Shopify Admin webhook signing secret is invalid",
    );
  }
}

async function configuredOrPrompt(name, prompt) {
  const configured = process.env[name]?.trim() ?? "";

  return configured.length > 0
    ? configured
    : promptForHiddenTerminalValue(process.stdin, process.stderr, prompt);
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

await main().catch(handleFatalError);
