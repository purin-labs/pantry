#!/usr/bin/env node

import process from "node:process";

import { promptForHiddenTerminalValue } from "./ensure-app-config-token.mjs";
import { upsertLocalEnv } from "./local-env.mjs";
import { handleFatalError } from "../lib/cli.mjs";

const ENV_PATH = ".env.local";

async function main() {
  const token = await promptForHiddenTerminalValue(
    process.stdin,
    process.stderr,
    "Paste the Nuki App Automation Token (input hidden): ",
  );

  assertShopifyAutomationToken(token);
  await upsertLocalEnv(ENV_PATH, { SHOPIFY_APP_AUTOMATION_TOKEN: token });
  console.log(`Saved the Shopify App Automation Token to ${ENV_PATH}.`);
}

export function assertShopifyAutomationToken(value) {
  if (!/^atkn_[A-Za-z0-9_-]{32,}$/u.test(value)) {
    throw new Error("The pasted Shopify App Automation Token is invalid");
  }
}

await main().catch(handleFatalError);
