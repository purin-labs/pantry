#!/usr/bin/env node

import process from "node:process";

import { promptForHiddenTerminalValue } from "./ensure-app-config-token.mjs";
import { upsertLocalEnv } from "./local-env.mjs";
import {
  handleFatalError,
  isMainModule,
  requiredLocalEnv,
} from "../lib/cli.mjs";

const ENV_PATH = ".env.local";

async function main() {
  const workerUrl = requiredLocalEnv("SATYR_WORKER_URL");
  const teamId = requiredLocalEnv("SLACK_TEAM_ID");
  const organisationId = `organisation_${teamId}`;
  const shopDomain = requiredLocalEnv("SHOPIFY_SHOP_DOMAIN");
  const configuredAdminToken =
    process.env.ORGANISATION_ADMIN_TOKEN?.trim() ?? "";
  const adminToken =
    configuredAdminToken.length > 0
      ? configuredAdminToken
      : await promptForHiddenTerminalValue(
          process.stdin,
          process.stderr,
          "Paste the Satyr organisation admin token (input hidden): ",
        );
  const clientId = await configuredOrPrompt(
    "SHOPIFY_CLIENT_ID",
    "Paste the Shopify app Client ID (input hidden): ",
  );
  const clientSecret = await configuredOrPrompt(
    "SHOPIFY_CLIENT_SECRET",
    "Paste the Shopify app Client Secret (input hidden): ",
  );
  assertShopifyDomain(shopDomain);
  assertShopifyClientId(clientId);
  assertShopifyClientSecret(clientSecret);
  const integrationAccountId = await storeShopifyCredential(
    workerUrl,
    adminToken,
    {
      organisationId,
      shopDomain,
      clientId,
      clientSecret,
    },
  );
  await upsertLocalEnv(ENV_PATH, {
    SHOPIFY_INTEGRATION_ACCOUNT_ID: integrationAccountId,
  });

  console.log(
    `Stored the ${shopDomain} Shopify credential for ${organisationId}.`,
  );
}

export function assertShopifyDomain(value) {
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(value) ||
    value.length > 255
  ) {
    throw new Error(
      "SHOPIFY_SHOP_DOMAIN must be the exact lowercase .myshopify.com domain",
    );
  }
}

export function assertShopifyClientId(value) {
  if (value.length < 16 || value.length > 255 || /\s/u.test(value)) {
    throw new Error("The pasted Shopify Client ID is invalid");
  }
}

export function assertShopifyClientSecret(value) {
  if (value.length < 16 || value.length > 255 || /\s/u.test(value)) {
    throw new Error("The pasted Shopify Client Secret is invalid");
  }
}

async function configuredOrPrompt(name, prompt) {
  const configured = process.env[name]?.trim() ?? "";

  return configured.length > 0
    ? configured
    : promptForHiddenTerminalValue(process.stdin, process.stderr, prompt);
}

async function storeShopifyCredential(workerUrl, adminToken, credential) {
  const response = await fetch(`${workerUrl}/v1/admin/shopify-credential`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    body: JSON.stringify(credential),
  });
  const body = await readJson(response);

  if (!response.ok || body.ok !== true) {
    throw new Error(readFailure(body, response.status));
  }

  return readIntegrationAccountId(body);
}

function readIntegrationAccountId(body) {
  const value = body.integrationAccountId;

  if (typeof value !== "string" || !value.startsWith("integration_")) {
    throw new Error(
      "Shopify credential response did not include an integration account id",
    );
  }

  return value;
}

function adminHeaders(adminToken) {
  return {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };
}

async function readJson(response) {
  const parsed = await response.json();
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed
    : {};
}

function readFailure(body, status) {
  const error = body.error;

  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const code = typeof error.code === "string" ? error.code : `http_${status}`;
    const message =
      typeof error.message === "string" ? error.message : "request failed";
    return `${code}: ${message}`;
  }

  return `Shopify credential import failed with HTTP ${status}`;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch(handleFatalError);
}
