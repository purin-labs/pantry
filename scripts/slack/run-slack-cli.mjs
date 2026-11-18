#!/usr/bin/env node

import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSlackCliPath, runSlackCli } from "./login-slack-cli.mjs";

function main() {
  const commandArgs = process.argv.slice(2);

  if (commandArgs.length === 0) {
    throw new Error("A Slack CLI command is required");
  }

  const token = requiredEnv("SLACK_APP_CONFIG_TOKEN");
  runSlackCli(
    resolveSlackCliPath(),
    buildAuthenticatedSlackCliArgs(commandArgs, token),
  );
}

export function buildAuthenticatedSlackCliArgs(commandArgs, token) {
  return [...commandArgs, "--token", token, "--skip-update", "--no-color"];
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";

  if (value.length === 0) {
    throw new Error(`${name} is required; run pnpm slack:cli:setup first`);
  }

  return value;
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
