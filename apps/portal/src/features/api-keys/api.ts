import { isRecord } from "@purin-labs/std";
import type { CommerceApiScope } from "@purin-labs/commerce-client";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../../control-client";
import { type CommerceApiKey, parseKey, unexpected } from "@purin-labs/control-api/portal/api-keys";

/** Scopes that no API key may hold; Commerce refuses them for a key. */
export type KeyForbiddenScope = "payments:record" | "credentials:write";

export type GrantableScope = Exclude<CommerceApiScope, KeyForbiddenScope>;

/**
 * Every scope that an owner can give a key, in the order the form shows them.
 * A new Commerce scope fails the type check here until it has a label.
 */
export const GRANTABLE_SCOPE_LABELS: Readonly<Record<GrantableScope, string>> =
  {
    "catalog:read": "Read products",
    "catalog:write": "Change products",
    "inventory:read": "Read stock",
    "inventory:write": "Change stock",
    "orders:read": "Read orders",
    "orders:write": "Change orders",
    "customers:read": "Read customers",
    "customers:write": "Change customers",
    "discounts:read": "Read discounts",
    "discounts:write": "Change discounts",
    "stored_value:read": "Read gift cards and store credit",
    "stored_value:write": "Change gift cards and store credit",
    "settings:read": "Read shop settings",
    "settings:write": "Change shop settings",
    "events:read": "Read the event feed",
    "webhooks:write": "Manage webhooks",
    "entity_plane:read": "Read shared records",
    "entity_plane:write": "Change shared records",
  };

export const GRANTABLE_SCOPES = Object.keys(
  GRANTABLE_SCOPE_LABELS,
) as readonly GrantableScope[];

/** A new key and its secret. The Platform answers the secret one time only. */
type IssuedCommerceApiKey = Readonly<{
  apiKey: CommerceApiKey;
  key: string | null;
}>;

function keysPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/api-keys`;
}

export async function readCommerceApiKeys(
  organisationId: string,
): Promise<readonly CommerceApiKey[]> {
  const raw = await controlRead(keysPath(organisationId));
  const list = isRecord(raw) ? raw.apiKeys : undefined;
  if (!Array.isArray(list)) throw unexpected();
  return list.map((item: unknown) => parseKey(item));
}

export async function issueCommerceApiKey(
  organisationId: string,
  draft: Readonly<{ label: string; scopes: readonly GrantableScope[] }>,
): Promise<IssuedCommerceApiKey> {
  const raw = await controlMutation(
    keysPath(organisationId),
    "POST",
    { label: draft.label, scopes: draft.scopes },
    undefined,
    // Each submission is a new key; a retry of a failed send uses a new key.
    { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
  );
  if (!isRecord(raw)) throw unexpected();
  return {
    apiKey: parseKey(raw.apiKey),
    key: typeof raw.key === "string" ? raw.key : null,
  };
}

export async function revokeCommerceApiKey(
  organisationId: string,
  credentialId: string,
): Promise<CommerceApiKey> {
  const raw = await controlMutation(
    `${keysPath(organisationId)}/${encodeURIComponent(credentialId)}/revocation`,
    "POST",
    {},
    undefined,
    `commerce_api_key.revoke:${credentialId}`,
  );
  if (!isRecord(raw)) throw unexpected();
  return parseKey(raw.apiKey);
}

export function apiKeyErrorMessage(error: unknown): string {
  const code =
    error instanceof ControlApiError &&
    isRecord(error.details) &&
    typeof error.details.error === "string"
      ? error.details.error
      : null;
  switch (code) {
    case "api_key_rejected":
      return "Pantry cannot give a key one of these scopes. Choose fewer scopes.";
    case "api_key_not_found":
      return "This key is no longer listed.";
    case "api_key_request_invalid":
      return "Give the key a name and at least one scope.";
    case "underclerk_binding_missing":
      return "This workspace has no shop yet.";
    case "underclerk_unavailable":
      return "Pantry could not reach the shop. Try again.";
    default:
      return error instanceof Error
        ? error.message
        : "Pantry could not reach the shop. Try again.";
  }
}
