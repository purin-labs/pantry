import type {
  VaultEvent,
  VaultEventKind,
  VaultItemCommand,
  VaultItemCreate,
  VaultItemView,
  VaultStoreKind,
  VaultStoreSummary,
  VaultStoreView,
} from "@seams/control-api";
import { assertNever } from "@seams/std";

import {
  organisationPlacementPredicate,
  type OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type { Result } from "../result";
import {
  parseOnePasswordResponse,
  type OnePasswordErrorCode,
  type OnePasswordOperation,
  type OnePasswordResponse,
  type OnePasswordVault,
} from "../vault-onepassword/protocol";
import { parseVaultHandle, type VaultHandle } from "./domain";
import {
  commandVaultItem,
  createVaultItem,
  listVaultItems,
  pantryVaultItemIds,
  vaultItemForMove,
  type VaultItemCommandOutcome,
  type VaultItemError,
} from "./items";
import type { CredentialVaultBindings } from "./keyring";
import {
  resolveVaultHandle,
  storeOrganisationPlacementVaultSecret,
} from "./service";

/**
 * The Vault's stores (Plan 79). An Organisation keeps its items in Pantry
 * Vault, or connects one 1Password vault through a service account; then
 * new items go to 1Password, and the list shows both stores until the
 * Pantry items move. The routes, the page and later the agent tools call
 * this module and do not know which store holds an item: a Pantry item ID
 * has 32 hex digits, a 1Password item ID has 26 characters.
 *
 * Pantry stores one 1Password secret: the service account token, as a
 * bearer row in Pantry Vault. 1Password holds every item value of its store.
 */

export type VaultItemStoreError =
  | VaultItemError
  | { readonly code: "vault_store_not_connected" }
  | { readonly code: "vault_store_vault_unknown" }
  | { readonly code: "vault_store_auth_failed" }
  | { readonly code: "vault_store_rate_limited" }
  | { readonly code: "vault_store_unavailable" };

export type VaultStoreEnv = Readonly<{
  VAULT_ONEPASSWORD: Fetcher;
}> &
  CredentialVaultBindings;

type StoreInput = Readonly<{
  env: VaultStoreEnv;
  scope: OrganisationExecutionScope;
  userId: string;
  now: number;
}>;

type OnePasswordStore = Readonly<{
  vaultId: string;
  vaultTitle: string;
  tokenHandle: VaultHandle;
  connectedAt: number;
}>;

export type VaultStoreConnectOutcome =
  | Readonly<{ kind: "store"; store: VaultStoreView }>
  | Readonly<{ kind: "choose_vault"; vaults: readonly OnePasswordVault[] }>;

export type VaultMoveOutcome = Readonly<{
  store: VaultStoreView;
  moved: number;
  remaining: number;
}>;

/** One move request copies at most this many items, to stay inside rate limits. */
const MOVE_BATCH = 10;
/** A 1Password list costs one read for each item; reuse it for a while. */
const LIST_LIFETIME_MS = 30_000;
// Each entry names the vault and token that answered it. A list that was in
// flight when the owner connected another vault writes the old vault's items
// after the connect cleared the entry, so a read must match the store.
const listCache = new Map<
  string,
  Readonly<{
    items: readonly VaultItemView[];
    expiresAt: number;
    vaultId: string;
    tokenHandle: string;
  }>
>();

export function isOnePasswordItemId(itemId: string): boolean {
  return /^[0-9a-z]{26}$/.test(itemId);
}

/** Where the items live, from Pantry alone: this read never calls 1Password. */
export async function readVaultStoreSummary(
  scope: OrganisationExecutionScope,
): Promise<VaultStoreSummary> {
  const store = await readOnePasswordStore(scope);
  return store === null
    ? { kind: "satyr" }
    : {
        kind: "onepassword",
        vaultTitle: store.vaultTitle,
        connectedAt: store.connectedAt,
      };
}

export async function listVaultStoreItems(
  input: Readonly<{ env: VaultStoreEnv; scope: OrganisationExecutionScope }>,
): Promise<
  Readonly<{ store: VaultStoreView; items: readonly VaultItemView[] }>
> {
  const pantryItems = await listVaultItems(input.scope);
  const store = await readOnePasswordStore(input.scope);
  if (store === null) return { store: { kind: "satyr" }, items: pantryItems };
  const remote = await listOnePasswordItems(input.env, input.scope, store);
  return {
    store: storeView(store, remote !== null),
    items: [...(remote ?? []), ...pantryItems],
  };
}

export async function createVaultStoreItem(
  input: StoreInput & Readonly<{ create: VaultItemCreate }>,
): Promise<Result<VaultItemView, VaultItemStoreError>> {
  const store = await readOnePasswordStore(input.scope);
  if (store === null) {
    const created = await createVaultItem({
      scope: input.scope,
      keys: input.env,
      userId: input.userId,
      now: input.now,
      create: input.create,
    });
    if (created.ok)
      await recordVaultEvent(input, "item_added", created.value, "satyr");
    return created;
  }
  const answer = await callOnePassword(input, store, {
    op: "create_item",
    vaultId: store.vaultId,
    item: input.create,
  });
  if (!answer.ok) return answer;
  if (!("item" in answer.value)) return unavailable();
  await recordVaultEvent(input, "item_added", answer.value.item, "onepassword");
  return { ok: true, value: answer.value.item };
}

export async function commandVaultStoreItem(
  input: StoreInput & Readonly<{ itemId: string; command: VaultItemCommand }>,
): Promise<Result<VaultItemCommandOutcome, VaultItemStoreError>> {
  if (!isOnePasswordItemId(input.itemId)) {
    const label = await pantryItemLabel(input.scope, input.itemId);
    const outcome = await commandVaultItem({
      scope: input.scope,
      keys: input.env,
      userId: input.userId,
      now: input.now,
      itemId: input.itemId,
      command: input.command,
    });
    if (outcome.ok)
      await recordVaultEvent(
        input,
        commandEvent(input.command),
        outcome.value.kind === "item"
          ? outcome.value.item
          : { itemId: input.itemId, label },
        "satyr",
      );
    return outcome;
  }
  const store = await readOnePasswordStore(input.scope);
  if (store === null)
    return { ok: false, error: { code: "vault_item_not_found" } };
  const { command } = input;
  if (command.kind === "remove") {
    // The revision check needs the current version, not the cached list.
    listCache.delete(input.scope.organisationId);
    const items = await listOnePasswordItems(input.env, input.scope, store);
    const current = items?.find((item) => item.itemId === input.itemId);
    if (current === undefined)
      return { ok: false, error: { code: "vault_item_not_found" } };
    if (current.revision !== command.expectedRevision)
      return { ok: false, error: { code: "vault_item_revision_conflict" } };
    // Removal archives the item in 1Password, where people can restore it.
    const archived = await callOnePassword(input, store, {
      op: "archive_item",
      vaultId: store.vaultId,
      itemId: input.itemId,
    });
    if (!archived.ok) return archived;
    await recordVaultEvent(input, "item_removed", current, "onepassword");
    return { ok: true, value: { kind: "removed", itemId: input.itemId } };
  }
  const answer = await callOnePassword(input, store, {
    op: "update_item",
    vaultId: store.vaultId,
    itemId: input.itemId,
    expectedVersion: command.expectedRevision,
    change:
      command.kind === "edit_login"
        ? { kind: "edit_login", label: command.label, origins: command.origins }
        : command.kind === "replace_sign_in"
          ? {
              kind: "replace_sign_in",
              username: command.username,
              password: command.password,
            }
          : {
              kind: "edit_contact",
              label: command.label,
              contact: command.contact,
            },
  });
  if (!answer.ok) return answer;
  if (!("item" in answer.value)) return unavailable();
  await recordVaultEvent(
    input,
    commandEvent(command),
    answer.value.item,
    "onepassword",
  );
  return { ok: true, value: { kind: "item", item: answer.value.item } };
}

/**
 * Connects a 1Password service account. The token must reach the vault; a
 * token that reaches several vaults and names none asks to choose one, and
 * nothing is stored until it is chosen.
 */
export async function connectOnePassword(
  input: StoreInput & Readonly<{ token: string; vaultId: string | null }>,
): Promise<Result<VaultStoreConnectOutcome, VaultItemStoreError>> {
  const answer = parseOnePasswordAnswer(
    await sendOnePassword(input.env, input.token, { op: "list_vaults" }),
  );
  if (!answer.ok) return answer;
  if (!("vaults" in answer.value)) return unavailable();
  const vaults = answer.value.vaults;
  const vault =
    input.vaultId === null
      ? vaults.length === 1
        ? vaults[0]
        : undefined
      : vaults.find((candidate) => candidate.vaultId === input.vaultId);
  if (vault === undefined)
    return input.vaultId === null && vaults.length > 1
      ? { ok: true, value: { kind: "choose_vault", vaults } }
      : { ok: false, error: { code: "vault_store_vault_unknown" } };
  const handle = parseVaultHandle(
    `vault:onepassword_service_account:${crypto.randomUUID().replaceAll("-", "")}`,
  );
  if (!handle.ok) return unavailable();
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: input.scope,
    keys: input.env,
    handle: handle.value,
    secret: { kind: "bearer", value: input.token },
    now: input.now,
  });
  if (!stored.ok)
    return { ok: false, error: { code: "vault_item_store_failed" } };
  const previous = await readOnePasswordStore(input.scope);
  const placement = organisationPlacementPredicate(input.scope);
  const db = input.scope.database;
  await db.batch([
    db
      .prepare(
        `INSERT INTO vault_store (organisation_id, store, onepassword_vault_id,
           onepassword_vault_title, token_handle, connected_by_user_id,
           connected_at)
         SELECT ?, 'onepassword', ?, ?, ?, ?, ? WHERE ${placement.sql}
         ON CONFLICT (organisation_id) DO UPDATE SET
           onepassword_vault_id = excluded.onepassword_vault_id,
           onepassword_vault_title = excluded.onepassword_vault_title,
           token_handle = excluded.token_handle,
           connected_by_user_id = excluded.connected_by_user_id,
           connected_at = excluded.connected_at`,
      )
      .bind(
        input.scope.organisationId,
        vault.vaultId,
        vault.title.slice(0, 200) || "1Password",
        handle.value,
        input.userId,
        input.now,
        ...placement.bindings,
      ),
    ...(previous === null
      ? []
      : [revokeStatement(input, previous.tokenHandle)]),
  ]);
  listCache.delete(input.scope.organisationId);
  const store = await readOnePasswordStore(input.scope);
  if (store === null || store.tokenHandle !== handle.value)
    return unavailable();
  await recordVaultEvent(input, "store_connected", null, "onepassword");
  return { ok: true, value: { kind: "store", store: storeView(store, true) } };
}

/** Pantry stops using the 1Password vault; its items stay in 1Password. */
export async function disconnectOnePassword(
  input: StoreInput,
): Promise<Result<VaultStoreView, VaultItemStoreError>> {
  const store = await readOnePasswordStore(input.scope);
  if (store === null)
    return { ok: false, error: { code: "vault_store_not_connected" } };
  const db = input.scope.database;
  await db.batch([
    revokeStatement(input, store.tokenHandle),
    db
      .prepare(
        `DELETE FROM vault_store WHERE organisation_id = ? AND token_handle = ?`,
      )
      .bind(input.scope.organisationId, store.tokenHandle),
  ]);
  listCache.delete(input.scope.organisationId);
  await recordVaultEvent(input, "store_disconnected", null, "onepassword");
  return { ok: true, value: { kind: "satyr" } };
}

/**
 * Moves one batch of items into a store from the other. Each item is copied,
 * and only a copy that the target store accepted removes the source: a Pantry
 * item's sign-in is revoked, a 1Password item is archived.
 */
export async function moveVaultItems(
  input: StoreInput & Readonly<{ to: VaultStoreKind }>,
): Promise<Result<VaultMoveOutcome, VaultItemStoreError>> {
  const store = await readOnePasswordStore(input.scope);
  if (store === null)
    return { ok: false, error: { code: "vault_store_not_connected" } };
  let moved = 0;
  if (input.to === "onepassword") {
    const ids = await pantryVaultItemIds(input.scope);
    for (const itemId of ids.slice(0, MOVE_BATCH)) {
      const source = await vaultItemForMove(input.scope, input.env, itemId);
      if (source === null) continue;
      const copied = await callOnePassword(input, store, {
        op: "create_item",
        vaultId: store.vaultId,
        item: source.create,
      });
      if (!copied.ok) {
        if (moved === 0) return copied;
        break;
      }
      if (!("item" in copied.value)) break;
      const removed = await commandVaultItem({
        scope: input.scope,
        keys: input.env,
        userId: input.userId,
        now: input.now,
        itemId,
        command: { kind: "remove", expectedRevision: source.revision },
      });
      if (!removed.ok) {
        // The Pantry item changed during the move; the copy stays in 1Password
        // and the next move copies the item again.
        break;
      }
      await recordVaultEvent(
        input,
        "item_moved",
        copied.value.item,
        "onepassword",
      );
      moved += 1;
    }
    listCache.delete(input.scope.organisationId);
    const remaining = (await pantryVaultItemIds(input.scope)).length;
    return {
      ok: true,
      value: { store: storeView(store, true), moved, remaining },
    };
  }
  const items = await listOnePasswordItems(input.env, input.scope, store);
  if (items === null) return unavailable();
  for (const item of items.slice(0, MOVE_BATCH)) {
    const create = await onePasswordItemForMove(input, store, item);
    if (create === null) break;
    const copied = await createVaultItem({
      scope: input.scope,
      keys: input.env,
      userId: input.userId,
      now: input.now,
      create,
    });
    if (!copied.ok) {
      if (moved === 0) return copied;
      break;
    }
    const archived = await callOnePassword(input, store, {
      op: "archive_item",
      vaultId: store.vaultId,
      itemId: item.itemId,
    });
    if (!archived.ok) {
      // Two copies are better than none: remove the Pantry copy again.
      await commandVaultItem({
        scope: input.scope,
        keys: input.env,
        userId: input.userId,
        now: input.now,
        itemId: copied.value.itemId,
        command: { kind: "remove", expectedRevision: copied.value.revision },
      });
      if (moved === 0) return archived;
      break;
    }
    await recordVaultEvent(input, "item_moved", copied.value, "satyr");
    moved += 1;
  }
  listCache.delete(input.scope.organisationId);
  const after = await listOnePasswordItems(input.env, input.scope, store);
  return {
    ok: true,
    value: {
      store: storeView(store, after !== null),
      moved,
      remaining: after?.length ?? items.length - moved,
    },
  };
}

async function onePasswordItemForMove(
  input: StoreInput,
  store: OnePasswordStore,
  item: VaultItemView,
): Promise<VaultItemCreate | null> {
  if (item.kind === "contact_profile")
    return {
      kind: "contact_profile",
      label: item.label,
      contact: item.contact,
    };
  // A Pantry login needs a website; a 1Password login without one stays there.
  if (item.origins.length === 0) return null;
  const answer = await callOnePassword(input, store, {
    op: "read_secret",
    vaultId: store.vaultId,
    itemId: item.itemId,
  });
  if (!answer.ok || !("secret" in answer.value) || answer.value.secret === null)
    return null;
  return {
    kind: "website_login",
    label: item.label,
    origins: item.origins.slice(0, 5),
    username: answer.value.secret.username,
    password: answer.value.secret.password,
  };
}

export async function listVaultEvents(
  scope: OrganisationExecutionScope,
  itemId: string | null,
): Promise<readonly VaultEvent[]> {
  const rows = await scope.database
    .prepare(
      `SELECT event_id AS eventId, kind, item_id AS itemId,
         item_label AS itemLabel, store, at
       FROM vault_item_event
       WHERE organisation_id = ? AND (? IS NULL OR item_id = ?)
       ORDER BY rowid DESC LIMIT 50`,
    )
    .bind(scope.organisationId, itemId, itemId)
    .all<VaultEvent>();
  return rows.results ?? [];
}

async function recordVaultEvent(
  input: StoreInput,
  kind: VaultEventKind,
  item: Readonly<{ itemId: string; label: string | null }> | null,
  store: VaultStoreKind,
): Promise<void> {
  await input.scope.database
    .prepare(
      `INSERT INTO vault_item_event (organisation_id, event_id, kind, item_id,
         item_label, store, actor_user_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.scope.organisationId,
      crypto.randomUUID().replaceAll("-", ""),
      kind,
      item?.itemId ?? null,
      item?.label ?? null,
      store,
      input.userId,
      input.now,
    )
    .run();
}

function commandEvent(command: VaultItemCommand): VaultEventKind {
  switch (command.kind) {
    case "edit_login":
    case "edit_contact":
      return "item_edited";
    case "replace_sign_in":
      return "sign_in_replaced";
    case "remove":
      return "item_removed";
    default:
      return assertNever(command);
  }
}

async function pantryItemLabel(
  scope: OrganisationExecutionScope,
  itemId: string,
): Promise<string | null> {
  const row = await scope.database
    .prepare(
      `SELECT label FROM vault_item WHERE organisation_id = ? AND vault_item_id = ?`,
    )
    .bind(scope.organisationId, itemId)
    .first<{ readonly label: string }>();
  return row?.label ?? null;
}

async function readOnePasswordStore(
  scope: OrganisationExecutionScope,
): Promise<OnePasswordStore | null> {
  const row = await scope.database
    .prepare(
      `SELECT onepassword_vault_id AS vaultId,
         onepassword_vault_title AS vaultTitle, token_handle AS tokenHandle,
         connected_at AS connectedAt
       FROM vault_store WHERE organisation_id = ? AND store = 'onepassword'`,
    )
    .bind(scope.organisationId)
    .first<{
      readonly vaultId: string;
      readonly vaultTitle: string;
      readonly tokenHandle: string;
      readonly connectedAt: number;
    }>();
  if (row === null) return null;
  const handle = parseVaultHandle(row.tokenHandle);
  if (!handle.ok) throw new Error("vault_store_row_invalid");
  return { ...row, tokenHandle: handle.value };
}

function storeView(
  store: OnePasswordStore,
  reachable: boolean,
): VaultStoreView {
  return {
    kind: "onepassword",
    vaultTitle: store.vaultTitle,
    connectedAt: store.connectedAt,
    reachable,
  };
}

async function listOnePasswordItems(
  env: VaultStoreEnv,
  scope: OrganisationExecutionScope,
  store: OnePasswordStore,
): Promise<readonly VaultItemView[] | null> {
  const cached = listCache.get(scope.organisationId);
  if (
    cached !== undefined &&
    cached.expiresAt > Date.now() &&
    cached.vaultId === store.vaultId &&
    cached.tokenHandle === store.tokenHandle
  )
    return cached.items;
  const answer = await callOnePassword({ env, scope }, store, {
    op: "list_items",
    vaultId: store.vaultId,
  });
  if (!answer.ok || !("items" in answer.value)) return null;
  listCache.set(scope.organisationId, {
    items: answer.value.items,
    expiresAt: Date.now() + LIST_LIFETIME_MS,
    vaultId: store.vaultId,
    tokenHandle: store.tokenHandle,
  });
  return answer.value.items;
}

async function callOnePassword(
  input: Readonly<{ env: VaultStoreEnv; scope: OrganisationExecutionScope }>,
  store: OnePasswordStore,
  operation: OnePasswordOperation,
): Promise<
  Result<Exclude<OnePasswordResponse, { ok: false }>, VaultItemStoreError>
> {
  const token = await resolveVaultHandle({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.scope.organisationId,
    handle: store.tokenHandle,
  });
  if (!token.ok || token.value.kind !== "bearer")
    return { ok: false, error: { code: "vault_store_auth_failed" } };
  if (operation.op !== "list_items")
    listCache.delete(input.scope.organisationId);
  return parseOnePasswordAnswer(
    await sendOnePassword(input.env, token.value.value, operation),
  );
}

async function sendOnePassword(
  env: VaultStoreEnv,
  token: string,
  operation: OnePasswordOperation,
): Promise<OnePasswordResponse> {
  try {
    const response = await env.VAULT_ONEPASSWORD.fetch(
      "https://vault-onepassword.internal/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...operation, token }),
      },
    );
    return parseOnePasswordResponse(await response.json());
  } catch {
    return { ok: false, code: "onepassword_unavailable" };
  }
}

function parseOnePasswordAnswer(
  response: OnePasswordResponse,
): Result<Exclude<OnePasswordResponse, { ok: false }>, VaultItemStoreError> {
  return response.ok
    ? { ok: true, value: response }
    : { ok: false, error: { code: storeErrorCode(response.code) } };
}

function storeErrorCode(
  code: OnePasswordErrorCode,
): VaultItemStoreError["code"] {
  switch (code) {
    case "onepassword_auth_failed":
      return "vault_store_auth_failed";
    case "onepassword_item_missing":
      return "vault_item_not_found";
    case "onepassword_version_conflict":
      return "vault_item_revision_conflict";
    case "onepassword_rate_limited":
      return "vault_store_rate_limited";
    case "onepassword_request_invalid":
      return "vault_item_store_failed";
    case "onepassword_unavailable":
      return "vault_store_unavailable";
    default:
      return assertNever(code);
  }
}

function revokeStatement(
  input: Readonly<{ scope: OrganisationExecutionScope; now: number }>,
  handle: VaultHandle,
): D1PreparedStatement {
  return input.scope.database
    .prepare(
      `UPDATE vault_secret SET revoked_at = ?
       WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.scope.organisationId, handle);
}

function unavailable(): Result<never, VaultItemStoreError> {
  return { ok: false, error: { code: "vault_store_unavailable" } };
}
