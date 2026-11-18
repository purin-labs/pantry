import {
  parseVaultEventList,
  parseVaultItemList,
  parseVaultItemResult,
  parseVaultStoreResult,
  type VaultEvent,
  type VaultItemCommand,
  type VaultItemCreate,
  type VaultItemList,
  type VaultItemResult,
  type VaultStoreCommand,
  type VaultStoreResult,
} from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  ControlApiError,
  controlMutation,
  controlRead,
  controlSecretMutation,
} from "../../control-client";
import {
  inferencePath,
  vaultEventsPath,
  vaultItemsPath,
  vaultStorePath,
} from "../../control-paths";
import { parseCredentialInventoryResponse } from "@seams/control-api/portal/credential-inventory";
import {
  keysOfInferenceSelection,
  keysOfInventory,
  type VaultKeyView,
} from "./keys";

/** The Vault page talks to the Platform only through this, so previews can stand in. */
export type VaultTransport = Readonly<{
  list(organisationId: string): Promise<VaultItemList>;
  create(
    organisationId: string,
    create: VaultItemCreate,
  ): Promise<VaultItemResult>;
  command(
    organisationId: string,
    itemId: string,
    command: VaultItemCommand,
  ): Promise<VaultItemResult>;
  /** Owners and admins only: the inventory read refuses everyone else. */
  listKeys(organisationId: string): Promise<readonly VaultKeyView[]>;
  store(
    organisationId: string,
    command: VaultStoreCommand,
  ): Promise<VaultStoreResult>;
  events(
    organisationId: string,
    itemId: string | null,
  ): Promise<readonly VaultEvent[]>;
}>;

export const VAULT_TRANSPORT: VaultTransport = {
  async list(organisationId) {
    const list = parseVaultItemList(
      await controlRead(vaultItemsPath(organisationId)),
    );
    if (list === null) throw unexpected();
    return list;
  },
  // A sign-in carries a password, so it never enters the stored retry intent.
  async create(organisationId, create) {
    return parsedResult(
      await controlSecretMutation(
        vaultItemsPath(organisationId),
        "POST",
        create,
      ),
    );
  },
  async command(organisationId, itemId, command) {
    const path = `${vaultItemsPath(organisationId)}/${itemId}/commands`;
    return parsedResult(
      command.kind === "replace_sign_in"
        ? await controlSecretMutation(path, "POST", command)
        : await controlMutation(path, "POST", command),
    );
  },
  async listKeys(organisationId) {
    const [inventory, inference] = await Promise.all([
      controlRead(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/credentials`,
      ),
      // A missing model selection hides one row; it does not hide the list.
      controlRead(inferencePath(organisationId)).catch(() => null),
    ]);
    return [
      ...keysOfInferenceSelection(inference),
      ...keysOfInventory(parseCredentialInventoryResponse(inventory).accounts),
    ];
  },
  // The 1Password token travels only in its own request.
  async store(organisationId, command) {
    const path = vaultStorePath(organisationId);
    const raw =
      command.kind === "connect_onepassword"
        ? await controlSecretMutation(path, "POST", command)
        : await controlMutation(path, "POST", command);
    const result = parseVaultStoreResult(raw);
    if (result === null) throw unexpected();
    return result;
  },
  async events(organisationId, itemId) {
    const path = vaultEventsPath(organisationId);
    const events = parseVaultEventList(
      await controlRead(
        itemId === null ? path : `${path}?itemId=${encodeURIComponent(itemId)}`,
      ),
    );
    if (events === null) throw unexpected();
    return events;
  },
};

function parsedResult(raw: unknown): VaultItemResult {
  const result = parseVaultItemResult(raw);
  if (result === null) throw unexpected();
  return result;
}

function unexpected(): Error {
  return new Error("The server returned an unexpected Vault response.");
}

/** What a person reads when a Vault change fails. */
export function vaultErrorMessage(error: unknown): string {
  const code =
    error instanceof ControlApiError &&
    isRecord(error.details) &&
    typeof error.details.error === "string"
      ? error.details.error
      : null;
  switch (code) {
    case "vault_item_revision_conflict":
      return "Someone changed this item. Close it and open it again to see the latest version.";
    case "vault_item_not_found":
      return "This item was removed.";
    case "vault_item_limit_reached":
      return "The Vault is full. Remove an item you no longer use, then try again.";
    case "vault_item_invalid":
      return "Check the highlighted details and try again.";
    case "vault_item_store_failed":
    case "vault_unavailable":
      return "Pantry could not save this item. Try again.";
    case "vault_store_auth_failed":
      return "1Password refused the service account token. Check the token and its vault access, then try again.";
    case "vault_store_vault_unknown":
      return "The token cannot reach that vault. Choose another vault.";
    case "vault_store_rate_limited":
      return "1Password limits how often a service account can work. Try again in an hour.";
    case "vault_store_unavailable":
      return "1Password did not answer. Try again in a moment.";
    case "vault_store_not_connected":
      return "1Password is not connected.";
    default:
      return error instanceof Error
        ? error.message
        : "Pantry could not save this item. Try again.";
  }
}
