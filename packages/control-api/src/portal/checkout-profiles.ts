import type { CheckoutProfile } from "@purin-labs/commerce-contracts";
import { parseCheckoutProfile } from "@purin-labs/commerce-client";
import { hasExactKeys, isRecord } from "@purin-labs/std";

export type CheckoutProfileSummary = Readonly<{
  profile: CheckoutProfile;
  configurationDigest: string;
}>;

export function parseProfileMutation(raw: unknown): CheckoutProfileSummary {
  const object = requireObject(raw, "checkout profile mutation response");
  requireExactKeys(
    object,
    ["ok", "profile"],
    "checkout profile mutation response",
  );
  if (object.ok !== true) {
    throw new Error("The checkout profile change was rejected.");
  }
  return parseProfileSummary(object.profile);
}

export function parseProfileSummary(raw: unknown): CheckoutProfileSummary {
  const object = requireObject(raw, "checkout profile summary");
  requireExactKeys(
    object,
    ["profile", "configurationDigest"],
    "checkout profile summary",
  );
  const configurationDigest = requireDigest(object.configurationDigest);
  return { profile: parseCheckoutProfile(object.profile), configurationDigest };
}

function requireDigest(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw)) {
    throw new Error("Checkout profile configuration digest is invalid.");
  }
  return raw;
}

export function requireObject(
  raw: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new Error(`${field} must be an object.`);
  }
  return raw;
}

export function requireExactKeys(
  raw: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  if (!hasExactKeys(raw, keys)) throw new Error(`${field} fields are invalid.`);
}
