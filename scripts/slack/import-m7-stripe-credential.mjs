#!/usr/bin/env node

import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { promptForHiddenTerminalValue } from "./ensure-app-config-token.mjs";
import { upsertLocalEnv } from "./local-env.mjs";

const ENV_PATH = ".env.local";

async function main() {
  const workerUrl = requiredEnv("SATYR_WORKER_URL");
  const teamId = requiredEnv("SLACK_TEAM_ID");
  const organisationId = `organisation_${teamId}`;
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
  const stripeSecret = await promptForHiddenTerminalValue(
    process.stdin,
    process.stderr,
    "Paste the Stripe test secret key (sk_test_..., input hidden): ",
  );

  assertStripeTestSecret(stripeSecret);
  const integrationAccountId = await storeStripeCredential(
    workerUrl,
    adminToken,
    organisationId,
    stripeSecret,
  );
  await upsertLocalEnv(ENV_PATH, {
    STRIPE_INTEGRATION_ACCOUNT_ID: integrationAccountId,
  });
  console.log(
    `Stored Stripe test-mode write credentials for ${organisationId}.`,
  );
}

async function storeStripeCredential(
  workerUrl,
  adminToken,
  organisationId,
  stripeSecret,
) {
  const response = await fetch(`${workerUrl}/v1/admin/stripe-test-credential`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ organisationId, secret: stripeSecret }),
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
      "Stripe credential response did not include an integration account id",
    );
  }

  return value;
}

export function assertStripeTestSecret(value) {
  if (!value.startsWith("sk_test_") || value.length < 24) {
    throw new Error("The pasted key is not a Stripe test-mode secret key");
  }
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

  return `Stripe credential import failed with HTTP ${status}`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";

  if (value.length === 0) {
    throw new Error(`${name} is required in .env.local`);
  }

  return value;
}

function isMainModule(moduleUrl, entryPath) {
  return (
    typeof entryPath === "string" &&
    fileURLToPath(moduleUrl) === resolve(entryPath)
  );
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch(handleFatalError);
}
