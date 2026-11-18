#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";

const APP_PATH = "integrations/shopify";

async function main() {
  const clientId = requiredEnv("SHOPIFY_CLIENT_ID");
  requiredEnv("SHOPIFY_APP_AUTOMATION_TOKEN");

  await runShopifyCli([
    "app",
    "config",
    "link",
    "--path",
    APP_PATH,
    "--client-id",
    clientId,
    "--no-color",
  ]);
}

async function runShopifyCli(args) {
  const child = spawn("pnpm", ["dlx", "@shopify/cli@latest", ...args], {
    env: process.env,
    stdio: "inherit",
  });

  const [exitCode] = await once(child, "exit");

  if (exitCode !== 0) {
    throw new Error(`Shopify CLI exited with status ${String(exitCode)}`);
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";

  if (value.length === 0) {
    throw new Error(`${name} is required in .env.local`);
  }

  return value;
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

await main().catch(handleFatalError);
