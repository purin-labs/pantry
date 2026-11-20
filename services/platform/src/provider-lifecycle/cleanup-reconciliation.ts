import type { OrganisationDatabaseSession } from "../database-handles";
import {
  readSquareDelegation,
  type SquareDelegation,
} from "../commerce/square-link";
import {
  OrganisationExecutionScope,
  dispatchWithOrganisationPlacement,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import {
  parseVaultHandle,
  type VaultHandle,
  type VaultSecret,
  type VaultOAuthTokens,
} from "../credential-vault/domain";
import { resolveAccountRemovalCredential } from "../credential-vault/account-removal-resolution";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import { parseIntegrationAccountId, parseOrganisationId } from "../ids";
import type { Result } from "../result";
import type { CredentialVaultBindings } from "../credential-vault/keyring";
import {
  manualInstructionForProvider,
  parseActiveIntegrationProvider,
  parseProviderCleanup,
  removeProviderConnection,
} from "../provider-adapters/catalogue";
import type {
  ProviderCleanupBindings,
  ProviderCleanup,
  ProviderCleanupCredentials,
  ProviderCleanupReason,
  ProviderManualActionInstruction,
} from "../provider-adapters/domain";
import type { Variant } from "@purin-labs/type-utils";
import { backoffDelay, isString } from "@purin-labs/std";
import { prepareVaultSecretRevocation } from "../credential-vault/secret-revocation";

type ProviderCleanupEnvironment = ProviderCleanupBindings &
  CredentialVaultBindings &
  OrganisationPlacementBindings;

type ProviderCleanupRow = {
  readonly cleanupId: unknown;
  readonly organisationId: unknown;
  readonly integrationAccountId: unknown;
  readonly provider: unknown;
  readonly environment: unknown;
  readonly providerAccountId: unknown;
  readonly providerConnectionId: unknown;
  readonly credentialHandles: unknown;
  readonly providerContext: unknown;
  readonly lifecycle: unknown;
  readonly attempt: unknown;
};

type ProviderCleanupLifecycle =
  | { readonly kind: "pending_provider_cleanup"; readonly attempt: 0 }
  | { readonly kind: "running_provider_cleanup"; readonly attempt: number }
  | { readonly kind: "retry_scheduled"; readonly attempt: number };

type RunnableProviderCleanup = {
  readonly cleanup: ProviderCleanup;
  readonly lifecycle: ProviderCleanupLifecycle;
};

const PROVIDER_CLEANUP_MAX_ATTEMPTS = 5;
const PROVIDER_CLEANUP_RETRY_BASE_MS = 30_000;
const PROVIDER_CLEANUP_RETRY_MAX_MS = 60 * 60 * 1_000;
const PROVIDER_CLEANUP_LEASE_MS = 2 * 60 * 1_000;

export async function reconcileProviderAccountCleanup(input: {
  readonly env: ProviderCleanupEnvironment;
  readonly organisationId: OrganisationId;
  readonly now: number;
  readonly fetcher: typeof fetch;
}): Promise<number> {
  const resolved = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  const scope = resolved.value;
  const rows = await scope.database
    .prepare(
      `SELECT cleanup_id AS cleanupId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, provider, environment,
            provider_account_id AS providerAccountId,
            provider_connection_id AS providerConnectionId,
            credential_handles AS credentialHandles,
            provider_context AS providerContext, lifecycle, attempt
     FROM provider_account_cleanup
     WHERE organisation_id = ? AND next_attempt_at <= ?
       AND lifecycle IN (
         'pending_provider_cleanup', 'running_provider_cleanup', 'retry_scheduled'
       )
     ORDER BY created_at, cleanup_id`,
    )
    .bind(input.organisationId, input.now)
    .all<ProviderCleanupRow>();
  let repaired = 0;
  for (const row of rows.results ?? []) {
    const parsed = parseProviderCleanupRow(row, input.organisationId);
    if (!parsed.ok) continue;
    const attempt = await claimProviderCleanup(scope, parsed.value, input.now);
    if (attempt === null) continue;
    const credentials = await resolveProviderCleanupCredentials({
      env: input.env,
      scope,
      cleanup: parsed.value.cleanup,
    });
    const remote = await removeProviderConnection({
      env: input.env,
      cleanup: parsed.value.cleanup,
      credentials,
      fetcher: dispatchWithOrganisationPlacement.bind(
        null,
        scope,
        input.fetcher,
      ),
    });
    repaired += await applyProviderCleanupResult({
      scope,
      cleanup: parsed.value.cleanup,
      attempt,
      result: remote,
      now: input.now,
    });
  }
  return repaired;
}

function parseProviderCleanupRow(
  row: ProviderCleanupRow,
  expectedOrganisationId: OrganisationId,
): Result<RunnableProviderCleanup, "invalid_provider_cleanup"> {
  if (
    typeof row.cleanupId !== "string" ||
    typeof row.organisationId !== "string" ||
    row.organisationId !== expectedOrganisationId ||
    typeof row.integrationAccountId !== "string" ||
    typeof row.providerAccountId !== "string" ||
    typeof row.providerConnectionId !== "string" ||
    typeof row.provider !== "string" ||
    (row.environment !== "development" && row.environment !== "production") ||
    typeof row.credentialHandles !== "string" ||
    typeof row.providerContext !== "string"
  ) {
    return { ok: false, error: "invalid_provider_cleanup" };
  }
  const organisationId = parseOrganisationId(row.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    row.integrationAccountId,
  );
  const provider = parseActiveIntegrationProvider(row.provider);
  const lifecycle = parseProviderCleanupLifecycle(row.lifecycle, row.attempt);
  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    provider === null ||
    lifecycle === null
  ) {
    return { ok: false, error: "invalid_provider_cleanup" };
  }
  const credentialHandles = parseCleanupHandles(row.credentialHandles);
  if (credentialHandles === null)
    return { ok: false, error: "invalid_provider_cleanup" };
  const cleanup = parseProviderCleanup({
    cleanupId: row.cleanupId,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    provider,
    environment: row.environment,
    providerAccountId: row.providerAccountId,
    providerConnectionId: row.providerConnectionId,
    credentialHandles,
    rawContext: row.providerContext,
  });
  return cleanup === null
    ? { ok: false, error: "invalid_provider_cleanup" }
    : { ok: true, value: { cleanup, lifecycle } };
}

function parseCleanupHandles(raw: string): readonly VaultHandle[] | null {
  const values = parseCleanupStringArray(raw);
  if (values === null) return null;
  const handles: VaultHandle[] = [];
  for (const value of values) {
    const parsed = parseVaultHandle(value);
    if (!parsed.ok) return null;
    handles.push(parsed.value);
  }
  return handles;
}

function parseCleanupStringArray(raw: string): readonly string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(value) && value.every(isString) ? value : null;
}

async function resolveProviderCleanupCredentials(input: {
  readonly env: ProviderCleanupEnvironment;
  readonly scope: OrganisationExecutionScope;
  readonly cleanup: ProviderCleanup;
}): Promise<ProviderCleanupCredentials> {
  let bearer: Variant<VaultSecret, "bearer"> | null = null;
  let expiringBearer: Variant<VaultSecret, "expiring_bearer"> | null = null;
  let oauthTokens: VaultOAuthTokens | null = null;
  let squareDelegation: SquareDelegation | null = null;
  for (const handle of input.cleanup.credentialHandles) {
    const parsedHandle = parseVaultHandle(handle);
    if (!parsedHandle.ok) continue;
    const resolved = await resolveAccountRemovalCredential({
      db: input.scope.database,
      keys: input.env,
      cleanupId: input.cleanup.cleanupId,
      organisationId: input.cleanup.organisationId,
      integrationAccountId: input.cleanup.integrationAccountId,
      provider: input.cleanup.provider,
      environment: input.cleanup.environment,
      providerAccountId: input.cleanup.providerAccountId,
      providerConnectionId: input.cleanup.providerConnectionId,
      handle: parsedHandle.value,
    });
    if (!resolved.ok) continue;
    switch (resolved.value.kind) {
      case "bearer":
        bearer ??= resolved.value;
        break;
      case "expiring_bearer":
        expiringBearer ??= resolved.value;
        break;
      case "oauth_tokens":
        oauthTokens ??= resolved.value;
        break;
      case "opaque_profile":
        squareDelegation ??= readSquareDelegation(resolved.value);
        break;
      case "header":
      case "oauth_client_credentials":
        break;
    }
  }
  return { bearer, expiringBearer, oauthTokens, squareDelegation };
}

async function claimProviderCleanup(
  scope: OrganisationExecutionScope,
  cleanup: RunnableProviderCleanup,
  now: number,
): Promise<number | null> {
  const attempt = cleanup.lifecycle.attempt + 1;
  const claimed = await scope.database
    .prepare(
      `UPDATE provider_account_cleanup
     SET lifecycle = 'running_provider_cleanup', attempt = ?, reason_code = NULL,
         instruction_code = NULL, next_attempt_at = ?, updated_at = ?
     WHERE cleanup_id = ? AND lifecycle = ? AND attempt = ? AND next_attempt_at <= ? AND organisation_id = ?
       AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      attempt,
      now + PROVIDER_CLEANUP_LEASE_MS,
      now,
      cleanup.cleanup.cleanupId,
      cleanup.lifecycle.kind,
      cleanup.lifecycle.attempt,
      now,
      scope.organisationId,
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    )
    .run();
  return claimed.meta.changes === 1 ? attempt : null;
}

async function applyProviderCleanupResult(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    cleanup: ProviderCleanup;
    attempt: number;
    result: Awaited<ReturnType<typeof removeProviderConnection>>;
    now: number;
  }>,
): Promise<number> {
  switch (input.result.kind) {
    case "removed":
      return settleProviderCleanup({
        scope: input.scope,
        cleanup: input.cleanup,
        attempt: input.attempt,
        settlement: { kind: "completed" },
        now: input.now,
      });
    case "manual_action_required":
    case "permanent_failure":
      return settleProviderCleanup({
        scope: input.scope,
        cleanup: input.cleanup,
        attempt: input.attempt,
        settlement: {
          kind: "manual_action_required",
          reason: input.result.reason,
          instruction: input.result.instruction,
        },
        now: input.now,
      });
    case "retryable_failure":
      return input.attempt >= PROVIDER_CLEANUP_MAX_ATTEMPTS
        ? settleProviderCleanup({
            scope: input.scope,
            cleanup: input.cleanup,
            attempt: input.attempt,
            settlement: {
              kind: "manual_action_required",
              reason: input.result.reason,
              instruction: manualInstructionForProvider(input.cleanup.provider),
            },
            now: input.now,
          })
        : scheduleProviderCleanupRetry({
            scope: input.scope,
            cleanupId: input.cleanup.cleanupId,
            attempt: input.attempt,
            reason: input.result.reason,
            now: input.now,
          });
  }
}

async function scheduleProviderCleanupRetry(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    cleanupId: string;
    attempt: number;
    reason: ProviderCleanupReason;
    now: number;
  }>,
): Promise<number> {
  const statement = input.scope.database
    .prepare(
      `UPDATE provider_account_cleanup
     SET lifecycle = 'retry_scheduled', reason_code = ?, instruction_code = NULL,
         next_attempt_at = ?, updated_at = ?
     WHERE cleanup_id = ? AND lifecycle = 'running_provider_cleanup' AND attempt = ?`,
    )
    .bind(
      input.reason,
      input.now + providerCleanupRetryDelay(input.attempt),
      input.now,
      input.cleanupId,
      input.attempt,
    );
  const [scheduled] = await input.scope.database.batch([
    statement,
    input.scope.prepareMutationFence(),
  ]);
  return scheduled?.meta.changes === 1 ? 1 : 0;
}

async function settleProviderCleanup(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    cleanup: ProviderCleanup;
    attempt: number;
    settlement:
      | { readonly kind: "completed" }
      | {
          readonly kind: "manual_action_required";
          readonly reason: ProviderCleanupReason;
          readonly instruction: ProviderManualActionInstruction;
        };
    now: number;
  }>,
): Promise<number> {
  const session = input.scope.database.withSession("first-primary");
  const statements = providerCredentialRevocationStatements(
    session,
    input.cleanup,
    input.now,
  );
  const otherAccounts = await countOtherRetainedAccounts(
    session,
    input.cleanup.providerConnectionId,
    input.cleanup.integrationAccountId,
  );
  if (otherAccounts === 0) {
    statements.push(
      session
        .prepare(
          `UPDATE provider_credential_generation
         SET lifecycle = 'revoked', revoked_at = ?
         WHERE provider_connection_id = ? AND lifecycle IN ('active', 'superseded')`,
        )
        .bind(input.now, input.cleanup.providerConnectionId),
      session
        .prepare(
          `UPDATE provider_connection
         SET lifecycle = 'revoked', revoked_at = ?, disabled_at = NULL, updated_at = ?
         WHERE provider_connection_id = ? AND lifecycle != 'revoked'`,
        )
        .bind(input.now, input.now, input.cleanup.providerConnectionId),
    );
  }
  statements.push(
    session
      .prepare(
        `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM provider_account_cleanup WHERE cleanup_id = ? AND organisation_id = ?
        AND lifecycle = 'running_provider_cleanup' AND attempt = ?
    ) THEN 1 ELSE json_extract('provider_cleanup_claim_changed', '$') END`,
      )
      .bind(input.cleanup.cleanupId, input.scope.organisationId, input.attempt),
    providerCleanupSettlementStatement(session, input),
  );
  const result = await session.batch([
    ...statements,
    input.scope.prepareMutationFence(),
  ]);
  return result.at(-2)?.meta.changes === 1 ? 1 : 0;
}

function providerCredentialRevocationStatements(
  session: OrganisationDatabaseSession,
  cleanup: ProviderCleanup,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const handle of cleanup.credentialHandles) {
    statements.push(
      session
        .prepare(
          `UPDATE credential_ref SET revoked_at = ?
         WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL`,
        )
        .bind(now, cleanup.organisationId, handle),
      prepareVaultSecretRevocation(session, {
        organisationId: cleanup.organisationId,
        handle: handle,
        now: now,
      }),
    );
  }
  return statements;
}

function providerCleanupSettlementStatement(
  session: OrganisationDatabaseSession,
  input: Readonly<{
    cleanup: ProviderCleanup;
    attempt: number;
    settlement:
      | { readonly kind: "completed" }
      | {
          readonly kind: "manual_action_required";
          readonly reason: ProviderCleanupReason;
          readonly instruction: ProviderManualActionInstruction;
        };
    now: number;
  }>,
): D1PreparedStatement {
  switch (input.settlement.kind) {
    case "completed":
      return session
        .prepare(
          `UPDATE provider_account_cleanup
         SET lifecycle = 'completed', reason_code = NULL, instruction_code = NULL,
             updated_at = ?, completed_at = ?
         WHERE cleanup_id = ? AND lifecycle = 'running_provider_cleanup' AND attempt = ?`,
        )
        .bind(input.now, input.now, input.cleanup.cleanupId, input.attempt);
    case "manual_action_required":
      return session
        .prepare(
          `UPDATE provider_account_cleanup
         SET lifecycle = 'manual_action_required', reason_code = ?, instruction_code = ?,
             updated_at = ?, completed_at = ?
         WHERE cleanup_id = ? AND lifecycle = 'running_provider_cleanup' AND attempt = ?`,
        )
        .bind(
          input.settlement.reason,
          input.settlement.instruction,
          input.now,
          input.now,
          input.cleanup.cleanupId,
          input.attempt,
        );
  }
}

function providerCleanupRetryDelay(attempt: number): number {
  return backoffDelay(
    attempt - 1,
    PROVIDER_CLEANUP_RETRY_BASE_MS,
    PROVIDER_CLEANUP_RETRY_MAX_MS,
  );
}

function parseProviderCleanupLifecycle(
  rawLifecycle: unknown,
  rawAttempt: unknown,
): ProviderCleanupLifecycle | null {
  if (
    typeof rawAttempt !== "number" ||
    !Number.isSafeInteger(rawAttempt) ||
    rawAttempt < 0
  ) {
    return null;
  }
  switch (rawLifecycle) {
    case "pending_provider_cleanup":
      return rawAttempt === 0
        ? { kind: "pending_provider_cleanup", attempt: 0 }
        : null;
    case "running_provider_cleanup":
      return rawAttempt > 0
        ? { kind: "running_provider_cleanup", attempt: rawAttempt }
        : null;
    case "retry_scheduled":
      return rawAttempt > 0
        ? { kind: "retry_scheduled", attempt: rawAttempt }
        : null;
    default:
      return null;
  }
}

async function countOtherRetainedAccounts(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  providerConnectionId: string,
  integrationAccountId: IntegrationAccountId,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
     FROM integration_account
     WHERE provider_connection_id = ? AND integration_account_id != ?
       AND lifecycle != 'revoked'`,
    )
    .bind(providerConnectionId, integrationAccountId)
    .first<{ readonly count: unknown }>();
  return typeof row?.count === "number" ? row.count : 0;
}
