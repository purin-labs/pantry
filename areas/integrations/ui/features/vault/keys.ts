import { isRecord } from "@purin-labs/std";

import type { CredentialAccountRecord } from "@purin-labs/control-api/portal/credential-inventory";
import { providerLabel } from "@purin-labs/area-integrations-contract/ui/integration-catalogue";
import type { IntegrationRouteId } from "../integrations/model";

/**
 * The API keys tab: a read-only list of the credentials that Integrations
 * already stored. It shows metadata only; Integrations stays the place where a
 * key is added, rotated or revoked.
 */
export type VaultKeyStatus = "stored" | "attention" | "revoked" | "missing";

export type VaultKeyView = Readonly<{
  keyId: string;
  name: string;
  service: string;
  kindLabel: string;
  status: VaultKeyStatus;
  changedAt: number | null;
  integrationId: IntegrationRouteId | null;
  accountId: string | null;
}>;

const ROUTED_PROVIDERS: Readonly<Record<string, IntegrationRouteId>> = {
  airtable: "airtable",
  dropbox: "dropbox",
  gmail: "gmail",
  google_drive: "google_drive",
  notion: "notion",
  shopify: "shopify",
  slack: "slack",
  square: "square",
  stripe: "stripe",
  whatsapp: "whatsapp",
};

/** Accounts that people removed are history, not keys in use. */
function isListedAccount(record: CredentialAccountRecord): boolean {
  return record.lifecycle !== "revoked";
}

export function keysOfInventory(
  accounts: readonly CredentialAccountRecord[],
): readonly VaultKeyView[] {
  return accounts.filter(isListedAccount).map(keyOfAccount);
}

function keyOfAccount(record: CredentialAccountRecord): VaultKeyView {
  const active = record.generations.find(
    (generation) => generation.lifecycle === "active",
  );
  const vault = active?.vault ?? { status: "missing" as const };
  const status: VaultKeyStatus =
    vault.status === "missing"
      ? "missing"
      : vault.status === "revoked"
        ? "revoked"
        : record.lifecycle === "active"
          ? "stored"
          : "attention";
  return {
    keyId: `account:${record.integrationAccountId}`,
    name: record.displayName,
    service:
      record.provider === "custom_api"
        ? "Custom connector"
        : providerLabel(record.provider),
    kindLabel: authModeLabel(record.connection.authMode),
    status,
    changedAt:
      vault.status === "missing" ? null : (vault.rotatedAt ?? vault.storedAt),
    integrationId: ROUTED_PROVIDERS[record.provider] ?? null,
    accountId: record.integrationAccountId,
  };
}

function authModeLabel(authMode: string): string {
  switch (authMode) {
    case "api_key":
      return "API key";
    case "shared_pantry_app":
      return "App authorization";
    case "webhook_secret":
      return "Webhook secret";
    default:
      return "Provider sign-in";
  }
}

/** The organisation's own model key, when the inference route uses one. */
export function keysOfInferenceSelection(
  raw: unknown,
): readonly VaultKeyView[] {
  const kind =
    isRecord(raw) && isRecord(raw.selection) ? raw.selection.kind : null;
  const name =
    kind === "organisation_openai_api_key"
      ? "OpenAI API key"
      : kind === "organisation_anthropic_api_key"
        ? "Anthropic API key"
        : kind === "organisation_google_api_key"
          ? "Gemini API key"
          : null;
  return name === null
    ? []
    : [
        {
          keyId: `inference:${String(kind)}`,
          name,
          service: "AI account",
          kindLabel: "API key",
          status: "stored",
          changedAt: null,
          integrationId: "codex",
          accountId: null,
        },
      ];
}

export function keyStatusLabel(status: VaultKeyStatus): string {
  switch (status) {
    case "stored":
      return "Stored";
    case "attention":
      return "Needs attention";
    case "revoked":
      return "Revoked";
    case "missing":
      return "Not stored";
  }
}
