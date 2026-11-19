import {
  isVaultContact,
  isVaultOriginList,
  VAULT_ITEM_LIMIT,
  type VaultItemCommand,
  type VaultItemCreate,
  type VaultItemView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import {
  organisationPlacementPredicate,
  type OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type { Result } from "../result";
import { parseVaultHandle, type VaultHandle } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import {
  resolveVaultHandle,
  storeOrganisationPlacementVaultSecret,
} from "./service";

/**
 * Vault items (Plan 79). The visible record lives in `vault_item`; a login's
 * username and password are one `website_login` secret in `vault_secret`,
 * with a new handle for each generation. Removing an item deletes its record
 * and revokes its secret.
 */

export type VaultItemError =
  | { readonly code: "vault_item_not_found" }
  | { readonly code: "vault_item_revision_conflict" }
  | { readonly code: "vault_item_limit_reached" }
  | { readonly code: "vault_item_store_failed" };

export type VaultItemCommandOutcome =
  | { readonly kind: "item"; readonly item: VaultItemView }
  | { readonly kind: "removed"; readonly itemId: string };

type VaultItemInput = Readonly<{
  scope: OrganisationExecutionScope;
  keys: CredentialVaultBindings;
  userId: string;
  now: number;
}>;

type VaultItemRow = {
  readonly itemId: unknown;
  readonly kind: unknown;
  readonly label: unknown;
  readonly originsJson: unknown;
  readonly username: unknown;
  readonly contactJson: unknown;
  readonly vaultHandle: unknown;
  readonly generation: unknown;
  readonly revision: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly passwordUpdatedAt: unknown;
};

const ITEM_COLUMNS = `item.vault_item_id AS itemId, item.kind AS kind,
  item.label AS label, item.origins_json AS originsJson,
  item.username AS username, item.contact_json AS contactJson,
  item.vault_handle AS vaultHandle, item.generation AS generation,
  item.revision AS revision, item.created_at AS createdAt,
  item.updated_at AS updatedAt, secret.created_at AS passwordUpdatedAt
  FROM vault_item AS item
  LEFT JOIN vault_secret AS secret
    ON secret.organisation_id = item.organisation_id
   AND secret.vault_handle = item.vault_handle`;

export async function listVaultItems(
  scope: OrganisationExecutionScope,
): Promise<readonly VaultItemView[]> {
  const rows = await scope.database
    .prepare(
      `SELECT ${ITEM_COLUMNS}
       WHERE item.organisation_id = ?
       ORDER BY item.kind = 'contact_profile', item.label COLLATE NOCASE,
         item.vault_item_id`,
    )
    .bind(scope.organisationId)
    .all<VaultItemRow>();
  return (rows.results ?? []).map(vaultItemView);
}

export async function createVaultItem(
  input: VaultItemInput & Readonly<{ create: VaultItemCreate }>,
): Promise<Result<VaultItemView, VaultItemError>> {
  const itemId = crypto.randomUUID().replaceAll("-", "");
  const { create } = input;
  let handle: VaultHandle | null = null;
  if (create.kind === "website_login") {
    handle = websiteLoginHandle(itemId, 1);
    const stored = await storeOrganisationPlacementVaultSecret({
      scope: input.scope,
      keys: input.keys,
      handle,
      secret: {
        kind: "website_login",
        username: create.username,
        password: create.password,
      },
      now: input.now,
    });
    if (!stored.ok) return storeFailed();
  }
  const placement = organisationPlacementPredicate(input.scope);
  const inserted = await input.scope.database
    .prepare(
      `INSERT INTO vault_item (
         organisation_id, vault_item_id, kind, label, origins_json, username,
         contact_json, vault_handle, generation, revision, created_by_user_id,
         created_at, updated_by_user_id, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?
       WHERE ${placement.sql}
         AND (SELECT COUNT(*) FROM vault_item WHERE organisation_id = ?) < ?`,
    )
    .bind(
      input.scope.organisationId,
      itemId,
      create.kind,
      create.label,
      JSON.stringify(create.kind === "website_login" ? create.origins : []),
      create.kind === "website_login" ? create.username : null,
      create.kind === "contact_profile" ? JSON.stringify(create.contact) : null,
      handle,
      input.userId,
      input.now,
      input.userId,
      input.now,
      ...placement.bindings,
      input.scope.organisationId,
      VAULT_ITEM_LIMIT,
    )
    .run()
    .catch(() => null);
  if (inserted?.meta.changes !== 1) {
    if (handle !== null) await revokeHandles(input, [handle]);
    return inserted === null
      ? storeFailed()
      : (await countVaultItems(input.scope)) >= VAULT_ITEM_LIMIT
        ? { ok: false, error: { code: "vault_item_limit_reached" } }
        : storeFailed();
  }
  return readItemResult(input.scope, itemId);
}

export async function commandVaultItem(
  input: VaultItemInput &
    Readonly<{ itemId: string; command: VaultItemCommand }>,
): Promise<Result<VaultItemCommandOutcome, VaultItemError>> {
  const current = await readVaultItem(input.scope, input.itemId);
  if (current === null)
    return { ok: false, error: { code: "vault_item_not_found" } };
  const { command } = input;
  if (current.revision !== command.expectedRevision)
    return { ok: false, error: { code: "vault_item_revision_conflict" } };
  switch (command.kind) {
    case "edit_login":
      if (current.kind !== "website_login") return notFound();
      return updateItem(
        input,
        current.revision,
        `label = ?, origins_json = ?`,
        [command.label, JSON.stringify(command.origins)],
        "website_login",
      );
    case "edit_contact":
      if (current.kind !== "contact_profile") return notFound();
      return updateItem(
        input,
        current.revision,
        `label = ?, contact_json = ?`,
        [command.label, JSON.stringify(command.contact)],
        "contact_profile",
      );
    case "replace_sign_in":
      if (current.kind !== "website_login") return notFound();
      return replaceSignIn(input, current, command);
    case "remove":
      return removeItem(input, current.revision);
    default:
      return assertNever(command);
  }
}

async function replaceSignIn(
  input: VaultItemInput & Readonly<{ itemId: string }>,
  current: StoredVaultItem,
  command: Readonly<{ username: string; password: string }>,
): Promise<Result<VaultItemCommandOutcome, VaultItemError>> {
  if (current.vaultHandle === null) return notFound();
  const generation = current.generation + 1;
  const handle = websiteLoginHandle(input.itemId, generation);
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: input.scope,
    keys: input.keys,
    handle,
    secret: {
      kind: "website_login",
      username: command.username,
      password: command.password,
    },
    now: input.now,
  });
  if (!stored.ok) return storeFailed();
  const placement = organisationPlacementPredicate(input.scope);
  const db = input.scope.database;
  const [updated] = await db
    .batch([
      db
        .prepare(
          `UPDATE vault_item
           SET username = ?, vault_handle = ?, generation = ?,
               revision = revision + 1, updated_by_user_id = ?, updated_at = ?
           WHERE organisation_id = ? AND vault_item_id = ?
             AND kind = 'website_login' AND revision = ? AND ${placement.sql}`,
        )
        .bind(
          command.username,
          handle,
          generation,
          input.userId,
          input.now,
          input.scope.organisationId,
          input.itemId,
          current.revision,
          ...placement.bindings,
        ),
      // The old generation stops working only once the new one is the item's.
      db
        .prepare(
          `UPDATE vault_secret SET revoked_at = ?
           WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM vault_item WHERE organisation_id = ?
               AND vault_item_id = ? AND vault_handle = ?)`,
        )
        .bind(
          input.now,
          input.scope.organisationId,
          current.vaultHandle,
          input.scope.organisationId,
          input.itemId,
          handle,
        ),
    ])
    .catch(() => [null]);
  if (updated?.meta.changes !== 1) {
    await revokeHandles(input, [handle]);
    return updated === null ? storeFailed() : changedMeanwhile(input);
  }
  return itemOutcome(input.scope, input.itemId);
}

async function updateItem(
  input: VaultItemInput & Readonly<{ itemId: string }>,
  expectedRevision: number,
  assignments: string,
  values: readonly string[],
  kind: VaultItemView["kind"],
): Promise<Result<VaultItemCommandOutcome, VaultItemError>> {
  const placement = organisationPlacementPredicate(input.scope);
  const updated = await input.scope.database
    .prepare(
      `UPDATE vault_item
       SET ${assignments}, revision = revision + 1, updated_by_user_id = ?,
           updated_at = ?
       WHERE organisation_id = ? AND vault_item_id = ? AND kind = ?
         AND revision = ? AND ${placement.sql}`,
    )
    .bind(
      ...values,
      input.userId,
      input.now,
      input.scope.organisationId,
      input.itemId,
      kind,
      expectedRevision,
      ...placement.bindings,
    )
    .run()
    .catch(() => null);
  if (updated === null) return storeFailed();
  if (updated.meta.changes !== 1) return changedMeanwhile(input);
  return itemOutcome(input.scope, input.itemId);
}

async function removeItem(
  input: VaultItemInput & Readonly<{ itemId: string }>,
  expectedRevision: number,
): Promise<Result<VaultItemCommandOutcome, VaultItemError>> {
  const placement = organisationPlacementPredicate(input.scope);
  const db = input.scope.database;
  const results = await db
    .batch([
      // Revoke first: the next statement deletes the row that names it.
      db
        .prepare(
          `UPDATE vault_secret SET revoked_at = ?
           WHERE organisation_id = ? AND revoked_at IS NULL
             AND vault_handle = (SELECT vault_handle FROM vault_item
               WHERE organisation_id = ? AND vault_item_id = ? AND revision = ?)
             AND ${placement.sql}`,
        )
        .bind(
          input.now,
          input.scope.organisationId,
          input.scope.organisationId,
          input.itemId,
          expectedRevision,
          ...placement.bindings,
        ),
      db
        .prepare(
          `DELETE FROM vault_item
           WHERE organisation_id = ? AND vault_item_id = ? AND revision = ?
             AND ${placement.sql}`,
        )
        .bind(
          input.scope.organisationId,
          input.itemId,
          expectedRevision,
          ...placement.bindings,
        ),
    ])
    .catch(() => null);
  if (results === null) return storeFailed();
  if (results[1]?.meta.changes !== 1) return changedMeanwhile(input);
  return { ok: true, value: { kind: "removed", itemId: input.itemId } };
}

type StoredVaultItem = Readonly<{
  kind: VaultItemView["kind"];
  revision: number;
  generation: number;
  vaultHandle: VaultHandle | null;
}>;

async function readVaultItem(
  scope: OrganisationExecutionScope,
  itemId: string,
): Promise<StoredVaultItem | null> {
  const row = await scope.database
    .prepare(
      `SELECT kind, revision, generation, vault_handle AS vaultHandle
       FROM vault_item WHERE organisation_id = ? AND vault_item_id = ?`,
    )
    .bind(scope.organisationId, itemId)
    .first<{
      readonly kind: unknown;
      readonly revision: unknown;
      readonly generation: unknown;
      readonly vaultHandle: unknown;
    }>();
  if (row === null) return null;
  const handle =
    typeof row.vaultHandle === "string"
      ? parseVaultHandle(row.vaultHandle)
      : null;
  if (
    (row.kind !== "website_login" && row.kind !== "contact_profile") ||
    typeof row.revision !== "number" ||
    typeof row.generation !== "number" ||
    (handle !== null && !handle.ok)
  )
    throw new Error("vault_item_row_invalid");
  return {
    kind: row.kind,
    revision: row.revision,
    generation: row.generation,
    vaultHandle: handle?.ok ? handle.value : null,
  };
}

/**
 * A Pantry item as the create command of another store. A move to 1Password
 * reads the sign-in once, here, and removes the Pantry item after the copy.
 */
export async function vaultItemForMove(
  scope: OrganisationExecutionScope,
  keys: CredentialVaultBindings,
  itemId: string,
): Promise<Readonly<{ create: VaultItemCreate; revision: number }> | null> {
  const row = await scope.database
    .prepare(
      `SELECT ${ITEM_COLUMNS}
       WHERE item.organisation_id = ? AND item.vault_item_id = ?`,
    )
    .bind(scope.organisationId, itemId)
    .first<VaultItemRow>();
  if (row === null) return null;
  const view = vaultItemView(row);
  if (view.kind === "contact_profile")
    return {
      create: {
        kind: "contact_profile",
        label: view.label,
        contact: view.contact,
      },
      revision: view.revision,
    };
  const handle =
    typeof row.vaultHandle === "string"
      ? parseVaultHandle(row.vaultHandle)
      : null;
  if (handle === null || !handle.ok) return null;
  const secret = await resolveVaultHandle({
    db: scope.database,
    keys,
    organisationId: scope.organisationId,
    handle: handle.value,
  });
  if (!secret.ok || secret.value.kind !== "website_login") return null;
  return {
    create: {
      kind: "website_login",
      label: view.label,
      origins: view.origins,
      username: secret.value.username,
      password: secret.value.password,
    },
    revision: view.revision,
  };
}

/** The IDs of the Pantry items, oldest first, for a move. */
export async function pantryVaultItemIds(
  scope: OrganisationExecutionScope,
): Promise<readonly string[]> {
  const rows = await scope.database
    .prepare(
      `SELECT vault_item_id AS itemId FROM vault_item
       WHERE organisation_id = ? ORDER BY created_at, vault_item_id`,
    )
    .bind(scope.organisationId)
    .all<{ readonly itemId: string }>();
  return (rows.results ?? []).map((row) => row.itemId);
}

async function readItemResult(
  scope: OrganisationExecutionScope,
  itemId: string,
): Promise<Result<VaultItemView, VaultItemError>> {
  const row = await scope.database
    .prepare(
      `SELECT ${ITEM_COLUMNS}
       WHERE item.organisation_id = ? AND item.vault_item_id = ?`,
    )
    .bind(scope.organisationId, itemId)
    .first<VaultItemRow>();
  return row === null ? notFound() : { ok: true, value: vaultItemView(row) };
}

async function itemOutcome(
  scope: OrganisationExecutionScope,
  itemId: string,
): Promise<Result<VaultItemCommandOutcome, VaultItemError>> {
  const item = await readItemResult(scope, itemId);
  return item.ok
    ? { ok: true, value: { kind: "item", item: item.value } }
    : item;
}

/** A guarded write that changed nothing: the item went or moved on. */
async function changedMeanwhile(
  input: Readonly<{ scope: OrganisationExecutionScope; itemId: string }>,
): Promise<Result<never, VaultItemError>> {
  return (await readVaultItem(input.scope, input.itemId)) === null
    ? notFound()
    : { ok: false, error: { code: "vault_item_revision_conflict" } };
}

async function countVaultItems(
  scope: OrganisationExecutionScope,
): Promise<number> {
  const row = await scope.database
    .prepare(
      `SELECT COUNT(*) AS count FROM vault_item WHERE organisation_id = ?`,
    )
    .bind(scope.organisationId)
    .first<{ readonly count: number }>();
  return row?.count ?? 0;
}

/** A secret that no item names must not stay usable. */
async function revokeHandles(
  input: VaultItemInput,
  handles: readonly VaultHandle[],
): Promise<void> {
  const db = input.scope.database;
  await db
    .batch(
      handles.map((handle) =>
        db
          .prepare(
            `UPDATE vault_secret SET revoked_at = ?
             WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL`,
          )
          .bind(input.now, input.scope.organisationId, handle),
      ),
    )
    .catch(() => undefined);
}

function websiteLoginHandle(itemId: string, generation: number): VaultHandle {
  const handle = parseVaultHandle(
    `vault:website_login:${itemId}:generation_${generation}`,
  );
  if (!handle.ok) throw new Error("vault_item_handle_invalid");
  return handle.value;
}

function vaultItemView(row: VaultItemRow): VaultItemView {
  if (
    typeof row.itemId !== "string" ||
    typeof row.label !== "string" ||
    typeof row.revision !== "number" ||
    typeof row.createdAt !== "number" ||
    typeof row.updatedAt !== "number"
  )
    throw new Error("vault_item_row_invalid");
  const common = {
    itemId: row.itemId,
    store: "satyr" as const,
    label: row.label,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.kind === "website_login") {
    const origins = parseStoredJson(row.originsJson);
    if (
      !isVaultOriginList(origins) ||
      typeof row.username !== "string" ||
      typeof row.passwordUpdatedAt !== "number"
    )
      throw new Error("vault_item_row_invalid");
    return {
      kind: "website_login",
      ...common,
      origins,
      username: row.username,
      passwordUpdatedAt: row.passwordUpdatedAt,
    };
  }
  const contact = parseStoredJson(row.contactJson);
  if (row.kind !== "contact_profile" || !isVaultContact(contact))
    throw new Error("vault_item_row_invalid");
  return { kind: "contact_profile", ...common, contact };
}

function parseStoredJson(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function notFound(): Result<never, VaultItemError> {
  return { ok: false, error: { code: "vault_item_not_found" } };
}

function storeFailed(): Result<never, VaultItemError> {
  return { ok: false, error: { code: "vault_item_store_failed" } };
}
