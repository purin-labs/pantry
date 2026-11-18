import {
  parseVaultItemCommand,
  parseVaultItemCreate,
  parseVaultStoreCommand,
} from "@seams/control-api";
import { assertNever } from "@seams/std";

import {
  commandVaultStoreItem,
  connectOnePassword,
  createVaultStoreItem,
  disconnectOnePassword,
  listVaultEvents,
  listVaultStoreItems,
  moveVaultItems,
  readVaultStoreSummary,
  type VaultItemStoreError,
} from "../../credential-vault";
import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";
import type { Variant } from "@seams/type-utils";

/**
 * Settings → Vault (Plan 79): website logins and contact profiles, kept in
 * Pantry Vault or in a connected 1Password vault, and the Vault's audit log.
 */
export type VaultRoute =
  | Readonly<{ kind: "vaultItems"; organisationId: OrganisationId }>
  | Readonly<{
      kind: "vaultItemCommands";
      organisationId: OrganisationId;
      itemId: string;
    }>
  | Readonly<{ kind: "vaultStore"; organisationId: OrganisationId }>
  | Readonly<{ kind: "vaultEvents"; organisationId: OrganisationId }>;

const VAULT_ITEM_BODY_LIMIT = 16_384;

export function matchVaultRoute(pathname: string): VaultRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/vault\/(items(?:\/([0-9a-f]{32}|[0-9a-z]{26})\/commands)?|store|events)$/.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) return null;
    if (match[2] === "store")
      return { kind: "vaultStore", organisationId: organisationId.value };
    if (match[2] === "events")
      return { kind: "vaultEvents", organisationId: organisationId.value };
    return match[3] === undefined
      ? { kind: "vaultItems", organisationId: organisationId.value }
      : {
          kind: "vaultItemCommands",
          organisationId: organisationId.value,
          itemId: match[3],
        };
  } catch {
    return null;
  }
}

export async function handleVaultRoute(
  request: Request,
  env: Env,
  route: VaultRoute,
): Promise<Response> {
  try {
    switch (route.kind) {
      case "vaultItems":
        return request.method === "GET"
          ? await listItems(request, env, route.organisationId)
          : request.method === "POST"
            ? await createItem(request, env, route.organisationId)
            : controlError("method_not_allowed", 405);
      case "vaultItemCommands":
        return request.method === "POST"
          ? await commandItem(request, env, route)
          : controlError("method_not_allowed", 405);
      case "vaultStore":
        return request.method === "GET"
          ? await readStore(request, env, route.organisationId)
          : request.method === "POST"
            ? await commandStore(request, env, route.organisationId)
            : controlError("method_not_allowed", 405);
      case "vaultEvents":
        return request.method === "GET"
          ? await listEvents(request, env, route.organisationId)
          : controlError("method_not_allowed", 405);
      default:
        return assertNever(route);
    }
  } catch {
    return controlError("vault_unavailable", 503);
  }
}

// Every member sees which logins and contact profiles agents may use. Only a
// login's username and origins are shown; its password never leaves its store.
async function listItems(
  request: Request,
  env: Env,
  organisationId: OrganisationId,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const listed = await listVaultStoreItems({
    env,
    scope: authorized.executionScope,
  });
  return controlJson({ ok: true, store: listed.store, items: listed.items });
}

async function createItem(
  request: Request,
  env: Env,
  organisationId: OrganisationId,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(request, VAULT_ITEM_BODY_LIMIT);
  const create = body === null ? null : parseVaultItemCreate(body);
  if (create === null) return controlError("vault_item_invalid", 422);
  const created = await createVaultStoreItem({
    env,
    scope: authorized.executionScope,
    userId: authorized.authenticated.session.userId,
    now: Date.now(),
    create,
  });
  return created.ok
    ? controlJson({ ok: true, item: created.value })
    : vaultStoreError(created.error);
}

async function commandItem(
  request: Request,
  env: Env,
  route: Variant<VaultRoute, "vaultItemCommands">,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(request, VAULT_ITEM_BODY_LIMIT);
  const command = body === null ? null : parseVaultItemCommand(body);
  if (command === null) return controlError("vault_item_invalid", 422);
  const outcome = await commandVaultStoreItem({
    env,
    scope: authorized.executionScope,
    userId: authorized.authenticated.session.userId,
    now: Date.now(),
    itemId: route.itemId,
    command,
  });
  if (!outcome.ok) return vaultStoreError(outcome.error);
  return outcome.value.kind === "item"
    ? controlJson({ ok: true, item: outcome.value.item })
    : controlJson({ ok: true, removed: outcome.value.itemId });
}

// The Integrations card shows where the items live without a 1Password call,
// so a page visit never spends the service account's rate limit.
async function readStore(
  request: Request,
  env: Env,
  organisationId: OrganisationId,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  return controlJson({
    ok: true,
    store: await readVaultStoreSummary(authorized.executionScope),
  });
}

// Connecting 1Password hands Pantry a service account token, so only an owner
// or an admin can do it, and the token travels only in this request.
async function commandStore(
  request: Request,
  env: Env,
  organisationId: OrganisationId,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(request, VAULT_ITEM_BODY_LIMIT);
  const command = body === null ? null : parseVaultStoreCommand(body);
  if (command === null) return controlError("vault_store_invalid", 422);
  const input = {
    env,
    scope: authorized.executionScope,
    userId: authorized.authenticated.session.userId,
    now: Date.now(),
  };
  switch (command.kind) {
    case "connect_onepassword": {
      const connected = await connectOnePassword({
        ...input,
        token: command.token,
        vaultId: command.vaultId,
      });
      if (!connected.ok) return vaultStoreError(connected.error);
      return connected.value.kind === "store"
        ? controlJson({ ok: true, kind: "store", store: connected.value.store })
        : controlJson({
            ok: true,
            kind: "choose_vault",
            vaults: connected.value.vaults,
          });
    }
    case "disconnect_onepassword": {
      const disconnected = await disconnectOnePassword(input);
      return disconnected.ok
        ? controlJson({ ok: true, kind: "store", store: disconnected.value })
        : vaultStoreError(disconnected.error);
    }
    case "move_items": {
      const moved = await moveVaultItems({ ...input, to: command.to });
      return moved.ok
        ? controlJson({ ok: true, kind: "moved", ...moved.value })
        : vaultStoreError(moved.error);
    }
    default:
      return assertNever(command);
  }
}

async function listEvents(
  request: Request,
  env: Env,
  organisationId: OrganisationId,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const itemId = new URL(request.url).searchParams.get("itemId");
  if (itemId !== null && !/^([0-9a-f]{32}|[0-9a-z]{26})$/.test(itemId))
    return controlError("vault_item_invalid", 422);
  return controlJson({
    ok: true,
    events: await listVaultEvents(authorized.executionScope, itemId),
  });
}

function vaultStoreError(error: VaultItemStoreError): Response {
  switch (error.code) {
    case "vault_item_not_found":
      return controlError(error.code, 404);
    case "vault_item_revision_conflict":
    case "vault_item_limit_reached":
    case "vault_store_not_connected":
    case "vault_store_auth_failed":
      return controlError(error.code, 409);
    case "vault_store_vault_unknown":
      return controlError(error.code, 422);
    case "vault_store_rate_limited":
      return controlError(error.code, 429);
    case "vault_item_store_failed":
    case "vault_store_unavailable":
      return controlError(error.code, 503);
    default:
      return assertNever(error);
  }
}
