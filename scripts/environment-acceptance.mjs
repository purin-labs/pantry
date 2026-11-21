import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readWorkerEnvironment,
  requireLocalWorkerSecrets,
  validateWorkerOrigins,
} from "./worker-environment.mjs";
import { startLocalProviderIngressServer } from "./slack/run-local-event-tunnel.mjs";

const [environment, outputPath, ...extra] = process.argv.slice(2);
if (environment !== "local" || outputPath === undefined || extra.length > 0) {
  throw new Error(
    "Usage: node scripts/environment-acceptance.mjs local <result.json>",
  );
}

const platform = readWorkerEnvironment("platform", environment);
const commerceEngine = readWorkerEnvironment("commerce", environment);
validateWorkerOrigins("platform", environment, platform);
validateWorkerOrigins("commerce", environment, commerceEngine);
const secrets = requireLocalWorkerSecrets("platform", platform);
requireLocalWorkerSecrets("commerce", commerceEngine);
const signingSecret = secrets.SLACK_SIGNING_SECRET;
assert.ok(
  typeof signingSecret === "string" && signingSecret.length > 0,
  "Local Slack signing secret is required",
);

const platformOrigin = `http://${platform.dev.ip}:${platform.dev.port}`;
const commerceOrigin = `http://${commerceEngine.dev.ip}:${commerceEngine.dev.port}`;
const health = [];
for (const origin of [platformOrigin, commerceOrigin]) {
  const response = await fetch(`${origin}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, `${origin} is unavailable`);
  health.push({ origin, status: response.status });
}

const rejectedTargets = [];
for (const args of [
  ["platform", "dev", "production"],
  ["platform", "deploy", "local"],
  ["platform", "dev", "local", "--remote"],
]) {
  const rejected = spawnSync(
    process.execPath,
    ["scripts/run-worker.mjs", ...args],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(
    rejected.status,
    1,
    `Unsafe target was accepted: ${args.join(" ")}`,
  );
  assert.doesNotMatch(rejected.stdout, /Ready on|Uploaded/u);
  rejectedTargets.push({ args, exitCode: rejected.status });
}

const server = startLocalProviderIngressServer(platformOrigin);
const probes = [];
try {
  await once(server, "listening");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    type: "url_verification",
    challenge: "Plan 41 café ingress",
  });
  const headers = signedHeaders(signingSecret, timestamp, body);
  for (const attempt of ["first", "repeat"]) {
    const response = await sendIngress("/slack/events", body, headers);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      challenge: "Plan 41 café ingress",
    });
    probes.push({ kind: attempt, status: response.status });
  }
  const tampered = await sendIngress("/slack/events", `${body} `, headers);
  assert.equal(tampered.status, 401);
  probes.push({ kind: "tampered_body", status: tampered.status });
  const staleTimestamp = (Number(timestamp) - 600).toString();
  const stale = await sendIngress(
    "/slack/events",
    body,
    signedHeaders(signingSecret, staleTimestamp, body),
  );
  assert.equal(stale.status, 401);
  probes.push({ kind: "expired_signature", status: stale.status });
  const unsigned = await sendIngress("/slack/events", body, {
    "content-type": "application/json",
  });
  assert.equal(unsigned.status, 401);
  probes.push({ kind: "unsigned_request", status: unsigned.status });
  for (const path of ["/v1/control/organisations", "/portal", "/health"]) {
    const response = await fetch(`http://127.0.0.1:3111${path}`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 404);
    probes.push({ kind: "protected_path", path, status: response.status });
  }
} finally {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

const result = {
  plan: "41",
  observedAt: new Date().toISOString(),
  environment,
  workerNames: [platform.name, commerceEngine.name],
  squareEnvironment: platform.vars.SQUARE_OAUTH_ENVIRONMENT,
  health,
  rejectedTargets,
  ingress: probes,
  slackMessagesSent: 0,
  productionMutations: 0,
};
await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
console.log(`Environment E2E passed; result saved to ${outputPath}`);

function signedHeaders(secret, timestamp, body) {
  const signature = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${signature}`,
  };
}

function sendIngress(path, body, headers) {
  return fetch(`http://127.0.0.1:3111${path}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5_000),
  });
}
