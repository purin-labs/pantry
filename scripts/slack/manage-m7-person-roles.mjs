#!/usr/bin/env node

import process from "node:process";
import { handleFatalError, requiredLocalEnv } from "../lib/cli.mjs";

const PERSON_ID_PATTERN = /^person_[A-Za-z0-9-]+$/u;
const OPERATIONS = new Set(["grant", "revoke"]);
const ROLES = new Set(["command", "approve"]);

async function main() {
  const workerUrl = requiredLocalEnv("PANTRY_WORKER_URL");
  const adminToken = requiredLocalEnv("ORGANISATION_ADMIN_TOKEN");
  const organisationId = `organisation_${requiredLocalEnv("SLACK_TEAM_ID")}`;
  const command = process.argv[2] ?? "";

  if (command === "list") {
    await listPeople(workerUrl, adminToken, organisationId);
    return;
  }

  if (OPERATIONS.has(command)) {
    await configureRole(
      workerUrl,
      adminToken,
      organisationId,
      command,
      process.argv[3],
      process.argv[4],
    );
    return;
  }

  throw new Error(usage());
}

async function listPeople(workerUrl, adminToken, organisationId) {
  const url = new URL("/v1/admin/person-roles", workerUrl);
  url.searchParams.set("organisationId", organisationId);
  const response = await fetch(url, { headers: adminHeaders(adminToken) });
  const body = await readJson(response);

  requireSuccess(response, body);
  console.log(JSON.stringify(body.people, null, 2));
}

async function configureRole(
  workerUrl,
  adminToken,
  organisationId,
  operation,
  personId,
  role,
) {
  if (typeof personId !== "string" || !PERSON_ID_PATTERN.test(personId)) {
    throw new Error("A valid person_<id> value is required.");
  }

  if (typeof role !== "string" || !ROLES.has(role)) {
    throw new Error("Role must be command or approve.");
  }

  const url = new URL("/v1/admin/person-roles", workerUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: adminHeaders(adminToken),
    body: JSON.stringify({ organisationId, personId, operation, role }),
  });
  const body = await readJson(response);

  requireSuccess(response, body);
  console.log(JSON.stringify(body.result, null, 2));
}

function adminHeaders(adminToken) {
  return {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };
}

async function readJson(response) {
  const parsed = await response.json();
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed
    : {};
}

function requireSuccess(response, body) {
  if (response.ok && body.ok === true) {
    return;
  }

  const error = body.error;

  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const code =
      typeof error.code === "string" ? error.code : `http_${response.status}`;
    const message =
      typeof error.message === "string" ? error.message : "request failed";
    throw new Error(`${code}: ${message}`);
  }

  throw new Error(`Person role request failed with HTTP ${response.status}.`);
}

function usage() {
  return [
    "Usage:",
    "  pnpm identity:m7:roles -- list",
    "  pnpm identity:m7:roles -- grant person_<id> command|approve",
    "  pnpm identity:m7:roles -- revoke person_<id> command|approve",
  ].join("\n");
}

await main().catch(handleFatalError);
