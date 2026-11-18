import {
  isVaultItemView,
  type VaultContact,
  type VaultItemCreate,
  type VaultItemView,
} from "@seams/control-api";
import { isRecord } from "@seams/std";

/**
 * The protocol between the Platform and the 1Password store Worker
 * (Plan 79). The Platform posts one operation with the Organisation's
 * service account token; the Worker answers with item views that never
 * carry a secret, except `read_secret`, which a move or a fill asks for.
 */
export type OnePasswordOperation =
  | Readonly<{ op: "list_vaults" }>
  | Readonly<{ op: "list_items"; vaultId: string }>
  | Readonly<{ op: "create_item"; vaultId: string; item: VaultItemCreate }>
  | Readonly<{
      op: "update_item";
      vaultId: string;
      itemId: string;
      expectedVersion: number;
      change: OnePasswordItemChange;
    }>
  | Readonly<{ op: "archive_item"; vaultId: string; itemId: string }>
  | Readonly<{ op: "read_secret"; vaultId: string; itemId: string }>;

export type OnePasswordItemChange =
  | Readonly<{ kind: "edit_login"; label: string; origins: readonly string[] }>
  | Readonly<{ kind: "replace_sign_in"; username: string; password: string }>
  | Readonly<{ kind: "edit_contact"; label: string; contact: VaultContact }>;

export type OnePasswordVault = Readonly<{
  vaultId: string;
  title: string;
  itemCount: number;
}>;

export type OnePasswordSecret = Readonly<{
  kind: "website_login";
  username: string;
  password: string;
}>;

export type OnePasswordErrorCode =
  | "onepassword_auth_failed"
  | "onepassword_item_missing"
  | "onepassword_version_conflict"
  | "onepassword_rate_limited"
  | "onepassword_request_invalid"
  | "onepassword_unavailable";

export type OnePasswordResponse =
  | Readonly<{ ok: true; vaults: readonly OnePasswordVault[] }>
  | Readonly<{ ok: true; items: readonly VaultItemView[] }>
  | Readonly<{ ok: true; item: VaultItemView }>
  | Readonly<{ ok: true; secret: OnePasswordSecret | null }>
  | Readonly<{ ok: true; archived: true }>
  | Readonly<{ ok: false; code: OnePasswordErrorCode }>;

const ERROR_CODES: Readonly<Record<OnePasswordErrorCode, true>> = {
  onepassword_auth_failed: true,
  onepassword_item_missing: true,
  onepassword_version_conflict: true,
  onepassword_rate_limited: true,
  onepassword_request_invalid: true,
  onepassword_unavailable: true,
};

function isOnePasswordErrorCode(raw: unknown): raw is OnePasswordErrorCode {
  return typeof raw === "string" && Object.hasOwn(ERROR_CODES, raw);
}

/** The Worker's answer, checked on the Platform side of the binding. */
export function parseOnePasswordResponse(raw: unknown): OnePasswordResponse {
  if (!isRecord(raw)) return unavailable();
  if (raw.ok === false)
    return isOnePasswordErrorCode(raw.code)
      ? { ok: false, code: raw.code }
      : unavailable();
  if (raw.ok !== true) return unavailable();
  if (Array.isArray(raw.vaults))
    return raw.vaults.every(isVault)
      ? { ok: true, vaults: raw.vaults }
      : unavailable();
  if (Array.isArray(raw.items))
    return raw.items.every(isOnePasswordItemView)
      ? { ok: true, items: raw.items }
      : unavailable();
  if ("item" in raw)
    return isOnePasswordItemView(raw.item)
      ? { ok: true, item: raw.item }
      : unavailable();
  if ("secret" in raw)
    return raw.secret === null || isSecret(raw.secret)
      ? { ok: true, secret: raw.secret }
      : unavailable();
  return raw.archived === true ? { ok: true, archived: true } : unavailable();
}

function isOnePasswordItemView(raw: unknown): raw is VaultItemView {
  return isVaultItemView(raw) && raw.store === "onepassword";
}

function isVault(raw: unknown): raw is OnePasswordVault {
  return (
    isRecord(raw) &&
    typeof raw.vaultId === "string" &&
    typeof raw.title === "string" &&
    typeof raw.itemCount === "number"
  );
}

function isSecret(raw: unknown): raw is OnePasswordSecret {
  return (
    isRecord(raw) &&
    raw.kind === "website_login" &&
    typeof raw.username === "string" &&
    typeof raw.password === "string"
  );
}

function unavailable(): OnePasswordResponse {
  return { ok: false, code: "onepassword_unavailable" };
}
