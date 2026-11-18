#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  readWorkerEnvironment,
  requireLocalWorkerSecrets,
  validateWorkerOrigins,
} from "../worker-environment.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOCAL_INGRESS_HOST = "127.0.0.1";
const LOCAL_INGRESS_PORT = 3111;
const MAX_EVENT_BYTES = 1_048_576;
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;
const SHOPIFY_WEBHOOK_PATH_PATTERN = /^\/hook\/shopify\/[^/]+$/u;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

if (process.argv[1] === SCRIPT_PATH) await main();

async function main() {
  const [environment, ...extra] = process.argv.slice(2);
  if (environment !== "local" || extra.length > 0)
    throw new Error("Provider ingress requires the explicit local profile");
  const config = readWorkerEnvironment("platform", environment);
  validateWorkerOrigins("platform", environment, config);
  const secrets = requireLocalWorkerSecrets("platform", config);
  const settings = localSlackSettings(config, secrets);
  const server = startLocalProviderIngressServer(settings.platformOrigin);
  const tunnel = startLocalIngressTunnel();
  const exited = once(tunnel, "exit");
  process.once("SIGINT", stopLocalIngressTunnel.bind(null, tunnel));
  process.once("SIGTERM", stopLocalIngressTunnel.bind(null, tunnel));
  process.once("exit", stopLocalIngressTunnel.bind(null, tunnel));
  try {
    await once(server, "listening");
    await waitForPlatform(settings.platformOrigin);
    const publicOrigin = await readLocalIngressOrigin(tunnel);
    await updateLocalSlackApp(`${publicOrigin}/slack/events`);
    console.log(`PROVIDER INGRESS READY ${publicOrigin}`);
    await exited;
  } finally {
    server.close();
    stopLocalIngressTunnel(tunnel);
  }
}

function localSlackSettings(config, secrets) {
  for (const key of ["SLACK_APP_ID", "SLACK_CLIENT_ID"]) {
    if (
      typeof config.vars[key] !== "string" ||
      config.vars[key].trim().length === 0
    )
      throw new Error(`${key} is required in env.local.vars`);
  }
  for (const key of ["SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"]) {
    if (!secrets[key]?.trim())
      throw new Error(`${key} is required in Platform .dev.vars.local`);
  }
  return {
    platformOrigin: `http://${config.dev.ip}:${config.dev.port}`,
  };
}

export function startLocalProviderIngressServer(platformOrigin) {
  return createServer(receiveProviderRequest.bind(null, platformOrigin)).listen(
    LOCAL_INGRESS_PORT,
    LOCAL_INGRESS_HOST,
  );
}

export function startLocalIngressTunnel() {
  const tunnel = spawn(
    "cloudflared",
    [
      "tunnel",
      "--url",
      `http://${LOCAL_INGRESS_HOST}:${LOCAL_INGRESS_PORT}`,
      "--metrics",
      `${LOCAL_INGRESS_HOST}:0`,
      "--no-autoupdate",
    ],
    {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  tunnel.stdout.pipe(process.stdout);
  return tunnel;
}

export function stopLocalIngressTunnel(tunnel) {
  if (tunnel.exitCode === null && tunnel.signalCode === null)
    tunnel.kill("SIGTERM");
}

async function updateLocalSlackApp(requestUrl) {
  const tooling = parseEnv(
    await readFile(new URL("../../.env.local", import.meta.url), "utf8"),
  );
  const token = tooling.SLACK_APP_CONFIG_TOKEN?.trim();
  if (!token)
    throw new Error(
      "SLACK_APP_CONFIG_TOKEN is required in .env.local for the local app update",
    );
  await runNode(
    [
      "--env-file=.env.local",
      "scripts/slack/ensure-app-config-token.mjs",
      "--environment",
      "local",
      "--env-file",
      ".env.local",
    ],
    token,
  );
  const refreshed = parseEnv(
    await readFile(new URL("../../.env.local", import.meta.url), "utf8"),
  );
  const refreshedToken = refreshed.SLACK_APP_CONFIG_TOKEN?.trim();
  if (!refreshedToken)
    throw new Error("Slack tooling refresh did not save its access token");
  await runNode(
    [
      "scripts/slack/create-dev-app.mjs",
      "--environment",
      "local",
      "--manifest",
      "scripts/slack/pantry-public-manifest.json",
      "--request-url",
      requestUrl,
    ],
    refreshedToken,
  );
}

function receiveProviderRequest(platformOrigin, request, response) {
  void forwardProviderRequest(platformOrigin, request, response).catch(
    sendProxyFailure.bind(null, response),
  );
}

async function forwardProviderRequest(platformOrigin, request, response) {
  const route = providerRoute(request);
  if (route === null) {
    sendText(response, 404, "Not found");
    return;
  }
  if (route.kind === "slack" && !hasSlackSignature(request.headers)) {
    sendText(response, 401, "Slack signature required");
    return;
  }

  const body = await readRequestBody(request);
  const upstream = await fetch(`${platformOrigin}${route.path}`, {
    method: "POST",
    headers:
      route.kind === "slack"
        ? forwardedSlackHeaders(request.headers)
        : forwardedShopifyHeaders(request.headers),
    body,
  });
  response.writeHead(upstream.status, {
    "content-type":
      upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

export function providerRoute(request) {
  if (request.method !== "POST") return null;
  if (request.url === "/slack/events") {
    return { kind: "slack", path: request.url };
  }
  if (
    request.url !== undefined &&
    SHOPIFY_WEBHOOK_PATH_PATTERN.test(request.url)
  ) {
    return { kind: "shopify", path: request.url };
  }
  return null;
}

function hasSlackSignature(headers) {
  return (
    typeof headers["x-slack-signature"] === "string" &&
    typeof headers["x-slack-request-timestamp"] === "string"
  );
}

function forwardedSlackHeaders(headers) {
  const forwarded = {
    "content-type":
      typeof headers["content-type"] === "string"
        ? headers["content-type"]
        : "application/json",
    "x-slack-signature": headers["x-slack-signature"],
    "x-slack-request-timestamp": headers["x-slack-request-timestamp"],
  };
  copyOptionalHeader(headers, forwarded, "x-slack-retry-num");
  copyOptionalHeader(headers, forwarded, "x-slack-retry-reason");
  return forwarded;
}

export function forwardedShopifyHeaders(headers) {
  const forwarded = {
    "content-type":
      typeof headers["content-type"] === "string"
        ? headers["content-type"]
        : "application/json",
  };
  copyOptionalHeader(headers, forwarded, "x-shopify-api-version");
  copyOptionalHeader(headers, forwarded, "x-shopify-hmac-sha256");
  copyOptionalHeader(headers, forwarded, "x-shopify-shop-domain");
  copyOptionalHeader(headers, forwarded, "x-shopify-topic");
  copyOptionalHeader(headers, forwarded, "x-shopify-triggered-at");
  copyOptionalHeader(headers, forwarded, "x-shopify-webhook-id");
  return forwarded;
}

function copyOptionalHeader(source, destination, name) {
  const value = source[name];
  if (typeof value === "string") destination[name] = value;
}

async function readRequestBody(request) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_EVENT_BYTES)
      throw new Error("Provider event exceeds the local ingress limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendProxyFailure(response, error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (response.headersSent) {
    response.end();
    return;
  }
  sendText(response, 502, "Provider ingress unavailable");
}

function sendText(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

export async function readLocalIngressOrigin(tunnel) {
  tunnel.stderr.pipe(process.stderr);
  const lines = createInterface({ input: tunnel.stderr, crlfDelay: Infinity });
  for await (const line of lines) {
    const match = line.match(TUNNEL_URL_PATTERN);
    if (match !== null) return match[0];
  }
  throw new Error("cloudflared stopped before assigning a public URL");
}

async function waitForPlatform(platformOrigin) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await platformIsReady(platformOrigin)) return;
    await delay(250);
  }
  throw new Error("The local platform did not become ready within 30 seconds");
}

async function platformIsReady(platformOrigin) {
  try {
    const response = await fetch(`${platformOrigin}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise(resolveDelay.bind(undefined, milliseconds));
}

function resolveDelay(milliseconds, resolve) {
  setTimeout(resolve, milliseconds);
}

async function runNode(args, token) {
  const child = spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: slackChildEnvironment(token),
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit");
  if (code === 0) return;
  throw new Error(
    `Node command stopped with ${signal === null ? `status ${code ?? 1}` : `signal ${signal}`}`,
  );
}

function slackChildEnvironment(token) {
  const env = { ...process.env };
  delete env.SLACK_APP_CONFIG_TOKEN;
  delete env.SLACK_APP_CONFIG_REFRESH_TOKEN;
  delete env.SLACK_APP_ID;
  delete env.SLACK_CLIENT_ID;
  delete env.SLACK_CLIENT_SECRET;
  delete env.SLACK_SIGNING_SECRET;
  delete env.SLACK_TEAM_ID;
  env.SLACK_APP_CONFIG_TOKEN = token;
  return env;
}
