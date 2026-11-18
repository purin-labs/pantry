#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { handleFatalError, requiredLocalEnv } from "../lib/cli.mjs";

const APP_PATH = "integrations/shopify";

async function main() {
  const clientId = requiredLocalEnv("SHOPIFY_CLIENT_ID");
  requiredLocalEnv("SHOPIFY_APP_AUTOMATION_TOKEN");

  const child = spawn(
    "pnpm",
    [
      "dlx",
      "@shopify/cli@latest",
      "app",
      "deploy",
      "--path",
      APP_PATH,
      "--client-id",
      clientId,
      "--allow-updates",
      "--no-color",
      "--message",
      "Configure Satyr commerce cue webhooks",
    ],
    { env: process.env, stdio: "inherit" },
  );
  const [exitCode] = await once(child, "exit");

  if (exitCode !== 0) {
    throw new Error(`Shopify CLI exited with status ${String(exitCode)}`);
  }
}

await main().catch(handleFatalError);
