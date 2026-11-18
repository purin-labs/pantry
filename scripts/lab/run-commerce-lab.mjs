#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout as delayExecution } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const COMMERCE_LAB_SCENARIO_IDS = Object.freeze([
  "product-listing",
  "happy-order",
  "payment-failed",
  "inventory-shortage",
  "shipment-delayed",
  "cancellation-refund",
]);
const SCENARIO_SETTLEMENT_TIMEOUT_MS = 90_000;

async function main() {
  const options = parseLabOptions(process.argv.slice(2), process.env);
  console.error(
    `Commerce lab target: ${options.baseUrl} (${options.organisationId})`,
  );
  const result = await runCommerceLabWorkflow(options, {
    fetchImplementation: fetch,
    clock: Date.now,
    delay: delayExecution,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;

  if (options.outputPath === null) {
    process.stdout.write(output);
    return;
  }

  await writeFile(options.outputPath, output, "utf8");
  console.log(`Wrote commerce lab result to ${options.outputPath}.`);
}

export function parseLabOptions(args, environment) {
  const normalizedArgs = args.filter(isArgument);
  const command = normalizedArgs[0];
  let scenarioId = command === "scenario" ? normalizedArgs[1] : null;
  let baseUrl = environment.SATYR_WORKER_URL ?? null;
  let organisationId = environment.SATYR_LAB_ORGANISATION_ID ?? null;
  let namespace = environment.SATYR_COMMERCE_LAB_NAMESPACE ?? null;
  let token = environment.ORGANISATION_ADMIN_TOKEN ?? null;
  const signingSecret = environment.SATYR_COMMERCE_LAB_SIGNING_SECRET ?? null;
  let outputPath = null;
  let idempotencyKey = null;
  let remoteAcknowledged = false;
  const optionStart = command === "scenario" ? 2 : 1;

  for (let index = optionStart; index < normalizedArgs.length; index += 1) {
    const option = normalizedArgs[index];
    if (option === "--remote-yes") {
      remoteAcknowledged = true;
      continue;
    }
    const value = normalizedArgs[index + 1];

    if (value === undefined) {
      throw new Error(`Incomplete commerce lab option: ${option}`);
    }

    if (option === "--base-url") {
      baseUrl = value;
    } else if (option === "--organisation") {
      organisationId = value;
    } else if (option === "--namespace") {
      namespace = value;
    } else if (option === "--token") {
      token = value;
    } else if (option === "--output") {
      outputPath = value;
    } else if (option === "--idempotency-key") {
      idempotencyKey = value;
    } else {
      throw new Error(`Unknown commerce lab option: ${option}`);
    }

    index += 1;
  }

  validateCommand(command, scenarioId);
  validateConnection(baseUrl, organisationId, token);
  const normalizedBaseUrl = stripTrailingSlash(baseUrl);
  if (
    isMutationCommand(command) &&
    !isLocalhostUrl(normalizedBaseUrl) &&
    !remoteAcknowledged
  ) {
    throw new Error(
      `Remote commerce lab mutation target ${normalizedBaseUrl} (${organisationId}) requires --remote-yes`,
    );
  }

  if (
    (command === "reset" || command === "seed" || command === "scenario") &&
    !isLabNamespace(namespace)
  ) {
    throw new Error(
      "SATYR_COMMERCE_LAB_NAMESPACE must start with lab_ and contain 8-128 characters",
    );
  }

  if (command !== "scenario") {
    scenarioId = null;
  }

  return {
    command,
    scenarioId,
    baseUrl: normalizedBaseUrl,
    organisationId,
    namespace,
    token,
    signingSecret,
    outputPath,
    idempotencyKey,
    remoteAcknowledged,
  };
}

export async function runCommerceLabWorkflow(options, dependencies) {
  const created = await runCommerceLab(
    options,
    dependencies.fetchImplementation,
  );
  if (options.command !== "scenario") return created;
  if (!nonEmptyString(options.signingSecret)) {
    throw new Error(
      "SATYR_COMMERCE_LAB_SIGNING_SECRET is required for scenario delivery",
    );
  }
  const run = parseCreatedScenario(created);
  for (const event of run.events) {
    await postSignedScenarioEvent({
      options,
      run,
      event,
      fetchImplementation: dependencies.fetchImplementation,
      clock: dependencies.clock,
    });
  }
  return waitForScenarioCompletion({
    options,
    runId: run.runId,
    fetchImplementation: dependencies.fetchImplementation,
    clock: dependencies.clock,
    delay: dependencies.delay,
  });
}

export async function runCommerceLab(options, fetchImplementation) {
  if (options.command === "verify") {
    return requestVerification(options, fetchImplementation);
  }

  const route = routeForMutation(options);
  const body = bodyForMutation(options);
  const response = await requestJson(
    fetchImplementation,
    route,
    requestInit(options.token, "POST", body),
  );

  if (options.command === "scenario") {
    return readEnvelope(response, "run");
  }

  return readEnvelope(response, "result");
}

function isArgument(value) {
  return value !== "--";
}

function validateCommand(command, scenarioId) {
  if (!["reset", "seed", "scenario", "verify"].includes(command)) {
    throw new Error(
      "Commerce lab command must be reset, seed, scenario <id>, or verify",
    );
  }

  if (
    command === "scenario" &&
    !COMMERCE_LAB_SCENARIO_IDS.includes(scenarioId)
  ) {
    throw new Error(
      `Scenario must be one of: ${COMMERCE_LAB_SCENARIO_IDS.join(", ")}`,
    );
  }
}

function validateConnection(baseUrl, organisationId, token) {
  if (!isHttpUrl(baseUrl)) {
    throw new Error("SATYR_WORKER_URL must be an http(s) URL");
  }

  if (!nonEmptyString(organisationId)) {
    throw new Error("SATYR_LAB_ORGANISATION_ID is required");
  }

  if (!nonEmptyString(token)) {
    throw new Error("ORGANISATION_ADMIN_TOKEN is required");
  }
}

function isMutationCommand(command) {
  return command === "reset" || command === "seed" || command === "scenario";
}

function isLocalhostUrl(value) {
  const hostname = new URL(value).hostname;
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function routeForMutation(options) {
  const organisation = encodeURIComponent(options.organisationId);
  const root = `${options.baseUrl}/v1/admin/commerce-lab/${organisation}`;

  if (options.command === "scenario") {
    return `${root}/scenarios/${encodeURIComponent(options.scenarioId)}`;
  }

  return `${root}/${options.command}`;
}

function bodyForMutation(options) {
  if (options.command === "reset" || options.command === "seed") {
    return { labNamespace: options.namespace };
  }

  return {
    labNamespace: options.namespace,
    idempotencyKey:
      options.idempotencyKey ??
      `lab_${options.scenarioId.replaceAll("-", "_")}_v1`,
  };
}

async function requestVerification(options, fetchImplementation) {
  const organisation = encodeURIComponent(options.organisationId);
  const route = `${options.baseUrl}/v1/admin/commerce-lab/${organisation}/verify`;
  const response = await requestJson(
    fetchImplementation,
    route,
    requestInit(options.token, "GET", null),
  );

  return readEnvelope(response, "verification");
}

async function postSignedScenarioEvent(input) {
  const signedAt = input.clock();
  const observedAt = input.event.occurredAt;
  const body = JSON.stringify({
    schemaVersion: "satyr.commerce.lab.event.v1",
    namespace: input.options.namespace,
    runId: input.run.runId,
    scenarioId: input.run.scenarioId,
    organisationId: input.options.organisationId,
    integrationAccountId: input.run.integrationAccountId,
    observedAt,
    event: input.event,
  });
  const timestamp = Math.floor(signedAt / 1_000);
  const organisation = encodeURIComponent(input.options.organisationId);
  const response = await requestJson(
    input.fetchImplementation,
    `${input.options.baseUrl}/v1/hooks/commerce-lab/${organisation}/events`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-satyr-lab-timestamp": String(timestamp),
        "x-satyr-lab-signature": commerceLabSignature(
          input.options.signingSecret,
          timestamp,
          body,
        ),
      },
      body,
    },
  );
  if (!isRecord(response) || response.ok !== true || response.queued !== true) {
    throw new Error(`Commerce lab event ${input.event.eventId} was not queued`);
  }
}

async function waitForScenarioCompletion(input) {
  const deadline = input.clock() + SCENARIO_SETTLEMENT_TIMEOUT_MS;
  while (input.clock() <= deadline) {
    const verification = await requestVerification(
      input.options,
      input.fetchImplementation,
    );
    const runs = Array.isArray(verification.runs) ? verification.runs : [];
    const run = findRun(runs, input.runId);
    if (isRecord(run) && run.result !== "running") {
      if (run.result !== "success") {
        throw new Error(
          `Commerce lab scenario ${input.runId} finished as ${String(run.result)}`,
        );
      }
      return run;
    }
    await input.delay(250);
  }
  throw new Error(
    `Commerce lab scenario ${input.runId} did not settle within 90 seconds`,
  );
}

function findRun(runs, runId) {
  for (const candidate of runs) {
    if (isRecord(candidate) && candidate.runId === runId) return candidate;
  }
  return null;
}

function parseCreatedScenario(value) {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.runId) ||
    !nonEmptyString(value.scenarioId) ||
    !nonEmptyString(value.integrationAccountId) ||
    !Array.isArray(value.events)
  ) {
    throw new Error("Commerce lab scenario response is invalid");
  }
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      !nonEmptyString(event.eventId) ||
      !nonEmptyString(event.occurredAt)
    ) {
      throw new Error("Commerce lab scenario event is invalid");
    }
  }
  return value;
}

export function commerceLabSignature(signingSecret, timestamp, body) {
  return `v1=${createHmac("sha256", signingSecret)
    .update(`v1:${timestamp}:${body}`, "utf8")
    .digest("hex")}`;
}

function requestInit(token, method, body) {
  const init = {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  };

  if (body === null) {
    return init;
  }

  return {
    ...init,
    headers: {
      ...init.headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function requestJson(fetchImplementation, url, init) {
  const response = await fetchImplementation(url, init);
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Commerce lab returned non-JSON response (${response.status})`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Commerce lab request failed (${response.status}): ${safeError(payload)}`,
    );
  }

  return payload;
}

function readEnvelope(payload, field) {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload[field])) {
    throw new Error(`Commerce lab response is missing ${field}`);
  }

  return payload[field];
}

function safeError(payload) {
  if (
    isRecord(payload) &&
    isRecord(payload.error) &&
    nonEmptyString(payload.error.code)
  ) {
    return payload.error.code;
  }

  return "request_failed";
}

function isLabNamespace(value) {
  return (
    nonEmptyString(value) &&
    value.startsWith("lab_") &&
    value.length >= 8 &&
    value.length <= 128
  );
}

function isHttpUrl(value) {
  if (!nonEmptyString(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
