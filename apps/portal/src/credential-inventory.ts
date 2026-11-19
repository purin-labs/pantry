import type { CredentialAccountRecord, CredentialInventory } from "@purin-labs/control-api/portal/credential-inventory";

/** Supplying a replacement secret is only offered for API-key connections. */
export function credentialRotationSupported(
  record: CredentialAccountRecord,
): boolean {
  return (
    (record.provider === "airtable" ||
      record.provider === "notion" ||
      record.provider === "stripe" ||
      record.provider === "shopify") &&
    record.connection.authMode === "api_key"
  );
}

export function findCredentialAccountRecord(
  inventory: CredentialInventory | null | undefined,
  integrationAccountId: string,
): CredentialAccountRecord | null {
  if (inventory === null || inventory === undefined) return null;
  return (
    inventory.accounts.find(
      matchesCredentialAccount.bind(null, integrationAccountId),
    ) ?? null
  );
}

function matchesCredentialAccount(
  integrationAccountId: string,
  record: CredentialAccountRecord,
): boolean {
  return record.integrationAccountId === integrationAccountId;
}
