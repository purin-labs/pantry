#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { upsertLocalEnv } from "../slack/local-env.mjs";
import { syncWorkerSecret } from "./setup-m10-connect.mjs";

const DEFAULT_PANTRY_ORIGIN = "https://satyr-edge.n6378056.workers.dev";
const WEBHOOK_ID_NAME = "STRIPE_CONNECT_WEBHOOK_ID";
const WEBHOOK_SECRET_NAME = "STRIPE_CONNECT_WEBHOOK_SECRET";
const STRIPE_CONNECT_EVENTS = [
  "charge.failed",
  "invoice.payment_failed",
  "refund.failed",
  "customer.subscription.deleted",
  "account.application.deauthorized",
];

async function main() {
  const platformSecret = requireTestPlatformSecret(
    process.env.STRIPE_CONNECT_CLIENT_SECRET,
  );
  const origin = normalizeOrigin(
    process.env.SATYR_PUBLIC_ORIGIN ?? DEFAULT_PANTRY_ORIGIN,
  );
  const endpointUrl = `${origin}/hook/stripe/connect`;
  const registered = await createStripeConnectWebhook({
    platformSecret,
    endpointUrl,
    fetcher: fetch,
  });
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const envPath = resolve(repositoryRoot, ".env.local");
  await upsertLocalEnv(envPath, {
    [WEBHOOK_ID_NAME]: registered.id,
    [WEBHOOK_SECRET_NAME]: registered.secret,
  });
  syncWorkerSecret(repositoryRoot, WEBHOOK_ID_NAME, registered.id);
  syncWorkerSecret(repositoryRoot, WEBHOOK_SECRET_NAME, registered.secret);
  console.log(
    `Configured the shared Stripe Connect webhook at ${endpointUrl}.`,
  );
}

export async function createStripeConnectWebhook(input) {
  const body = stripeConnectWebhookBody(input.endpointUrl);
  let response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher("https://api.stripe.com/v1/webhook_endpoints", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.platformSecret}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": "satyr-m10-shared-connect-webhook-v1",
      },
      body,
    });
  } catch (error) {
    throw new Error(
      `Stripe Connect webhook request failed: ${errorMessage(error)}`,
    );
  }
  const raw = await readJson(response);
  if (!response.ok) {
    throw new Error(stripeResponseError(response.status, raw));
  }
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !raw.id.startsWith("we_") ||
    typeof raw.secret !== "string" ||
    !raw.secret.startsWith("whsec_")
  ) {
    throw new Error("Stripe returned an invalid Connect webhook response");
  }
  return { id: raw.id, secret: raw.secret };
}

export function stripeConnectWebhookBody(endpointUrl) {
  const body = new URLSearchParams();
  body.set("url", endpointUrl);
  body.set("connect", "true");
  for (const event of STRIPE_CONNECT_EVENTS) {
    body.append("enabled_events[]", event);
  }
  return body;
}

function requireTestPlatformSecret(raw) {
  const value = raw?.trim() ?? "";
  if (!/^sk_test_[A-Za-z0-9]{16,}$/u.test(value)) {
    throw new Error(
      "STRIPE_CONNECT_CLIENT_SECRET must be a test-mode sk_test_ key",
    );
  }
  return value;
}

function normalizeOrigin(raw) {
  const url = new URL(raw);
  return url.origin;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function stripeResponseError(status, raw) {
  if (isRecord(raw) && isRecord(raw.error)) {
    const code =
      typeof raw.error.code === "string" ? raw.error.code : "unknown";
    const param =
      typeof raw.error.param === "string" ? ` (${raw.error.param})` : "";
    return `Stripe rejected Connect webhook registration: HTTP ${status} ${code}${param}`;
  }
  return `Stripe rejected Connect webhook registration: HTTP ${status}`;
}

function isRecord(raw) {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function handleFatalError(error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}

function isMainModule(moduleUrl, entryPath) {
  return (
    typeof entryPath === "string" &&
    fileURLToPath(moduleUrl) === resolve(entryPath)
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch(handleFatalError);
}
