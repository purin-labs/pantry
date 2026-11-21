#!/usr/bin/env node

import process from "node:process";

import {
  parseSlackResponse,
  promptForHiddenTerminalValue,
} from "./ensure-app-config-token.mjs";
import { upsertLocalEnv } from "./local-env.mjs";
import { handleFatalError, isMainModule } from "../lib/cli.mjs";

const SLACK_API_BASE = "https://slack.com/api";
const ENV_PATH = ".env.local";

async function main() {
  const expectedTeamId = requiredEnv("SLACK_TEAM_ID");
  requiredEnv("SLACK_USER_ID");

  const botToken = await promptForHiddenTerminalValue(
    process.stdin,
    process.stderr,
    "Paste the Pantry Dev Bot User OAuth Token (input hidden): ",
  );
  const signingSecret = await promptForHiddenTerminalValue(
    process.stdin,
    process.stderr,
    "Paste the Pantry Dev Signing Secret (input hidden): ",
  );
  assertM6CredentialShapes(botToken, signingSecret);

  const botIdentity = await fetchBotIdentity(botToken);

  if (botIdentity.teamId !== expectedTeamId) {
    throw new Error(
      `Slack bot token belongs to ${botIdentity.teamId}, expected ${expectedTeamId}`,
    );
  }

  await upsertLocalEnv(ENV_PATH, {
    SLACK_BOT_TOKEN: botToken,
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_USER_ID: botIdentity.userId,
  });
  console.log(`Saved validated M6 Slack credentials to ${ENV_PATH}.`);
  console.log(`Verified bot identity for workspace ${expectedTeamId}.`);
}

export function assertM6CredentialShapes(botToken, signingSecret) {
  if (!botToken.startsWith("xoxb-") || botToken.length < 32) {
    throw new Error("The pasted Slack Bot User OAuth Token is invalid");
  }

  if (!/^[a-f0-9]{32}$/iu.test(signingSecret)) {
    throw new Error(
      "The pasted Slack Signing Secret must be 32 hexadecimal characters",
    );
  }
}

async function fetchBotIdentity(botToken) {
  const response = await fetch(`${SLACK_API_BASE}/auth.test`, {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}` },
  });
  const parsed = await parseSlackResponse(response);

  if (parsed.ok !== true) {
    const code =
      typeof parsed.error === "string"
        ? parsed.error
        : `http_${response.status}`;
    throw new Error(`Slack bot token validation failed: ${code}`);
  }

  if (typeof parsed.team_id !== "string" || parsed.team_id.length === 0) {
    throw new Error("Slack bot token validation returned no team id");
  }

  if (typeof parsed.user_id !== "string" || parsed.user_id.length === 0) {
    throw new Error("Slack bot token validation returned no bot user id");
  }

  return { teamId: parsed.team_id, userId: parsed.user_id };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";

  if (value.length === 0) {
    throw new Error(`${name} is required; run pnpm slack:cli:setup first`);
  }

  return value;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch(handleFatalError);
}
