#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

import { upsertLocalEnv } from "./local-env.mjs";
import {
  readWorkerEnvironment,
  validateWorkerOrigins,
} from "../worker-environment.mjs";
import { isRecord } from "../../packages/std/src/index.ts";

const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_MANIFEST_PATH = "scripts/slack/pantry-dev-manifest.json";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readWorkerEnvironment("platform", args.environment);
  validateWorkerOrigins("platform", args.environment, config);
  const manifest = await loadManifest(args.manifestPath);
  const callbacks = [
    `${config.vars.PANTRY_OAUTH_CALLBACK_ORIGIN}/slack/install`,
    `${config.vars.PANTRY_OAUTH_CALLBACK_ORIGIN}/v1/control/providers/slack/callback`,
  ];
  args.redirectUrls = callbacks;
  if (args.operation === "update") {
    const appId = config.vars.SLACK_APP_ID;
    if (typeof appId !== "string" || appId.trim().length === 0)
      throw new Error("SLACK_APP_ID is required in the selected profile");
    args.appId = appId;
  }
  if (!args.withoutEvents && args.requestUrl === null) {
    if (args.environment === "local")
      throw new Error(
        "Local Slack updates require --request-url from the local ingress tunnel",
      );
    args.requestUrl = manifest.settings?.event_subscriptions?.request_url;
  }
  if (args.environment === "production" && !args.withoutEvents) {
    const expectedUrl = manifest.settings?.event_subscriptions?.request_url;
    assertHttpsUrl(expectedUrl, "manifest event request_url");
    if (args.requestUrl !== expectedUrl)
      throw new Error(
        "Production Slack ingress must match the selected manifest",
      );
  }
  const preparedManifest = prepareManifest(manifest, args);

  if (args.dryRun) {
    printDryRun(preparedManifest);
    return;
  }

  const token = readConfigToken();
  const validation = await callSlackManifestApi({
    method: "apps.manifest.validate",
    token,
    manifest: preparedManifest,
    teamId: args.teamId,
    appId: args.appId,
  });

  if (!validation.ok) {
    failWithSlackError("manifest validation failed", validation);
  }

  console.log("Manifest validation passed.");

  if (args.validateOnly) {
    return;
  }

  const method =
    args.appId === null ? "apps.manifest.create" : "apps.manifest.update";
  const result = await callSlackManifestApi({
    method,
    token,
    manifest: preparedManifest,
    teamId: args.teamId,
    appId: args.appId,
  });

  if (!result.ok) {
    failWithSlackError(
      args.appId === null ? "app creation failed" : "app update failed",
      result,
    );
  }

  if (args.appId === null) {
    await persistCreatedApp(result, args.writeEnvPath);
    printCreatedApp(result, args.writeEnvPath);
    return;
  }

  printUpdatedApp(result, args.appId);
}

function parseArgs(argv) {
  const parsed = {
    environment: null,
    operation: "update",
    manifestPath: DEFAULT_MANIFEST_PATH,
    requestUrl: null,
    redirectUrls: [],
    appName: null,
    botName: null,
    appId: null,
    teamId: process.env.SLACK_TEAM_ID ?? null,
    writeEnvPath: null,
    withoutEvents: false,
    dryRun: false,
    validateOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--environment":
        parsed.environment = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--manifest":
        parsed.manifestPath = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--request-url":
        parsed.requestUrl = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--app-name":
        parsed.appName = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--bot-name":
        parsed.botName = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--create":
        parsed.operation = "create";
        parsed.appId = null;
        break;
      case "--team-id":
        parsed.teamId = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--write-env":
        parsed.writeEnvPath = readRequiredArg(argv, index, arg);
        index += 1;
        break;
      case "--without-events":
        parsed.withoutEvents = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--validate-only":
        parsed.validateOnly = true;
        break;
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsageAndExit(1);
    }
  }

  return parsed;
}

function readRequiredArg(argv, index, flag) {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith("--")) {
    console.error(`Missing value for ${flag}`);
    printUsageAndExit(1);
  }

  return value;
}

async function loadManifest(path) {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error("manifest root must be a JSON object");
  }

  return parsed;
}

function prepareManifest(manifest, args) {
  const prepared = structuredClone(manifest);
  ensureManifestShape(prepared);

  if (args.withoutEvents) {
    delete prepared.settings.event_subscriptions;
  } else if (args.requestUrl !== null) {
    assertHttpsUrl(args.requestUrl, "--request-url");
    prepared.settings.event_subscriptions.request_url = args.requestUrl;
  }

  ensureOAuthShape(prepared);

  prepared.oauth_config.redirect_urls = args.redirectUrls;

  for (const redirectUrl of prepared.oauth_config.redirect_urls) {
    assertHttpsUrl(redirectUrl, "manifest redirect_url");
  }

  if (args.appName !== null) {
    prepared.display_information.name = args.appName;
  }

  if (args.botName !== null) {
    prepared.features.bot_user.display_name = args.botName;
  }

  return prepared;
}

function ensureManifestShape(manifest) {
  if (!isRecord(manifest.display_information)) {
    manifest.display_information = {};
  }

  if (!isRecord(manifest.features)) {
    manifest.features = {};
  }

  if (!isRecord(manifest.features.bot_user)) {
    manifest.features.bot_user = {};
  }

  if (!isRecord(manifest.settings)) {
    manifest.settings = {};
  }

  if (!isRecord(manifest.settings.event_subscriptions)) {
    manifest.settings.event_subscriptions = {};
  }
}

function ensureOAuthShape(manifest) {
  if (!isRecord(manifest.oauth_config)) {
    manifest.oauth_config = {};
  }

  if (!isRecord(manifest.oauth_config.scopes)) {
    manifest.oauth_config.scopes = {};
  }

  if (!Array.isArray(manifest.oauth_config.scopes.bot)) {
    manifest.oauth_config.scopes.bot = [];
  }
}

function assertHttpsUrl(value, label) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https`);
  }
}

function readConfigToken() {
  const token = process.env.SLACK_APP_CONFIG_TOKEN?.trim() ?? "";

  if (token.length === 0) {
    throw new Error(
      "SLACK_APP_CONFIG_TOKEN is required unless --dry-run is used",
    );
  }

  return token;
}

async function callSlackManifestApi(input) {
  const body = new URLSearchParams();
  body.set("token", input.token);
  body.set("manifest", JSON.stringify(input.manifest));

  if (input.teamId !== null && input.teamId.trim().length > 0) {
    body.set("team_id", input.teamId.trim());
  }

  if (input.appId !== null && input.appId.trim().length > 0) {
    body.set("app_id", input.appId.trim());
  }

  const response = await fetch(`${SLACK_API_BASE}/${input.method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const raw = await response.text();

  return parseSlackResponse(response, raw);
}

function parseSlackResponse(response, raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: "invalid_json_response",
      status: response.status,
      body: raw.slice(0, 500),
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: "non_object_response",
      status: response.status,
      body: raw.slice(0, 500),
    };
  }

  return parsed;
}

function printUpdatedApp(updated, appId) {
  const responseAppId = readString(updated, "app_id") || appId;
  const appSettingsUrl = `https://api.slack.com/apps/${responseAppId}`;

  console.log("Slack app manifest updated.");
  console.log("");
  console.log(`App ID: ${responseAppId}`);
  console.log(`App Settings URL: ${appSettingsUrl}`);
  console.log("");
  console.log("Next:");
  console.log("1. Confirm Worker secrets are set.");
  console.log(
    "2. Open /slack/install/start on the Worker host and reinstall the app.",
  );
  console.log("3. Invite the bot to a test channel and send a mention.");
}

async function persistCreatedApp(created, envPath) {
  if (envPath === null) return;
  const credentials = isRecord(created.credentials) ? created.credentials : {};
  await upsertLocalEnv(envPath, {
    SLACK_APP_ID: requiredResponseString(created, "app_id"),
    SLACK_CLIENT_ID: requiredResponseString(credentials, "client_id"),
    SLACK_CLIENT_SECRET: requiredResponseString(credentials, "client_secret"),
    SLACK_SIGNING_SECRET: requiredResponseString(credentials, "signing_secret"),
  });
}

function printCreatedApp(created, envPath) {
  const appId = readString(created, "app_id");
  const appSettingsUrl = `https://api.slack.com/apps/${appId}`;

  console.log("Slack app created.");
  console.log("");
  console.log(`App ID: ${appId}`);
  console.log(`App Settings URL: ${appSettingsUrl}`);
  if (envPath !== null) console.log(`App credentials saved to ${envPath}.`);
  console.log("");
  console.log("Next:");
  console.log(
    "1. Open the App Settings URL, then OAuth & Permissions -> Install to Workspace.",
  );
  console.log(
    "2. Invite the bot to a test channel and send Satyr the Team ID and Channel ID.",
  );
}

function printDryRun(manifest) {
  console.log(JSON.stringify(manifest, null, 2));
}

function failWithSlackError(message, response) {
  console.error(message);
  console.error(JSON.stringify(redactSlackResponse(response), null, 2));
  process.exit(1);
}

function redactSlackResponse(response) {
  const copy = structuredClone(response);

  if (isRecord(copy.credentials)) {
    copy.credentials = {
      ...copy.credentials,
      client_secret: redactString(copy.credentials.client_secret),
      signing_secret: redactString(copy.credentials.signing_secret),
    };
  }

  return copy;
}

function redactString(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  return `${value.slice(0, 4)}...redacted`;
}

function readString(record, key) {
  const value = record[key];

  return typeof value === "string" ? value : "";
}

function requiredResponseString(record, key) {
  const value = readString(record, key);
  if (value.length === 0)
    throw new Error(`Slack app creation returned no ${key}`);
  return value;
}

function printUsageAndExit(code) {
  console.log(`Usage:
  SLACK_APP_CONFIG_TOKEN=xoxe... node scripts/slack/create-dev-app.mjs [options]

Options:
  --environment <target>  Required local or production Wrangler profile.
  --manifest <path>       Manifest JSON path. Default: ${DEFAULT_MANIFEST_PATH}
  --request-url <url>     Local tunnel Events API request URL.
  --app-name <name>       Override display_information.name.
  --bot-name <name>       Override features.bot_user.display_name.
  --create                Create a new app instead of updating the profile's app.
  --team-id <team-id>     Required only when using an org-level config token.
  --write-env <path>      Save new app credentials to a local env file.
  --without-events        Create the app without Events API configuration.
  --validate-only         Validate the manifest and stop.
  --dry-run               Print the prepared manifest without calling Slack.
  --help                  Show this help.
`);
  process.exit(code);
}

await main();
