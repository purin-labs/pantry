// The entry and environment helpers of the command-line scripts (the Slack,
// Stripe and Commerce lab setup scripts).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../../packages/std/src/index.ts";

/** True when the module at `moduleUrl` is the script that Node runs. */
export function isMainModule(moduleUrl, entryPath) {
  return (
    typeof entryPath === "string" &&
    fileURLToPath(moduleUrl) === resolve(entryPath)
  );
}

/** Prints the message of a failure and sets the exit code to 1. */
export function handleFatalError(error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}

/** The trimmed value of the environment variable `name` from .env.local. */
export function requiredLocalEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`${name} is required in .env.local`);
  }
  return value;
}
