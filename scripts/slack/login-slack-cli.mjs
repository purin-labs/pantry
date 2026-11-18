#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function main() {
  const token = requiredEnv("SLACK_APP_CONFIG_TOKEN");
  const cliPath = resolveSlackCliPath();
  runSlackCli(cliPath, buildSlackCliLoginArgs(token));
  runSlackCli(cliPath, ["auth", "list", "--skip-update", "--no-color"]);
}

export function buildSlackCliLoginArgs(token) {
  return ["auth", "login", "--token", token, "--skip-update", "--no-color"];
}

export function resolveSlackCliPath() {
  const configured = optionalEnv("SLACK_CLI_PATH");

  if (configured !== null) {
    return configured;
  }

  const localInstall = join(homedir(), ".local", "bin", "slack");
  return existsSync(localInstall) ? localInstall : "slack";
}

export function runSlackCli(cliPath, args) {
  const result = spawnSync(cliPath, args, { stdio: "inherit" });

  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Slack CLI at ${cliPath}: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(`Slack CLI exited with status ${result.status}`);
  }
}

function requiredEnv(name) {
  const value = optionalEnv(name);

  if (value === null) {
    throw new Error(
      `${name} is required; run pnpm slack:config-token:import first`,
    );
  }

  return value;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  return value.length === 0 ? null : value;
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function isMainModule(moduleUrl, entryPath) {
  return (
    typeof entryPath === "string" &&
    fileURLToPath(moduleUrl) === resolve(entryPath)
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    handleFatalError(error);
  }
}
