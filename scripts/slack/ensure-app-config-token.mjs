#!/usr/bin/env node

import { once } from "node:events";
import process from "node:process";

import { upsertLocalEnv } from "./local-env.mjs";
import { readWorkerEnvironment } from "../worker-environment.mjs";
import { isRecord } from "../../packages/std/src/index.ts";
import { handleFatalError, isMainModule } from "../lib/cli.mjs";

const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_ENV_PATH = ".env.local";
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = readWorkerEnvironment("platform", args.environment);
  const appId = profile.vars.SLACK_APP_ID;
  if (typeof appId !== "string" || appId.trim().length === 0)
    throw new Error("SLACK_APP_ID is required in the selected profile");
  const expectedTeamId = requiredEnv("SLACK_TEAM_ID");

  if (args.importToken) {
    const importedRefreshToken = await promptForConfigurationRefreshToken(
      process.stdin,
      process.stderr,
    );
    const rotated = await rotateConfigurationToken(importedRefreshToken);
    assertConfigurationTeam(rotated, expectedTeamId);
    await verifyAppAccess(rotated.token, appId);
    await upsertLocalEnv(args.envFile, {
      SLACK_APP_CONFIG_TOKEN: rotated.token,
      SLACK_APP_CONFIG_REFRESH_TOKEN: rotated.refreshToken,
      SLACK_USER_ID: rotated.userId,
    });
    console.log(
      `Rotated and saved Slack App Configuration credentials to ${args.envFile}.`,
    );
    console.log(`Verified manifest access to ${appId}.`);
    return;
  }

  const refreshToken = optionalEnv("SLACK_APP_CONFIG_REFRESH_TOKEN");

  if (refreshToken !== null) {
    const rotated = await rotateConfigurationToken(refreshToken);
    assertConfigurationTeam(rotated, expectedTeamId);
    await verifyAppAccess(rotated.token, appId);
    await upsertLocalEnv(args.envFile, {
      SLACK_APP_CONFIG_TOKEN: rotated.token,
      SLACK_APP_CONFIG_REFRESH_TOKEN: rotated.refreshToken,
      SLACK_USER_ID: rotated.userId,
    });
    console.log(
      `Rotated and atomically replaced Slack configuration credentials in ${args.envFile}.`,
    );
    console.log(`Verified manifest access to ${appId}.`);
    return;
  }

  const token = requiredEnv("SLACK_APP_CONFIG_TOKEN");
  await verifyAppAccess(token, appId);
  console.log(
    `The saved Slack service/configuration token can manage ${appId}.`,
  );
  console.log("No refresh token is configured, so no rotation was required.");
}

function parseArgs(argv) {
  const args = {
    environment: null,
    envFile: DEFAULT_ENV_PATH,
    importToken: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--environment":
        args.environment = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--":
        break;
      case "--env-file":
        args.envFile = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--import":
        args.importToken = true;
        break;
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readRequiredArg(argv, index, flag) {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function requiredEnv(name) {
  const value = optionalEnv(name);

  if (value === null) {
    const suffix =
      name === "SLACK_APP_CONFIG_TOKEN"
        ? "; run pnpm slack:config-token:import after copying a Seams token"
        : "";
    throw new Error(`${name} is required${suffix}`);
  }

  return value;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  return value.length === 0 ? null : value;
}

async function promptForConfigurationRefreshToken(input, output) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Token import requires an interactive terminal");
  }

  const refreshToken = await promptForHiddenTerminalValue(
    input,
    output,
    "Paste the Seams configuration Refresh Token (input hidden): ",
  );

  if (!refreshToken.startsWith("xoxe-") || refreshToken.length < 32) {
    throw new Error(
      "The pasted Slack App Configuration refresh token is invalid",
    );
  }

  return refreshToken;
}

export async function promptForHiddenTerminalValue(input, output, message) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Secret import requires an interactive terminal");
  }

  output.write(message);
  let value;

  try {
    value = normalizeHiddenTerminalValue(await readHiddenLine(input));
  } finally {
    output.write("\n");
  }

  return value;
}

export function normalizeHiddenTerminalValue(value) {
  return value
    .replace(/^\[200~/u, "")
    .replace(/\[201~$/u, "")
    .trim();
}

async function readHiddenLine(input) {
  const wasRaw = input.isRaw === true;
  let value = "";

  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();

  try {
    while (true) {
      const [chunk] = await once(input, "data");

      if (typeof chunk !== "string") {
        throw new Error("Terminal input returned a non-text value");
      }

      const parsed = consumeHiddenInputChunk(value, chunk);
      value = parsed.value;

      if (parsed.kind === "complete") {
        return value;
      }

      if (parsed.kind === "cancelled") {
        throw new Error("Slack App Configuration token import was cancelled");
      }
    }
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
  }
}

export function consumeHiddenInputChunk(currentValue, chunk) {
  let value = currentValue;

  for (const character of chunk) {
    if (character === "\u0003") {
      return { kind: "cancelled", value };
    }

    if (character === "\r" || character === "\n") {
      return { kind: "complete", value };
    }

    if (character === "\u007f" || character === "\b") {
      value = value.slice(0, -1);
      continue;
    }

    if (character >= " ") {
      value += character;
    }
  }

  return { kind: "pending", value };
}

async function rotateConfigurationToken(refreshToken) {
  const body = new URLSearchParams();
  body.set("refresh_token", refreshToken);
  const response = await fetch(`${SLACK_API_BASE}/tooling.tokens.rotate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = await parseSlackResponse(response);

  if (parsed.ok !== true) {
    throw new Error(
      `Slack tooling token rotation failed: ${slackErrorCode(parsed, response)}`,
    );
  }

  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error("Slack tooling token rotation returned no access token");
  }

  if (
    typeof parsed.refresh_token !== "string" ||
    parsed.refresh_token.length === 0
  ) {
    throw new Error(
      "Slack tooling token rotation returned no replacement refresh token",
    );
  }

  if (typeof parsed.team_id !== "string" || parsed.team_id.length === 0) {
    throw new Error("Slack tooling token rotation returned no team id");
  }

  if (typeof parsed.user_id !== "string" || parsed.user_id.length === 0) {
    throw new Error("Slack tooling token rotation returned no user id");
  }

  return {
    token: parsed.token,
    refreshToken: parsed.refresh_token,
    teamId: parsed.team_id,
    userId: parsed.user_id,
  };
}

function assertConfigurationTeam(rotated, expectedTeamId) {
  if (rotated.teamId !== expectedTeamId) {
    throw new Error(
      `Slack tooling credentials belong to ${rotated.teamId}, expected ${expectedTeamId}`,
    );
  }
}

async function verifyAppAccess(token, appId) {
  const body = new URLSearchParams();
  body.set("token", token);
  body.set("app_id", appId);
  const response = await fetch(`${SLACK_API_BASE}/apps.manifest.export`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = await parseSlackResponse(response);

  if (parsed.ok !== true) {
    throw new Error(
      `Slack token cannot manage ${appId}: ${slackErrorCode(parsed, response)}`,
    );
  }
}

export async function parseSlackResponse(response) {
  const raw = await response.text();

  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { ok: false, error: "object_required" };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

function slackErrorCode(parsed, response) {
  return typeof parsed.error === "string"
    ? parsed.error
    : `http_${response.status}`;
}

function printUsageAndExit(code) {
  console.log(`Usage:
  pnpm slack:config-token:import
  pnpm slack:config-token:refresh

Import reads an existing refresh token from a hidden interactive terminal prompt,
rotates it into a fresh access/refresh pair, verifies access to the selected app, and
saves both replacements to .env.local. Direct calls require --environment local
or --environment production. Refresh rotates the configured token and
atomically stores both replacement credentials.`);
  process.exit(code);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch(handleFatalError);
}
