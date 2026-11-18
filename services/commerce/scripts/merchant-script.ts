// What the hand-run merchant scripts share: the command line (the
// organisation and the merchant, and the Commerce Worker's address and
// service token from the environment) and the checks of a client answer.
import type { CommerceMutationResultV1 } from "@seams/commerce-client";
import { pathToFileURL } from "node:url";

export type MerchantScriptArguments = Readonly<{
  organisationId: string;
  merchantId: string;
  baseUrl: string;
  serviceToken: string;
}>;

type ClientFailure = Readonly<{
  ok: false;
  error: Readonly<{ kind: string; message: string }>;
}>;

/** Whether the script at `moduleUrl` is the one that node runs. */
export function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined && moduleUrl === pathToFileURL(scriptPath).href
  );
}

export function clientFailure(operation: string, result: ClientFailure): Error {
  return new Error(
    `${operation} failed: ${result.error.kind}: ${result.error.message}`,
  );
}

/** `--organisation <id> --merchant <id>`, for the package script `command`. */
export function parseMerchantScriptArguments(
  command: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): MerchantScriptArguments {
  const values = new Map<string, string>();
  const start = argv[0] === "--" ? 1 : 0;
  for (let index = start; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        `Usage: ${command} --organisation <organisation_id> --merchant <merchant_id>`,
      );
    }
    values.set(flag, value);
  }
  return {
    organisationId: requireIdentity(
      values.get("--organisation"),
      "--organisation",
      "organisation_",
    ),
    merchantId: requireIdentity(
      values.get("--merchant"),
      "--merchant",
      "merchant_",
    ),
    baseUrl: requireUrl(env.UNDERCLERK_BASE_URL),
    serviceToken: requireSecret(env.UNDERCLERK_SERVICE_TOKEN),
  };
}

/**
 * Waits for a command that must apply and move the merchant to
 * `expectedRevision`, and returns that revision.
 */
export async function applyAtRevision(
  pending: Promise<
    Readonly<{ ok: true; value: CommerceMutationResultV1 }> | ClientFailure
  >,
  operation: string,
  expectedRevision: number,
): Promise<number> {
  const result = await pending;
  if (!result.ok) {
    throw clientFailure(operation, result);
  }
  if (result.value.outcome === "rejected") {
    throw new Error(
      `${operation} was rejected: ${JSON.stringify(result.value.error)}`,
    );
  }
  if (result.value.receipt.merchantRevision !== expectedRevision) {
    throw new Error(`${operation} produced an unexpected merchant revision`);
  }
  return expectedRevision;
}

function requireIdentity(
  value: string | undefined,
  field: string,
  prefix: string,
): string {
  if (
    value === undefined ||
    !value.startsWith(prefix) ||
    value !== value.trim()
  ) {
    throw new Error(`${field} must be a normalized ${prefix} identity`);
  }
  return value;
}

function requireUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("UNDERCLERK_BASE_URL is required");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("UNDERCLERK_BASE_URL must use http or https");
  }
  return parsed.toString();
}

function requireSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("UNDERCLERK_SERVICE_TOKEN is required");
  }
  return value;
}
