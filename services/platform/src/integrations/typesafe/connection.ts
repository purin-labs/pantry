import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { type SchemaTransaction } from "@purin-labs/actor-runtime/actors/schema-migrations";
import {
  parseVaultHandle,
  type VaultHandle,
} from "../../credential-vault/domain";
import {
  resolveVaultHandle,
  revokeVaultSecret,
  storeOrganisationExecutionVaultSecret,
} from "../../credential-vault/service";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import type { CredentialVaultBindings } from "../../credential-vault/keyring";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { validJevApiKey, type JevError } from "./system-one-client";
import { probeTypeSafeConnection } from "./connection-probe";
import { isRecord } from "@purin-labs/std";

type Connection =
  | Readonly<{
      kind: "disconnected";
      revision: number;
      provider?: never;
      handle?: never;
      testedAt?: never;
    }>
  | Readonly<{
      kind: "connected";
      revision: number;
      provider: "typesafe";
      handle: VaultHandle;
      testedAt: number;
    }>;

export type TypeSafeConnectionView = Readonly<{
  apiKey?: never;
  handle?: never;
}> &
  (
    | Readonly<{
        kind: "disconnected";
        revision: number;
        provider?: never;
        testedAt?: never;
      }>
    | Readonly<{
        kind: "connected";
        revision: number;
        provider: "typesafe";
        testedAt: number;
      }>
  );

type ConnectionError = Readonly<{
  code:
    | JevError["code"]
    | "jev_connection_invalid"
    | "typesafe_revision_conflict"
    | "jev_test_rate_limited"
    | "jev_credential_store_failed"
    | "organisation_placement_conflict"
    | "typesafe_credential_cleanup_failed";
}>;

type Mutation =
  | Readonly<{
      operation: "connect";
      expectedRevision: number;
      provider: "typesafe";
      apiKey: string;
    }>
  | Readonly<{
      operation: "disconnect" | "test";
      expectedRevision: number;
      provider?: never;
      apiKey?: never;
    }>;

type ConnectionContext = Readonly<{
  sql: SqlStorage;
  transaction: SchemaTransaction;
  keys: CredentialVaultBindings;
  scope: OrganisationExecutionScope;
}>;

export function createTypeSafeConnectionSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS typesafe_connection (
    organisation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
    provider TEXT, vault_handle TEXT, tested_at INTEGER, probe_at INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    CHECK ((provider IS NULL AND vault_handle IS NULL AND tested_at IS NULL) OR
      (provider = 'typesafe' AND vault_handle IS NOT NULL AND tested_at IS NOT NULL))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS typesafe_credential_cleanup (
    organisation_id TEXT NOT NULL, vault_handle TEXT NOT NULL,
    PRIMARY KEY (organisation_id, vault_handle)
  )`);
}

function readConnection(
  sql: SqlStorage,
  organisationId: OrganisationId,
): Connection {
  const row = sql
    .exec<{
      revision: number;
      provider: SqlStorageValue;
      vault_handle: SqlStorageValue;
      tested_at: SqlStorageValue;
    }>(
      "SELECT revision, provider, vault_handle, tested_at FROM typesafe_connection WHERE organisation_id = ?",
      organisationId,
    )
    .toArray()[0];
  if (row === undefined) return { kind: "disconnected", revision: 0 };
  if (!integerIn(row.revision, 0, Number.MAX_SAFE_INTEGER))
    throw new Error("jev_connection_corrupt");
  if (
    row.provider === null &&
    row.vault_handle === null &&
    row.tested_at === null
  ) {
    return { kind: "disconnected", revision: row.revision };
  }
  if (
    row.provider !== "typesafe" ||
    typeof row.vault_handle !== "string" ||
    !integerIn(row.tested_at, 0, Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("jev_connection_corrupt");
  }
  const handle = parseVaultHandle(row.vault_handle);
  if (
    !handle.ok ||
    !handle.value.startsWith(`vault:${organisationId.toLowerCase()}:`)
  )
    throw new Error("jev_connection_corrupt");
  return {
    kind: "connected",
    revision: row.revision,
    provider: row.provider,
    handle: handle.value,
    testedAt: row.tested_at,
  };
}

export function readTypeSafeConnection(
  sql: SqlStorage,
  organisationId: OrganisationId,
): TypeSafeConnectionView {
  const current = readConnection(sql, organisationId);
  if (current.kind === "disconnected") return current;
  return {
    kind: "connected",
    revision: current.revision,
    provider: current.provider,
    testedAt: current.testedAt,
  };
}

/** Reads the Organisation's own key from the Vault. Callers use `resolveTypeSafeCredential`. */
export async function resolveTypeSafeConnectionKey(
  input: Readonly<{
    sql: SqlStorage;
    db: OrganisationDatabase;
    keys: CredentialVaultBindings;
    organisationId: OrganisationId;
  }>,
): Promise<Readonly<{
  provider: "typesafe";
  apiKey: string;
  revision: number;
}> | null> {
  const current = readConnection(input.sql, input.organisationId);
  if (current.kind === "disconnected") return null;
  const resolved = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: current.handle,
  });
  if (
    !resolved.ok ||
    resolved.value.kind !== "bearer" ||
    !validJevApiKey(resolved.value.value)
  )
    return null;
  if (
    readConnection(input.sql, input.organisationId).revision !==
    current.revision
  )
    return null;
  return {
    provider: current.provider,
    apiKey: resolved.value.value,
    revision: current.revision,
  };
}

function parseMutation(raw: unknown): Mutation | null {
  if (
    !isRecord(raw) ||
    !integerIn(raw.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)
  )
    return null;
  if (
    (raw.operation === "disconnect" || raw.operation === "test") &&
    Object.keys(raw).length === 2
  ) {
    return { operation: raw.operation, expectedRevision: raw.expectedRevision };
  }
  if (
    raw.operation !== "connect" ||
    Object.keys(raw).length !== 4 ||
    raw.provider !== "typesafe" ||
    typeof raw.apiKey !== "string"
  )
    return null;
  const apiKey = raw.apiKey.trim();
  if (!validJevApiKey(apiKey)) return null;
  return {
    operation: "connect",
    expectedRevision: raw.expectedRevision,
    provider: raw.provider,
    apiKey,
  };
}

export async function mutateTypeSafeConnection(
  input: ConnectionContext &
    Readonly<{
      actorId: string;
      body: unknown;
      fetcher: typeof fetch;
      now: () => number;
    }>,
): Promise<Result<TypeSafeConnectionView, ConnectionError>> {
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return failure("organisation_placement_conflict");
  const mutation = parseMutation(input.body);
  if (mutation === null) return failure("jev_connection_invalid");
  const current = readConnection(input.sql, input.scope.organisationId);
  if (current.revision !== mutation.expectedRevision)
    return failure("typesafe_revision_conflict");
  if (mutation.operation === "disconnect") {
    input.transaction(disconnect.bind(null, input, current));
    if (current.kind === "connected") {
      const cleaned = await cleanupTypeSafeCredential(
        input.sql,
        input.scope.database,
        input.scope.organisationId,
        current.handle,
        input.now(),
      );
      if (!cleaned.ok) return cleaned;
    }
    return {
      ok: true,
      value: readTypeSafeConnection(input.sql, input.scope.organisationId),
    };
  }
  // Each organisation can make at most one synthetic connection probe per 30s.
  const probeAt = input.now();
  const previousProbe = input.sql
    .exec<{ probe_at: number }>(
      "SELECT probe_at FROM typesafe_connection WHERE organisation_id = ?",
      input.scope.organisationId,
    )
    .toArray()[0];
  if (previousProbe !== undefined && probeAt - previousProbe.probe_at < 30_000)
    return failure("jev_test_rate_limited");
  input.sql.exec(
    `INSERT INTO typesafe_connection (organisation_id, revision, updated_by, probe_at)
    VALUES (?, 0, ?, ?) ON CONFLICT (organisation_id) DO UPDATE SET probe_at = excluded.probe_at`,
    input.scope.organisationId,
    input.actorId,
    probeAt,
  );
  const credential =
    mutation.operation === "connect"
      ? { provider: mutation.provider, apiKey: mutation.apiKey }
      : await resolveTypeSafeConnectionKey({
          sql: input.sql,
          db: input.scope.database,
          keys: input.keys,
          organisationId: input.scope.organisationId,
        });
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return failure("organisation_placement_conflict");
  if (credential === null) return failure("jev_credential_unavailable");
  const evaluated = await probeTypeSafeConnection({
    apiKey: credential.apiKey,
    signal: new AbortController().signal,
    fetcher: fetchTypeSafeConnection.bind(null, input),
  });
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return failure("organisation_placement_conflict");
  if (
    readConnection(input.sql, input.scope.organisationId).revision !==
    current.revision
  )
    return failure("typesafe_revision_conflict");
  if (!evaluated.ok) {
    if (
      mutation.operation === "test" &&
      current.kind === "connected" &&
      evaluated.error.code === "jev_credential_rejected"
    ) {
      input.transaction(disconnect.bind(null, input, current));
      const cleaned = await cleanupTypeSafeCredential(
        input.sql,
        input.scope.database,
        input.scope.organisationId,
        current.handle,
        input.now(),
      );
      if (!cleaned.ok) return cleaned;
    }
    return evaluated;
  }
  if (mutation.operation === "test") {
    input.sql.exec(
      "UPDATE typesafe_connection SET tested_at = ? WHERE organisation_id = ? AND revision = ?",
      input.now(),
      input.scope.organisationId,
      current.revision,
    );
    return {
      ok: true,
      value: readTypeSafeConnection(input.sql, input.scope.organisationId),
    };
  }
  const handle = parseVaultHandle(
    `vault:${input.scope.organisationId.toLowerCase()}:typesafe:${crypto.randomUUID()}`,
  );
  if (!handle.ok) throw new Error("jev_handle_invalid");
  // Retain the candidate before the Vault write so interrupted publication can revoke it.
  queueTypeSafeCredentialCleanup(
    input.sql,
    input.scope.organisationId,
    handle.value,
  );
  const stored = await storeOrganisationExecutionVaultSecret({
    scope: input.scope,
    sql: input.sql,
    keys: input.keys,
    handle: handle.value,
    secret: { kind: "bearer", value: credential.apiKey },
    now: input.now(),
  });
  if (!stored.ok) {
    const cleaned = await cleanupTypeSafeCredential(
      input.sql,
      input.scope.database,
      input.scope.organisationId,
      handle.value,
      input.now(),
    );
    if (!cleaned.ok) return cleaned;
    return failure(
      stored.error.code === "organisation_placement_conflict"
        ? stored.error.code
        : "jev_credential_store_failed",
    );
  }
  if (!(await isOrganisationExecutionActive(input.sql, input.scope))) {
    const cleaned = await cleanupTypeSafeCredential(
      input.sql,
      input.scope.database,
      input.scope.organisationId,
      handle.value,
      input.now(),
    );
    if (!cleaned.ok) return cleaned;
    return failure("organisation_placement_conflict");
  }
  if (
    readConnection(input.sql, input.scope.organisationId).revision !==
    current.revision
  ) {
    const cleaned = await cleanupTypeSafeCredential(
      input.sql,
      input.scope.database,
      input.scope.organisationId,
      handle.value,
      input.now(),
    );
    if (!cleaned.ok) return cleaned;
    return failure("typesafe_revision_conflict");
  }
  input.transaction(
    connect.bind(null, input, current, credential.provider, handle.value),
  );
  if (current.kind === "connected") {
    const cleaned = await cleanupTypeSafeCredential(
      input.sql,
      input.scope.database,
      input.scope.organisationId,
      current.handle,
      input.now(),
    );
    if (!cleaned.ok) return cleaned;
  }
  return {
    ok: true,
    value: readTypeSafeConnection(input.sql, input.scope.organisationId),
  };
}

function connect(
  input: ConnectionContext & { actorId: string; now: () => number },
  current: Connection,
  provider: "typesafe",
  handle: VaultHandle,
): void {
  if (current.kind === "connected")
    queueTypeSafeCredentialCleanup(
      input.sql,
      input.scope.organisationId,
      current.handle,
    );
  input.sql.exec(
    "DELETE FROM typesafe_credential_cleanup WHERE organisation_id = ? AND vault_handle = ?",
    input.scope.organisationId,
    handle,
  );
  input.sql.exec(
    `UPDATE typesafe_connection SET revision = ?, provider = ?, vault_handle = ?, tested_at = ?, updated_by = ? WHERE organisation_id = ?`,
    current.revision + 1,
    provider,
    handle,
    input.now(),
    input.actorId,
    input.scope.organisationId,
  );
}

function disconnect(
  input: ConnectionContext & { actorId: string; now: () => number },
  current: Connection,
): void {
  if (current.kind === "connected")
    queueTypeSafeCredentialCleanup(
      input.sql,
      input.scope.organisationId,
      current.handle,
    );
  input.sql.exec(
    `INSERT INTO typesafe_connection (organisation_id, revision, updated_by) VALUES (?, ?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET revision = excluded.revision, provider = NULL, vault_handle = NULL, tested_at = NULL, updated_by = excluded.updated_by`,
    input.scope.organisationId,
    current.revision + 1,
    input.actorId,
  );
}

async function fetchTypeSafeConnection(
  input: Pick<ConnectionContext, "sql" | "scope"> & {
    readonly fetcher: typeof fetch;
  },
  request: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    throw new Error("organisation_placement_conflict");
  // The runtime's fetch throws "Illegal invocation" when it is called as a
  // property of another object, so the call does not go through `input`.
  const fetcher = input.fetcher;
  return fetcher(request, init);
}

function queueTypeSafeCredentialCleanup(
  sql: SqlStorage,
  organisationId: OrganisationId,
  handle: VaultHandle,
): void {
  sql.exec(
    "INSERT OR IGNORE INTO typesafe_credential_cleanup VALUES (?, ?)",
    organisationId,
    handle,
  );
}

async function cleanupTypeSafeCredential(
  sql: SqlStorage,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  handle: VaultHandle,
  now: number,
): Promise<
  Result<null, { readonly code: "typesafe_credential_cleanup_failed" }>
> {
  try {
    await revokeVaultSecret({ db, organisationId, handle, now });
  } catch {
    return { ok: false, error: { code: "typesafe_credential_cleanup_failed" } };
  }
  sql.exec(
    "DELETE FROM typesafe_credential_cleanup WHERE organisation_id = ? AND vault_handle = ?",
    organisationId,
    handle,
  );
  return { ok: true, value: null };
}

export async function cleanupTypeSafeCredentials(
  input: Readonly<{
    sql: SqlStorage;
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    now: number;
  }>,
): Promise<
  Result<null, { readonly code: "typesafe_credential_cleanup_failed" }>
> {
  const current = readConnection(input.sql, input.organisationId);
  const rows = input.sql
    .exec<{ vault_handle: string }>(
      "SELECT vault_handle FROM typesafe_credential_cleanup WHERE organisation_id = ?",
      input.organisationId,
    )
    .toArray();
  for (const row of rows) {
    const handle = parseVaultHandle(row.vault_handle);
    if (
      !handle.ok ||
      !handle.value.startsWith(`vault:${input.organisationId.toLowerCase()}:`)
    )
      throw new Error("typesafe_cleanup_corrupt");
    if (current.kind === "connected" && current.handle === handle.value)
      throw new Error("typesafe_cleanup_current_credential");
    const cleaned = await cleanupTypeSafeCredential(
      input.sql,
      input.db,
      input.organisationId,
      handle.value,
      input.now,
    );
    if (!cleaned.ok) return cleaned;
  }
  return { ok: true, value: null };
}

function failure(
  code: ConnectionError["code"],
): Result<never, ConnectionError> {
  return { ok: false, error: { code } };
}

function integerIn(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
