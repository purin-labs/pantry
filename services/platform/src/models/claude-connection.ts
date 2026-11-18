import { isRecord } from "@seams/std";
import type { ModelRoute } from "@seams/contracts";
import type { VariantBy } from "@seams/type-utils";
import {
  organisationPlacementPredicate,
  type OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type { UserId } from "../ids";
import type { Result } from "../result";
import type { CredentialVaultBindings } from "../credential-vault/keyring";
import {
  modelProviderFetch,
  type ModelExitBinding,
} from "../model-exit/provider-fetch";
import { parseVaultHandle, type VaultHandle } from "../credential-vault/domain";
import {
  resolveVaultHandle,
  storeOrganisationPlacementVaultSecret,
} from "../credential-vault/service";
import {
  claudeAuthorizationUrl,
  createClaudeAuthorization,
  exchangeClaudeAuthorizationCode,
  refreshClaudeTokens,
  type ClaudeTokens,
} from "./claude-oauth";

import type {
  ClaudeConnection,
  ClaudeAuthorization,
  ClaudeAuthorizationState,
} from "@seams/control-api";
export type { ClaudeConnection, ClaudeAuthorization } from "@seams/control-api";

/**
 * `keys` holds the vault roots and the model exit Worker, which sends each
 * token request to Anthropic (Plan 73).
 */
type Context = Readonly<{
  scope: OrganisationExecutionScope;
  keys: CredentialVaultBindings & ModelExitBinding;
}>;
type ConnectionRecord = Readonly<{
  connectionId: string;
  handle: VaultHandle;
}> &
  (
    | Readonly<{ kind: "connected"; refreshUntil?: never }>
    | Readonly<{ kind: "refreshing"; refreshUntil: number }>
    | Readonly<{ kind: "action_required"; refreshUntil?: never }>
  );
type ConnectionError = Readonly<{
  code:
    | "claude_connection_unavailable"
    | "claude_authorization_expired"
    | "claude_oauth_code_invalid"
    | "claude_oauth_provider_unavailable";
}>;
type PendingAuthorization = Readonly<{
  attemptId: string;
  userId: string;
  handle: VaultHandle;
  expiresAt: number;
  state: "pending" | "exchanging";
}>;

export async function readClaudeConnection(
  context: Context,
): Promise<ClaudeConnection> {
  if (!(await context.scope.isActive())) return { kind: "disconnected" };
  const record = await readConnectionRecord(context);
  if (record === null) return { kind: "disconnected" };
  if (
    record.kind === "action_required" ||
    (record.kind === "refreshing" && record.refreshUntil <= Date.now())
  ) {
    return { kind: "action_required", connectionId: record.connectionId };
  }
  return { kind: "connected", connectionId: record.connectionId };
}

export async function startClaudeAuthorization(
  context: Context,
  userId: UserId,
): Promise<Result<ClaudeAuthorization, ConnectionError>> {
  if (!(await context.scope.isActive())) return unavailable();
  const existing = await readClaudeAuthorization(context, userId);
  if (existing.kind === "authorizing")
    return { ok: true, value: existing.authorization };
  const now = Date.now();
  const authorization = await createClaudeAuthorization();
  const attemptId = crypto.randomUUID();
  const handle = newHandle(context, "authorization");
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: context.scope,
    keys: context.keys,
    handle,
    secret: {
      kind: "expiring_bearer",
      value: authorization.verifier,
      expiresAt: now + 600_000,
    },
    now,
  });
  if (!stored.ok) return unavailable();
  const previous = await readPendingAuthorization(context);
  const placement = organisationPlacementPredicate(context.scope);
  const written = await context.scope.database
    .prepare(
      `INSERT INTO organisation_claude_authorization
       (organisation_id, attempt_id, user_id, verifier_handle, expires_at, state)
     SELECT ?, ?, ?, ?, ?, 'pending' WHERE ${placement.sql}
     ON CONFLICT (organisation_id) DO UPDATE SET attempt_id = excluded.attempt_id,
       user_id = excluded.user_id, verifier_handle = excluded.verifier_handle,
       expires_at = excluded.expires_at, state = 'pending'`,
    )
    .bind(
      context.scope.organisationId,
      attemptId,
      userId,
      handle,
      now + 600_000,
      ...placement.bindings,
    )
    .run();
  if (written.meta.changes !== 1) {
    await revokeHandle(context, handle);
    return unavailable();
  }
  if (previous !== null) await revokeHandle(context, previous.handle);
  return {
    ok: true,
    value: {
      attemptId,
      authorizationUrl: authorization.authorizationUrl,
      expiresAt: now + 600_000,
    },
  };
}

export async function completeClaudeAuthorization(
  context: Context,
  input: Readonly<{
    userId: UserId;
    attemptId: string;
    code: Readonly<{ code: string; state: string }>;
  }>,
): Promise<Result<ClaudeConnection, ConnectionError>> {
  if (!(await context.scope.isActive())) return unavailable();
  const placement = organisationPlacementPredicate(context.scope);
  const pending = await readPendingAuthorization(context);
  if (
    pending === null ||
    pending.attemptId !== input.attemptId ||
    pending.userId !== input.userId ||
    pending.expiresAt <= Date.now()
  ) {
    return { ok: false, error: { code: "claude_authorization_expired" } };
  }
  const secret = await resolveVaultHandle({
    db: context.scope.database,
    keys: context.keys,
    organisationId: context.scope.organisationId,
    handle: pending.handle,
  });
  if (
    !secret.ok ||
    secret.value.kind !== "expiring_bearer" ||
    secret.value.expiresAt <= Date.now()
  )
    return unavailable();
  if (secret.value.value !== input.code.state)
    return { ok: false, error: { code: "claude_oauth_code_invalid" } };
  const claimed = await context.scope.database
    .prepare(
      `UPDATE organisation_claude_authorization SET state = 'exchanging'
     WHERE organisation_id = ? AND attempt_id = ? AND user_id = ? AND state = 'pending' AND expires_at > ? AND ${placement.sql}`,
    )
    .bind(
      context.scope.organisationId,
      input.attemptId,
      input.userId,
      Date.now(),
      ...placement.bindings,
    )
    .run();
  if (claimed.meta.changes !== 1)
    return { ok: false, error: { code: "claude_authorization_expired" } };
  const tokens = await exchangeClaudeAuthorizationCode(
    modelProviderFetch(context.keys),
    input.code.code,
    secret.value.value,
  );
  await revokeHandle(context, pending.handle);
  if (!tokens.ok) return tokens;
  if (!(await context.scope.isActive())) return unavailable();
  const handle = await storeTokens(context, tokens.value);
  if (handle === null) return unavailable();
  const previous = await readConnectionRecord(context);
  const connectionId = crypto.randomUUID();
  const installed = await context.scope.database
    .prepare(
      `INSERT INTO organisation_claude_connection (organisation_id, connection_id, credential_handle, state, refresh_lease, refresh_until)
     SELECT ?, ?, ?, 'connected', NULL, NULL WHERE EXISTS (
       SELECT 1 FROM organisation_claude_authorization WHERE organisation_id = ? AND attempt_id = ? AND state = 'exchanging' AND expires_at > ?
     ) AND ${placement.sql} ON CONFLICT (organisation_id) DO UPDATE SET connection_id = excluded.connection_id,
       credential_handle = excluded.credential_handle, state = 'connected', refresh_lease = NULL, refresh_until = NULL`,
    )
    .bind(
      context.scope.organisationId,
      connectionId,
      handle,
      context.scope.organisationId,
      input.attemptId,
      Date.now(),
      ...placement.bindings,
    )
    .run();
  if (installed.meta.changes !== 1) {
    await revokeHandle(context, handle);
    return unavailable();
  }
  await context.scope.database
    .prepare(
      `DELETE FROM organisation_claude_authorization WHERE organisation_id = ? AND attempt_id = ?`,
    )
    .bind(context.scope.organisationId, input.attemptId)
    .run();
  if (previous !== null) await revokeHandle(context, previous.handle);
  return { ok: true, value: { kind: "connected", connectionId } };
}

export async function disconnectClaude(
  context: Context,
): Promise<ClaudeConnection> {
  if (!(await context.scope.isActive()))
    throw new Error("claude_connection_unavailable");
  const placement = organisationPlacementPredicate(context.scope);
  const connection = await readConnectionRecord(context);
  const pending = await readPendingAuthorization(context);
  await context.scope.database.batch([
    context.scope.database
      .prepare(
        `DELETE FROM organisation_claude_authorization WHERE organisation_id = ? AND ${placement.sql}`,
      )
      .bind(context.scope.organisationId, ...placement.bindings),
    context.scope.database
      .prepare(
        `DELETE FROM organisation_claude_connection WHERE organisation_id = ? AND ${placement.sql}`,
      )
      .bind(context.scope.organisationId, ...placement.bindings),
  ]);
  if (!(await context.scope.isActive()))
    throw new Error("claude_connection_unavailable");
  if (connection !== null) await revokeHandle(context, connection.handle);
  if (pending !== null) await revokeHandle(context, pending.handle);
  return { kind: "disconnected" };
}

export async function resolveClaudeAccessToken(
  context: Context,
  route: VariantBy<ModelRoute, "keySource", "organisation_oauth">,
): Promise<Result<string, ConnectionError>> {
  if (!(await context.scope.isActive())) return unavailable();
  const connection = await readConnectionRecord(context);
  if (
    connection === null ||
    connection.connectionId !== route.connectionId ||
    connection.kind === "action_required"
  )
    return unavailable();
  const tokens = await readTokens(context, connection.handle);
  if (tokens === null) return unavailable();
  if (tokens.expiresAt > Date.now())
    return { ok: true, value: tokens.accessToken };

  // Only one request may consume the refresh token. New tokens use a fresh vault
  // handle, and the lease fences publication after a disconnect or reconnect.
  if (connection.kind === "refreshing")
    return waitForClaudeRefresh(context, route);
  const placement = organisationPlacementPredicate(context.scope);
  const lease = crypto.randomUUID();
  const claimed = await context.scope.database
    .prepare(
      `UPDATE organisation_claude_connection SET state = 'refreshing', refresh_lease = ?, refresh_until = ?
     WHERE organisation_id = ? AND connection_id = ? AND credential_handle = ?
       AND state = 'connected' AND ${placement.sql}`,
    )
    .bind(
      lease,
      Date.now() + 60_000,
      context.scope.organisationId,
      connection.connectionId,
      connection.handle,
      ...placement.bindings,
    )
    .run();
  if (claimed.meta.changes !== 1) return waitForClaudeRefresh(context, route);
  const refreshed = await refreshClaudeTokens(
    modelProviderFetch(context.keys),
    tokens.refreshToken,
  );
  if (!refreshed.ok) {
    // A request can consume the refresh token even if its response is lost.
    // Require a reconnect instead of replaying an uncertain token exchange.
    await context.scope.database
      .prepare(
        `UPDATE organisation_claude_connection SET state = 'action_required', refresh_lease = NULL, refresh_until = NULL
       WHERE organisation_id = ? AND connection_id = ? AND refresh_lease = ?`,
      )
      .bind(context.scope.organisationId, connection.connectionId, lease)
      .run();
    return refreshed;
  }
  const handle = await storeTokens(context, refreshed.value);
  if (handle === null) return unavailable();
  const published = await context.scope.database
    .prepare(
      `UPDATE organisation_claude_connection SET credential_handle = ?, state = 'connected', refresh_lease = NULL, refresh_until = NULL
     WHERE organisation_id = ? AND connection_id = ? AND refresh_lease = ? AND refresh_until > ? AND ${placement.sql}`,
    )
    .bind(
      handle,
      context.scope.organisationId,
      connection.connectionId,
      lease,
      Date.now(),
      ...placement.bindings,
    )
    .run();
  if (published.meta.changes !== 1 || !(await context.scope.isActive())) {
    await revokeHandle(context, handle);
    return unavailable();
  }
  await revokeHandle(context, connection.handle);
  return { ok: true, value: refreshed.value.accessToken };
}

async function readConnectionRecord(
  context: Context,
): Promise<ConnectionRecord | null> {
  const row: unknown = await context.scope.database
    .withSession("first-primary")
    .prepare(
      `SELECT connection_id AS connectionId, credential_handle AS handle, state, refresh_until AS refreshUntil FROM organisation_claude_connection WHERE organisation_id = ?`,
    )
    .bind(context.scope.organisationId)
    .first();
  if (row === null) return null;
  if (
    !isRecord(row) ||
    typeof row.connectionId !== "string" ||
    !row.connectionId ||
    typeof row.handle !== "string"
  )
    throw new Error("claude_connection_invalid");
  const handle = parseVaultHandle(row.handle);
  if (!handle.ok) throw new Error("claude_connection_invalid");
  switch (row.state) {
    case "connected":
    case "action_required":
      return {
        kind: row.state,
        connectionId: row.connectionId,
        handle: handle.value,
      };
    case "refreshing":
      if (
        typeof row.refreshUntil !== "number" ||
        !Number.isSafeInteger(row.refreshUntil)
      )
        throw new Error("claude_connection_invalid");
      return {
        kind: "refreshing",
        connectionId: row.connectionId,
        handle: handle.value,
        refreshUntil: row.refreshUntil,
      };
    default:
      throw new Error("claude_connection_invalid");
  }
}

async function readPendingAuthorization(
  context: Context,
): Promise<PendingAuthorization | null> {
  const row: unknown = await context.scope.database
    .withSession("first-primary")
    .prepare(
      `SELECT state, attempt_id AS attemptId, user_id AS userId, verifier_handle AS handle, expires_at AS expiresAt FROM organisation_claude_authorization WHERE organisation_id = ?`,
    )
    .bind(context.scope.organisationId)
    .first();
  if (row === null) return null;
  if (
    !isRecord(row) ||
    typeof row.attemptId !== "string" ||
    typeof row.userId !== "string" ||
    typeof row.handle !== "string" ||
    typeof row.expiresAt !== "number" ||
    !Number.isSafeInteger(row.expiresAt)
  )
    throw new Error("claude_authorization_invalid");
  if (row.state !== "pending" && row.state !== "exchanging")
    throw new Error("claude_authorization_invalid");
  const handle = parseVaultHandle(row.handle);
  if (!handle.ok) throw new Error("claude_authorization_invalid");
  return {
    attemptId: row.attemptId,
    userId: row.userId,
    handle: handle.value,
    expiresAt: row.expiresAt,
    state: row.state,
  };
}

async function readTokens(
  context: Context,
  handle: VaultHandle,
): Promise<ClaudeTokens | null> {
  const secret = await resolveVaultHandle({
    db: context.scope.database,
    keys: context.keys,
    organisationId: context.scope.organisationId,
    handle,
  });
  if (
    !secret.ok ||
    secret.value.kind !== "oauth_tokens" ||
    secret.value.expiry.kind !== "expires"
  )
    return null;
  return {
    accessToken: secret.value.accessToken,
    refreshToken: secret.value.refreshToken,
    expiresAt: secret.value.expiry.expiresAt,
  };
}

async function storeTokens(
  context: Context,
  tokens: ClaudeTokens,
): Promise<VaultHandle | null> {
  const handle = newHandle(context, "tokens");
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: context.scope,
    keys: context.keys,
    handle,
    secret: {
      kind: "oauth_tokens",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiry: { kind: "expires", expiresAt: tokens.expiresAt },
    },
    now: Date.now(),
  });
  return stored.ok ? handle : null;
}

function newHandle(
  context: Context,
  purpose: "authorization" | "tokens",
): VaultHandle {
  const parsed = parseVaultHandle(
    `vault:${context.scope.organisationId.toLowerCase()}:claude:${purpose}:${crypto.randomUUID()}`,
  );
  if (!parsed.ok) throw new Error("claude_vault_handle_invalid");
  return parsed.value;
}

async function revokeHandle(
  context: Context,
  handle: VaultHandle,
): Promise<void> {
  const placement = organisationPlacementPredicate(context.scope);
  await context.scope.database
    .prepare(
      `UPDATE vault_secret SET revoked_at = ? WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL AND ${placement.sql}`,
    )
    .bind(
      Date.now(),
      context.scope.organisationId,
      handle,
      ...placement.bindings,
    )
    .run();
}

function unavailable(): Readonly<{ ok: false; error: ConnectionError }> {
  return { ok: false, error: { code: "claude_connection_unavailable" } };
}

async function waitForClaudeRefresh(
  context: Context,
  route: VariantBy<ModelRoute, "keySource", "organisation_oauth">,
): Promise<Result<string, ConnectionError>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await scheduler.wait(250);
    if (!(await context.scope.isActive())) return unavailable();
    const connection = await readConnectionRecord(context);
    if (
      connection === null ||
      connection.connectionId !== route.connectionId ||
      connection.kind === "action_required"
    )
      return unavailable();
    if (connection.kind === "refreshing") {
      if (connection.refreshUntil <= Date.now()) return unavailable();
      continue;
    }
    const tokens = await readTokens(context, connection.handle);
    return tokens !== null && tokens.expiresAt > Date.now()
      ? { ok: true, value: tokens.accessToken }
      : unavailable();
  }
  return unavailable();
}

export async function readClaudeAuthorization(
  context: Context,
  userId: UserId,
): Promise<ClaudeAuthorizationState> {
  const pending = await readPendingAuthorization(context);
  if (
    pending === null ||
    pending.userId !== userId ||
    pending.state !== "pending" ||
    pending.expiresAt <= Date.now()
  )
    return { kind: "idle" };
  const secret = await resolveVaultHandle({
    db: context.scope.database,
    keys: context.keys,
    organisationId: context.scope.organisationId,
    handle: pending.handle,
  });
  if (
    !secret.ok ||
    secret.value.kind !== "expiring_bearer" ||
    secret.value.expiresAt <= Date.now()
  )
    return { kind: "idle" };
  return {
    kind: "authorizing",
    authorization: {
      attemptId: pending.attemptId,
      expiresAt: pending.expiresAt,
      authorizationUrl: await claudeAuthorizationUrl(secret.value.value),
    },
  };
}
