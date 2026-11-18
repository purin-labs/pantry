import {
  parseChannelId,
  parseCaseId,
  parseConnectorId,
  parseSessionId,
  parseOrganisationId,
  parseThreadId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import { organisationDataArchivePrefix } from "../data/organisation-regional-copy";
import {
  parseActorFenceToken,
  parseActorRegistryId,
  type ActorFenceToken,
  type ActorRegistryId,
  type ActorIdentity,
} from "./actor-registry";
import type { CountRow } from "./sql-rows";
import {
  canonicalJson,
  decodeBase64,
  encodeBase64,
  errorMessage,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
} from "@seams/std";

declare const actorExportIdBrand: unique symbol;

export type ActorExportId = string & {
  readonly [actorExportIdBrand]: "ActorExportId";
};

export type PortableStateValue =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bytes"; readonly valueB64: string }
  | { readonly kind: "array"; readonly values: readonly PortableStateValue[] }
  | {
      readonly kind: "object";
      readonly entries: readonly PortableActorEntry[];
    };

export type PortableActorEntry = {
  readonly key: string;
  readonly value: PortableStateValue;
};

export type ActorExportTable = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly PortableStateValue[])[];
};

export type ActorImportSqlMigration = {
  prepare(sql: SqlStorage, tables: readonly ActorExportTable[]): void;
  complete(sql: SqlStorage): void;
};

export type ActorExportKvEntry = {
  readonly key: string;
  readonly value: PortableStateValue;
};

export type ActorExportR2Object = {
  readonly customMetadata: Readonly<Record<string, string>> | null;
  readonly httpMetadata: Readonly<Record<string, string>> | null;
  readonly sourceKey: string;
  readonly archiveKey: string;
  readonly size: number;
  readonly digestB64: string;
};

export type ActorExportSource = {
  readonly registryId: ActorRegistryId;
  readonly fenceToken: ActorFenceToken;
  readonly identity: ActorIdentity;
  readonly physicalObjectName: string;
  readonly placementEpoch: number;
  readonly schemaVersion: number;
  readonly stateVersion: number;
};

export type ActorExportPayloadV1 = {
  readonly format: "satyr-state-object-export";
  readonly version: 1;
  readonly exportId: ActorExportId;
  readonly source: ActorExportSource;
  readonly exportedAt: number;
  readonly alarmAt: number | null;
  readonly tables: readonly ActorExportTable[];
  readonly kv: readonly ActorExportKvEntry[];
  readonly r2: readonly ActorExportR2Object[];
};

export type ActorExportEnvelopeV1 = {
  readonly format: "satyr-state-object-export-envelope";
  readonly version: 1;
  readonly payload: ActorExportPayloadV1;
  readonly payloadDigestB64: string;
};

export type ActorExportRef = {
  readonly exportId: ActorExportId;
  readonly organisationId: OrganisationId;
  readonly key: string;
  readonly payloadDigestB64: string;
  readonly createdAt: number;
};

export type ActorExportRequest = {
  readonly expectedFenceToken: ActorFenceToken;
  readonly exportId: ActorExportId;
  readonly requestedAt: number;
};

export type ActorImportRequest = {
  readonly expectedTargetFenceToken: ActorFenceToken;
  readonly exportRef: ActorExportRef;
  readonly requestedAt: number;
};

export type ActorImportedState = {
  readonly stateVersion: number;
};

export type ActorExportError =
  | { readonly code: "actor_cleanup_failed"; readonly detail: string }
  | { readonly code: "invalid_export_input"; readonly field: string }
  | { readonly code: "actor_not_activated" }
  | { readonly code: "actor_fence_mismatch" }
  | { readonly code: "unsupported_state_value"; readonly path: string }
  | { readonly code: "export_root_unavailable" }
  | { readonly code: "export_root_invalid" }
  | { readonly code: "export_manifest_corrupt" }
  | { readonly code: "export_checksum_mismatch" }
  | { readonly code: "export_write_failed"; readonly detail: string }
  | { readonly code: "export_read_failed"; readonly detail: string }
  | { readonly code: "export_missing" }
  | { readonly code: "referenced_r2_missing"; readonly key: string }
  | { readonly code: "referenced_r2_corrupt"; readonly key: string }
  | { readonly code: "target_not_empty"; readonly table: string }
  | {
      readonly code: "target_schema_incompatible";
      readonly table: string;
      readonly column: string | null;
    }
  | { readonly code: "import_conflict" };

type ActivationExportRow = Record<string, SqlStorageValue> & {
  registry_id: string;
  organisation_id: string;
  object_kind: string;
  logical_object_id: string;
  physical_object_name: string;
  placement_epoch: number;
  schema_version: number;
  state_version: number;
  fence_token: string;
};

type SchemaTableRow = Record<string, SqlStorageValue> & {
  name: string;
};

type TableColumnRow = Record<string, SqlStorageValue> & {
  cid: number;
  name: string;
};

type ImportRow = Record<string, SqlStorageValue> & {
  export_id: string;
  payload_digest_b64: string;
  state: string;
};

type ParsedEncryptedEnvelope = {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
};

const EXPORT_FORMAT_VERSION = 1;
const EXPORT_MAGIC = new TextEncoder().encode("SATYRDO1");
const EXPORT_CONTEXT = "satyr-state-object-export-v1";
const EXPORT_ROOT_BYTES = 32;
const EXPORT_IV_BYTES = 12;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPORT_ID_PATTERN = /^doe_[0-9a-f-]+$/;
const MAX_EXPORT_MANIFEST_BYTES = 64 * 1024 * 1024;
const INTERNAL_TABLES = new Set([
  "do_schema_meta",
  "do_schema_migration",
  "state_object_activation",
  "state_object_import",
  "state_object_policy_export_barrier",
  "state_object_cleanup_export_barrier",
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createActorImportSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS state_object_import (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      export_id TEXT NOT NULL,
      payload_digest_b64 TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('sql_imported', 'complete')),
      imported_at INTEGER NOT NULL
    )`,
  );
}

export function createUserIdentityRestoreReceiptSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS user_identity_restore (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    export_digest TEXT NOT NULL, mapping_digest TEXT NOT NULL,
    projection_digest TEXT NOT NULL, original_cells_json TEXT NOT NULL CHECK (json_valid(original_cells_json))
  )`);
}

export function newActorExportId(): ActorExportId {
  const parsed = parseActorExportId(`doe_${crypto.randomUUID()}`);

  if (!parsed.ok) {
    throw new Error("generated actor export id is invalid");
  }

  return parsed.value;
}

export function parseActorExportId(
  value: unknown,
): Result<ActorExportId, ActorExportError> {
  return validExportId(value)
    ? { ok: true, value }
    : {
        ok: false,
        error: { code: "invalid_export_input", field: "export_id" },
      };
}

export function parseActorExportRef(
  value: unknown,
): Result<ActorExportRef, ActorExportError> {
  return validExportRef(value)
    ? { ok: true, value }
    : {
        ok: false,
        error: { code: "invalid_export_input", field: "export_ref" },
      };
}

export function exportActorPlacement(input: {
  readonly storage: DurableObjectStorage;
  readonly bucket: R2Bucket;
  readonly root: SecretsStoreSecret;
  readonly request: ActorExportRequest;
  readonly referencedR2Keys: readonly string[];
}): Promise<Result<ActorExportRef, ActorExportError>> {
  return captureActorExport({
    storage: input.storage,
    bucket: input.bucket,
    root: input.root,
    expectedFenceToken: input.request.expectedFenceToken,
    exportId: input.request.exportId,
    referencedR2Keys: input.referencedR2Keys,
    now: input.request.requestedAt,
  });
}

export async function importActorPlacement(input: {
  readonly storage: DurableObjectStorage;
  readonly bucket: R2Bucket;
  readonly root: SecretsStoreSecret;
  readonly request: ActorImportRequest;
  readonly sqlMigration?: ActorImportSqlMigration;
}): Promise<Result<ActorImportedState, ActorExportError>> {
  const loaded = await loadActorExport({
    bucket: input.bucket,
    root: input.root,
    ref: input.request.exportRef,
  });

  if (!loaded.ok) {
    return loaded;
  }

  return importActorExport({
    storage: input.storage,
    bucket: input.bucket,
    envelope: loaded.value,
    expectedTargetFenceToken: input.request.expectedTargetFenceToken,
    now: input.request.requestedAt,
    sqlMigration: input.sqlMigration,
  });
}

export async function captureActorExport(input: {
  readonly storage: DurableObjectStorage;
  readonly bucket: R2Bucket;
  readonly root: SecretsStoreSecret;
  readonly expectedFenceToken: ActorFenceToken;
  readonly exportId: ActorExportId;
  readonly referencedR2Keys: readonly string[];
  readonly now: number;
}): Promise<Result<ActorExportRef, ActorExportError>> {
  const activation = readActivationExportSource(input.storage.sql);

  if (!activation.ok) {
    return activation;
  }

  if (activation.value.fenceToken !== input.expectedFenceToken) {
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  }

  if (!validExportId(input.exportId) || !validTimestamp(input.now)) {
    return {
      ok: false,
      error: { code: "invalid_export_input", field: "identity" },
    };
  }

  const tables = captureSqlTables(input.storage.sql);

  if (!tables.ok) {
    return tables;
  }

  const kv = await captureKvEntries(input.storage);

  if (!kv.ok) {
    return kv;
  }

  const r2 = await copyReferencedR2Objects({
    bucket: input.bucket,
    organisationId: activation.value.identity.organisationId,
    exportId: input.exportId,
    keys: input.referencedR2Keys,
  });

  if (!r2.ok) {
    return r2;
  }

  const payload: ActorExportPayloadV1 = {
    format: "satyr-state-object-export",
    version: EXPORT_FORMAT_VERSION,
    exportId: input.exportId,
    source: activation.value,
    exportedAt: input.now,
    alarmAt: await input.storage.getAlarm(),
    tables: tables.value,
    kv: kv.value,
    r2: r2.value,
  };
  const envelope = await createActorExportEnvelope(payload);
  const persisted = await persistEncryptedExportEnvelope({
    bucket: input.bucket,
    root: input.root,
    envelope,
    now: input.now,
  });

  return persisted;
}

export async function loadActorExport(input: {
  readonly bucket: R2Bucket;
  readonly root: SecretsStoreSecret;
  readonly ref: ActorExportRef;
}): Promise<Result<ActorExportEnvelopeV1, ActorExportError>> {
  if (!validExportRef(input.ref)) {
    return {
      ok: false,
      error: { code: "invalid_export_input", field: "export_ref" },
    };
  }

  let object: R2ObjectBody | null;

  try {
    object = await input.bucket.get(input.ref.key);
  } catch (error) {
    return exportReadFailure(error);
  }

  if (object === null) {
    return { ok: false, error: { code: "export_missing" } };
  }

  if (object.size > MAX_EXPORT_MANIFEST_BYTES) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const encrypted = parseEncryptedEnvelope(await object.arrayBuffer());

  if (!encrypted.ok) {
    return encrypted;
  }

  const key = await deriveExportKey(
    input.root,
    input.ref.organisationId,
    input.ref.exportId,
  );

  if (!key.ok) {
    return key;
  }

  let plaintext: ArrayBuffer;

  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: encrypted.value.iv,
        additionalData: exportAad(input.ref.organisationId, input.ref.exportId),
      },
      key.value,
      encrypted.value.ciphertext,
    );
  } catch {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const parsed = await parseActorExportEnvelope(textDecoder.decode(plaintext));

  if (!parsed.ok) {
    return parsed;
  }

  return parsed.value.payload.exportId === input.ref.exportId &&
    parsed.value.payload.source.identity.organisationId ===
      input.ref.organisationId &&
    parsed.value.payloadDigestB64 === input.ref.payloadDigestB64
    ? parsed
    : { ok: false, error: { code: "export_manifest_corrupt" } };
}

export async function importActorExport(input: {
  readonly storage: DurableObjectStorage;
  readonly bucket: R2Bucket;
  readonly envelope: ActorExportEnvelopeV1;
  readonly expectedTargetFenceToken: ActorFenceToken;
  readonly now: number;
  readonly sqlMigration?: ActorImportSqlMigration;
}): Promise<Result<ActorImportedState, ActorExportError>> {
  createActorImportSchema(input.storage.sql);
  if (input.envelope.payload.tables.some(isUserIdentityRestoreReceipt)) {
    createUserIdentityRestoreReceiptSchema(input.storage.sql);
  }
  const target = readActivationExportSource(input.storage.sql);

  if (!target.ok) {
    return target;
  }

  if (target.value.fenceToken !== input.expectedTargetFenceToken) {
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  }

  if (
    !sameLogicalIdentity(
      target.value.identity,
      input.envelope.payload.source.identity,
    )
  ) {
    return { ok: false, error: { code: "import_conflict" } };
  }

  if (
    target.value.placementEpoch <=
      input.envelope.payload.source.placementEpoch ||
    target.value.schemaVersion < input.envelope.payload.source.schemaVersion
  ) {
    return { ok: false, error: { code: "import_conflict" } };
  }

  const imported = readImport(input.storage.sql);

  if (imported !== undefined && !sameImport(imported, input.envelope)) {
    return { ok: false, error: { code: "import_conflict" } };
  }

  if (imported === undefined) {
    const empty = assertEmptyImportTarget(input.storage.sql);

    if (!empty.ok) {
      return empty;
    }

    try {
      input.storage.transactionSync(
        restoreActorSql.bind(
          null,
          input.storage.sql,
          input.envelope,
          input.now,
          input.sqlMigration,
        ),
      );
    } catch (error) {
      if (error instanceof ActorImportSchemaError)
        return { ok: false, error: error.failure };
      throw error;
    }
  }

  const sourceIdentity = input.envelope.payload.source.identity;
  const transientPrefix =
    sourceIdentity.objectKind === "organisation"
      ? organisationDataArchivePrefix(
          sourceIdentity.organisationId,
          input.envelope.payload.exportId,
        )
      : null;
  const referencedObjects: ActorExportR2Object[] = [];
  for (const object of input.envelope.payload.r2) {
    // Organisation restoration reads and validates backup pages directly from the archive.
    if (
      transientPrefix !== null &&
      object.sourceKey.startsWith(transientPrefix)
    )
      continue;
    referencedObjects.push(object);
  }
  const r2 = await restoreReferencedR2Objects(input.bucket, referencedObjects);

  if (!r2.ok) {
    return r2;
  }

  const decodedKv = decodeKvEntries(input.envelope.payload.kv);

  if (!decodedKv.ok) {
    return decodedKv;
  }

  if (Object.keys(decodedKv.value).length > 0) {
    await input.storage.put(decodedKv.value);
  }

  if (input.envelope.payload.alarmAt === null) {
    await input.storage.deleteAlarm();
  } else {
    await input.storage.setAlarm(input.envelope.payload.alarmAt);
  }

  input.storage.sql.exec(
    `UPDATE state_object_import
     SET state = 'complete', imported_at = ?
     WHERE singleton = 1 AND export_id = ? AND payload_digest_b64 = ?`,
    input.now,
    input.envelope.payload.exportId,
    input.envelope.payloadDigestB64,
  );

  const restored = readActivationExportSource(input.storage.sql);
  return restored.ok
    ? { ok: true, value: { stateVersion: restored.value.stateVersion } }
    : restored;
}

function isUserIdentityRestoreReceipt(table: ActorExportTable): boolean {
  return table.name === "user_identity_restore";
}

export async function createActorExportEnvelope(
  payload: ActorExportPayloadV1,
): Promise<ActorExportEnvelopeV1> {
  return {
    format: "satyr-state-object-export-envelope",
    version: EXPORT_FORMAT_VERSION,
    payload,
    payloadDigestB64: await payloadDigest(payload),
  };
}

export async function parseActorExportEnvelope(
  raw: string,
): Promise<Result<ActorExportEnvelopeV1, ActorExportError>> {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const parsed = parseExportEnvelopeValue(value);

  if (!parsed.ok) {
    return parsed;
  }

  if (!plainObject(value))
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  const expected = parsed.value.payloadDigestB64;
  // Verify the persisted shape before normalizing older metadata-free records.
  const matches =
    (await sha256Base64(canonicalJson(value.payload))) === expected ||
    (await sha256Base64(JSON.stringify(value.payload))) === expected;

  return matches
    ? parsed
    : { ok: false, error: { code: "export_checksum_mismatch" } };
}

export function readActivationExportSource(
  sql: SqlStorage,
): Result<ActorExportSource, ActorExportError> {
  const row = sql
    .exec<ActivationExportRow>(
      `SELECT
       registry_id,
       organisation_id,
       object_kind,
       logical_object_id,
       physical_object_name,
       placement_epoch,
       schema_version,
       state_version,
       fence_token
     FROM state_object_activation
     WHERE singleton = 1`,
    )
    .toArray()[0];

  if (row === undefined) {
    return { ok: false, error: { code: "actor_not_activated" } };
  }

  const identity = parseExportIdentity(row);
  const registryId = parseActorRegistryId(row.registry_id);
  const fenceToken = parseActorFenceToken(row.fence_token);

  if (
    !identity.ok ||
    !registryId.ok ||
    !fenceToken.ok ||
    !isNonEmptyString(row.physical_object_name) ||
    !isPositiveInteger(row.placement_epoch) ||
    !isPositiveInteger(row.schema_version) ||
    !isPositiveInteger(row.state_version)
  ) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  return {
    ok: true,
    value: {
      registryId: registryId.value,
      fenceToken: fenceToken.value,
      identity: identity.value,
      physicalObjectName: row.physical_object_name,
      placementEpoch: row.placement_epoch,
      schemaVersion: row.schema_version,
      stateVersion: row.state_version,
    },
  };
}

function captureSqlTables(
  sql: SqlStorage,
): Result<readonly ActorExportTable[], ActorExportError> {
  const tableRows = sql
    .exec<SchemaTableRow>(
      `SELECT name
     FROM sqlite_schema
     WHERE type = 'table'
     ORDER BY name`,
    )
    .toArray();
  const tables: ActorExportTable[] = [];

  for (const tableRow of tableRows) {
    if (!exportableTableName(tableRow.name)) {
      continue;
    }

    const captured = captureSqlTable(sql, tableRow.name);

    if (!captured.ok) {
      return captured;
    }

    tables.push(captured.value);
  }

  tables.sort(compareExportTables);
  return { ok: true, value: tables };
}

function captureSqlTable(
  sql: SqlStorage,
  table: string,
): Result<ActorExportTable, ActorExportError> {
  const columns = tableColumns(sql, table);

  if (columns.length === 0) {
    return {
      ok: false,
      error: { code: "target_schema_incompatible", table, column: null },
    };
  }

  const selectedColumns = columns.join(", ");
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT ${selectedColumns} FROM ${table}`,
    )
    .toArray();
  const portableRows: PortableStateValue[][] = [];

  for (const row of rows) {
    const portableRow: PortableStateValue[] = [];

    for (const column of columns) {
      const encoded = encodePortableValue(row[column], `${table}.${column}`);

      if (!encoded.ok) {
        return encoded;
      }

      portableRow.push(encoded.value);
    }

    portableRows.push(portableRow);
  }

  portableRows.sort(comparePortableRows);
  return { ok: true, value: { name: table, columns, rows: portableRows } };
}

async function captureKvEntries(
  storage: DurableObjectStorage,
): Promise<Result<readonly ActorExportKvEntry[], ActorExportError>> {
  const values = await storage.list<unknown>();
  const entries: ActorExportKvEntry[] = [];

  for (const [key, value] of values.entries()) {
    const encoded = encodePortableValue(value, `kv.${key}`);

    if (!encoded.ok) {
      return encoded;
    }

    entries.push({ key, value: encoded.value });
  }

  entries.sort(compareKvEntries);
  return { ok: true, value: entries };
}

async function copyReferencedR2Objects(input: {
  readonly bucket: R2Bucket;
  readonly organisationId: OrganisationId;
  readonly exportId: ActorExportId;
  readonly keys: readonly string[];
}): Promise<Result<readonly ActorExportR2Object[], ActorExportError>> {
  const uniqueKeys = [...new Set(input.keys)];
  uniqueKeys.sort(compareStrings);
  const objects: ActorExportR2Object[] = [];
  // Bound open R2 operations and retained object bodies during export.
  const concurrency = 6;
  for (let offset = 0; offset < uniqueKeys.length; offset += concurrency) {
    const pending: Promise<Result<ActorExportR2Object, ActorExportError>>[] =
      [];
    for (
      let index = offset;
      index < Math.min(offset + concurrency, uniqueKeys.length);
      index++
    ) {
      pending.push(copyReferencedR2Object(input, uniqueKeys[index]!, index));
    }
    // Finish this batch before returning a failure so caller cleanup cannot
    // delete temporary source pages while another copy still reads them.
    const results = await Promise.allSettled(pending);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (!result.value.ok) return result.value;
      objects.push(result.value.value);
    }
  }
  return { ok: true, value: objects };
}

async function copyReferencedR2Object(
  input: {
    readonly bucket: R2Bucket;
    readonly organisationId: OrganisationId;
    readonly exportId: ActorExportId;
  },
  sourceKey: string,
  index: number,
): Promise<Result<ActorExportR2Object, ActorExportError>> {
  let source: R2ObjectBody | null;
  try {
    source = await input.bucket.get(sourceKey);
  } catch (error) {
    return exportReadFailure(error);
  }
  if (source === null) {
    return {
      ok: false,
      error: { code: "referenced_r2_missing", key: sourceKey },
    };
  }
  const bytes = await source.arrayBuffer();
  const digestB64 = await sha256Base64(bytes);
  const archiveKey = actorReferencedArchiveKey(
    input.organisationId,
    input.exportId,
    index,
  );
  try {
    await input.bucket.put(archiveKey, bytes, {
      customMetadata: {
        format: "satyr-state-object-r2-copy-v1",
        sourceKey,
        digestB64,
      },
    });
  } catch (error) {
    return exportWriteFailure(error);
  }
  return {
    ok: true,
    value: {
      sourceKey,
      archiveKey,
      size: bytes.byteLength,
      digestB64,
      customMetadata: source.customMetadata ?? {},
      httpMetadata: readR2HttpMetadata(source),
    },
  };
}

export async function restoreReferencedR2Objects(
  bucket: R2Bucket,
  objects: readonly ActorExportR2Object[],
): Promise<Result<null, ActorExportError>> {
  for (const object of objects) {
    const current = await readR2Object(bucket, object.sourceKey);

    if (
      current.ok &&
      (await matchesR2Manifest(current.value.bytes, object)) &&
      (object.customMetadata === null ||
        canonicalJson(current.value.customMetadata) ===
          canonicalJson(object.customMetadata)) &&
      (object.httpMetadata === null ||
        canonicalJson(current.value.httpMetadata) ===
          canonicalJson(object.httpMetadata))
    ) {
      continue;
    }

    const archived = await readR2Object(bucket, object.archiveKey);

    if (!archived.ok) {
      return archived;
    }

    if (!(await matchesR2Manifest(archived.value.bytes, object))) {
      return {
        ok: false,
        error: { code: "referenced_r2_corrupt", key: object.archiveKey },
      };
    }

    try {
      await bucket.put(object.sourceKey, archived.value.bytes, {
        customMetadata: object.customMetadata ?? {},
        httpMetadata: new Headers(object.httpMetadata ?? {}),
      });
    } catch (error) {
      return exportWriteFailure(error);
    }
  }

  return { ok: true, value: null };
}

async function readR2Object(
  bucket: R2Bucket,
  key: string,
): Promise<
  Result<
    {
      bytes: ArrayBuffer;
      customMetadata: Readonly<Record<string, string>>;
      httpMetadata: Readonly<Record<string, string>>;
    },
    ActorExportError
  >
> {
  let object: R2ObjectBody | null;

  try {
    object = await bucket.get(key);
  } catch (error) {
    return exportReadFailure(error);
  }

  return object === null
    ? { ok: false, error: { code: "referenced_r2_missing", key } }
    : {
        ok: true,
        value: {
          bytes: await object.arrayBuffer(),
          customMetadata: object.customMetadata ?? {},
          httpMetadata: readR2HttpMetadata(object),
        },
      };
}

function readR2HttpMetadata(
  object: R2Object,
): Readonly<Record<string, string>> {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  return Object.fromEntries(headers);
}

async function matchesR2Manifest(
  bytes: ArrayBuffer,
  manifest: ActorExportR2Object,
): Promise<boolean> {
  return (
    bytes.byteLength === manifest.size &&
    (await sha256Base64(bytes)) === manifest.digestB64
  );
}

async function persistEncryptedExportEnvelope(input: {
  readonly bucket: R2Bucket;
  readonly root: SecretsStoreSecret;
  readonly envelope: ActorExportEnvelopeV1;
  readonly now: number;
}): Promise<Result<ActorExportRef, ActorExportError>> {
  const organisationId = input.envelope.payload.source.identity.organisationId;
  const exportId = input.envelope.payload.exportId;
  const key = await deriveExportKey(input.root, organisationId, exportId);

  if (!key.ok) {
    return key;
  }

  const plaintext = textEncoder.encode(JSON.stringify(input.envelope));

  if (plaintext.byteLength > MAX_EXPORT_MANIFEST_BYTES) {
    return {
      ok: false,
      error: { code: "invalid_export_input", field: "manifest_size" },
    };
  }

  const iv = crypto.getRandomValues(new Uint8Array(EXPORT_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: exportAad(organisationId, exportId),
    },
    key.value,
    plaintext,
  );
  const keyName = actorExportKey(organisationId, exportId);

  try {
    await input.bucket.put(
      keyName,
      encryptedEnvelope(iv, new Uint8Array(ciphertext)),
      {
        customMetadata: {
          format: "satyr-state-object-export-v1",
          payloadDigestB64: input.envelope.payloadDigestB64,
        },
      },
    );
  } catch (error) {
    return exportWriteFailure(error);
  }

  return {
    ok: true,
    value: {
      exportId,
      organisationId,
      key: keyName,
      payloadDigestB64: input.envelope.payloadDigestB64,
      createdAt: input.now,
    },
  };
}

async function deriveExportKey(
  root: SecretsStoreSecret,
  organisationId: OrganisationId,
  exportId: ActorExportId,
): Promise<Result<CryptoKey, ActorExportError>> {
  let encodedRoot: string;

  try {
    encodedRoot = (await root.get()).trim();
  } catch {
    return { ok: false, error: { code: "export_root_unavailable" } };
  }

  const rawRoot = decodeBase64(encodedRoot);

  if (rawRoot === null || rawRoot.byteLength !== EXPORT_ROOT_BYTES) {
    return { ok: false, error: { code: "export_root_invalid" } };
  }

  const material = await crypto.subtle.importKey(
    "raw",
    rawRoot,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`${EXPORT_CONTEXT}:${organisationId}`),
      info: textEncoder.encode(exportId),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { ok: true, value: key };
}

function exportAad(
  organisationId: OrganisationId,
  exportId: ActorExportId,
): Uint8Array {
  return textEncoder.encode(`${EXPORT_CONTEXT}:${organisationId}:${exportId}`);
}

function encryptedEnvelope(iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const output = new Uint8Array(
    EXPORT_MAGIC.byteLength + iv.byteLength + ciphertext.byteLength,
  );
  output.set(EXPORT_MAGIC, 0);
  output.set(iv, EXPORT_MAGIC.byteLength);
  output.set(ciphertext, EXPORT_MAGIC.byteLength + iv.byteLength);
  return output;
}

function parseEncryptedEnvelope(
  raw: ArrayBuffer,
): Result<ParsedEncryptedEnvelope, ActorExportError> {
  const bytes = new Uint8Array(raw);
  const minimum = EXPORT_MAGIC.byteLength + EXPORT_IV_BYTES + 16;

  if (bytes.byteLength < minimum || !equalPrefix(bytes, EXPORT_MAGIC)) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  return {
    ok: true,
    value: {
      iv: bytes.slice(
        EXPORT_MAGIC.byteLength,
        EXPORT_MAGIC.byteLength + EXPORT_IV_BYTES,
      ),
      ciphertext: bytes.slice(EXPORT_MAGIC.byteLength + EXPORT_IV_BYTES),
    },
  };
}

function assertEmptyImportTarget(
  sql: SqlStorage,
): Result<null, ActorExportError> {
  const tables = exportableTableNames(sql);

  for (const table of tables) {
    const row = sql
      .exec<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`)
      .toArray()[0];

    if (row === undefined || !isNonNegativeInteger(row.count)) {
      return {
        ok: false,
        error: { code: "target_schema_incompatible", table, column: null },
      };
    }

    if (row.count > 0) {
      return { ok: false, error: { code: "target_not_empty", table } };
    }
  }

  return { ok: true, value: null };
}

function assertCompatibleTargetSchema(
  sql: SqlStorage,
  tables: readonly ActorExportTable[],
): Result<null, ActorExportError> {
  const targetTables = new Set(exportableTableNames(sql));

  for (const table of tables) {
    if (!targetTables.has(table.name)) {
      return {
        ok: false,
        error: {
          code: "target_schema_incompatible",
          table: table.name,
          column: null,
        },
      };
    }

    const targetColumns = new Set(tableColumns(sql, table.name));

    for (const column of table.columns) {
      if (!targetColumns.has(column)) {
        return {
          ok: false,
          error: {
            code: "target_schema_incompatible",
            table: table.name,
            column,
          },
        };
      }
    }
  }

  return { ok: true, value: null };
}

class ActorImportSchemaError extends Error {
  constructor(readonly failure: ActorExportError) {
    super(failure.code);
  }
}

function restoreActorSql(
  sql: SqlStorage,
  envelope: ActorExportEnvelopeV1,
  now: number,
  migration: ActorImportSqlMigration | undefined,
): void {
  // Schema normalization and the import receipt share the row-import transaction.
  migration?.prepare(sql, envelope.payload.tables);
  const compatible = assertCompatibleTargetSchema(sql, envelope.payload.tables);
  if (!compatible.ok) throw new ActorImportSchemaError(compatible.error);
  importSqlTables(
    sql,
    envelope.payload.tables,
    envelope.payload.exportId,
    envelope.payloadDigestB64,
    now,
  );
  migration?.complete(sql);
  // A fresh target starts at version 1. Preserve the source version with its rows.
  sql.exec(
    "UPDATE state_object_activation SET state_version = max(state_version, ?) WHERE singleton = 1",
    envelope.payload.source.stateVersion,
  );
}

function importSqlTables(
  sql: SqlStorage,
  tables: readonly ActorExportTable[],
  exportId: ActorExportId,
  payloadDigestB64: string,
  now: number,
): void {
  sql.exec("PRAGMA defer_foreign_keys = ON");

  for (const table of tables) {
    const columns = table.columns.join(", ");
    const placeholders = table.columns.map(questionMark).join(", ");

    for (const row of table.rows) {
      const values: SqlStorageValue[] = [];

      for (const value of row) {
        values.push(decodePortableSqlValue(value));
      }

      sql.exec(
        `INSERT INTO ${table.name} (${columns}) VALUES (${placeholders})`,
        ...values,
      );
    }
  }

  sql.exec(
    `INSERT INTO state_object_import (
       singleton,
       export_id,
       payload_digest_b64,
       state,
       imported_at
     )
     VALUES (1, ?, ?, 'sql_imported', ?)`,
    exportId,
    payloadDigestB64,
    now,
  );
}

function decodeKvEntries(
  entries: readonly ActorExportKvEntry[],
): Result<Record<string, unknown>, ActorExportError> {
  const values: Record<string, unknown> = {};

  for (const entry of entries) {
    const decoded = decodePortableValue(entry.value, `kv.${entry.key}`);

    if (!decoded.ok) {
      return decoded;
    }

    values[entry.key] = decoded.value;
  }

  return { ok: true, value: values };
}

function readImport(sql: SqlStorage): ImportRow | undefined {
  return sql
    .exec<ImportRow>(
      `SELECT export_id, payload_digest_b64, state
     FROM state_object_import
     WHERE singleton = 1`,
    )
    .toArray()[0];
}

function sameImport(row: ImportRow, envelope: ActorExportEnvelopeV1): boolean {
  return (
    row.export_id === envelope.payload.exportId &&
    row.payload_digest_b64 === envelope.payloadDigestB64 &&
    (row.state === "sql_imported" || row.state === "complete")
  );
}

function encodePortableValue(
  value: unknown,
  path: string,
): Result<PortableStateValue, ActorExportError> {
  if (value === null) {
    return { ok: true, value: { kind: "null" } };
  }

  if (typeof value === "boolean") {
    return { ok: true, value: { kind: "boolean", value } };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value: { kind: "number", value } };
  }

  if (typeof value === "string") {
    return { ok: true, value: { kind: "string", value } };
  }

  const bytes = bytesFromUnknown(value);

  if (bytes !== null) {
    return {
      ok: true,
      value: { kind: "bytes", valueB64: encodeBase64(bytes) },
    };
  }

  if (Array.isArray(value)) {
    const values: PortableStateValue[] = [];
    let index = 0;

    for (const item of value) {
      const encoded = encodePortableValue(item, `${path}[${index}]`);

      if (!encoded.ok) {
        return encoded;
      }

      values.push(encoded.value);
      index += 1;
    }

    return { ok: true, value: { kind: "array", values } };
  }

  if (plainObject(value)) {
    const keys = Object.keys(value);
    keys.sort(compareStrings);
    const entries: PortableActorEntry[] = [];

    for (const key of keys) {
      const encoded = encodePortableValue(value[key], `${path}.${key}`);

      if (!encoded.ok) {
        return encoded;
      }

      entries.push({ key, value: encoded.value });
    }

    return { ok: true, value: { kind: "object", entries } };
  }

  return { ok: false, error: { code: "unsupported_state_value", path } };
}

function decodePortableValue(
  value: PortableStateValue,
  path: string,
): Result<unknown, ActorExportError> {
  switch (value.kind) {
    case "null":
      return { ok: true, value: null };
    case "boolean":
    case "number":
    case "string":
      return { ok: true, value: value.value };
    case "bytes": {
      const bytes = decodeBase64(value.valueB64);
      return bytes === null
        ? { ok: false, error: { code: "unsupported_state_value", path } }
        : { ok: true, value: bytes.buffer };
    }
    case "array": {
      const values: unknown[] = [];
      let index = 0;

      for (const item of value.values) {
        const decoded = decodePortableValue(item, `${path}[${index}]`);

        if (!decoded.ok) {
          return decoded;
        }

        values.push(decoded.value);
        index += 1;
      }

      return { ok: true, value: values };
    }
    case "object": {
      const object: Record<string, unknown> = {};

      for (const entry of value.entries) {
        const decoded = decodePortableValue(
          entry.value,
          `${path}.${entry.key}`,
        );

        if (!decoded.ok) {
          return decoded;
        }

        object[entry.key] = decoded.value;
      }

      return { ok: true, value: object };
    }
  }
}

function decodePortableSqlValue(value: PortableStateValue): SqlStorageValue {
  switch (value.kind) {
    case "null":
      return null;
    case "number":
    case "string":
      return value.value;
    case "bytes": {
      const bytes = decodeBase64(value.valueB64);
      if (bytes === null) throw new Error("portable_sql_bytes_invalid");
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    }
    case "boolean":
    case "array":
    case "object":
      throw new Error(`portable_sql_value_invalid:${value.kind}`);
  }
}

function parseExportEnvelopeValue(
  value: unknown,
): Result<ActorExportEnvelopeV1, ActorExportError> {
  if (
    !plainObject(value) ||
    value.format !== "satyr-state-object-export-envelope" ||
    value.version !== EXPORT_FORMAT_VERSION ||
    typeof value.payloadDigestB64 !== "string"
  ) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const payload = parseExportPayload(value.payload);

  return payload.ok
    ? {
        ok: true,
        value: {
          format: "satyr-state-object-export-envelope",
          version: EXPORT_FORMAT_VERSION,
          payload: payload.value,
          payloadDigestB64: value.payloadDigestB64,
        },
      }
    : payload;
}

function parseExportPayload(
  value: unknown,
): Result<ActorExportPayloadV1, ActorExportError> {
  if (
    !plainObject(value) ||
    value.format !== "satyr-state-object-export" ||
    value.version !== EXPORT_FORMAT_VERSION ||
    !validExportId(value.exportId) ||
    !validTimestamp(value.exportedAt) ||
    !(value.alarmAt === null || validTimestamp(value.alarmAt)) ||
    !Array.isArray(value.tables) ||
    !Array.isArray(value.kv) ||
    !Array.isArray(value.r2)
  ) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const source = parseExportSource(value.source);
  const tables = parseExportTables(value.tables);
  const kv = parseExportKvEntries(value.kv);
  const r2 = parseExportR2Objects(value.r2);

  if (!source.ok || !tables.ok || !kv.ok || !r2.ok) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  return {
    ok: true,
    value: {
      format: "satyr-state-object-export",
      version: EXPORT_FORMAT_VERSION,
      exportId: value.exportId,
      source: source.value,
      exportedAt: value.exportedAt,
      alarmAt: value.alarmAt,
      tables: tables.value,
      kv: kv.value,
      r2: r2.value,
    },
  };
}

function parseExportSource(
  value: unknown,
): Result<ActorExportSource, ActorExportError> {
  if (
    !plainObject(value) ||
    !isNonEmptyString(value.physicalObjectName) ||
    !isPositiveInteger(value.placementEpoch) ||
    !isPositiveInteger(value.schemaVersion) ||
    !isPositiveInteger(value.stateVersion)
  ) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const registryId = parseActorRegistryId(value.registryId);
  const fenceToken = parseActorFenceToken(value.fenceToken);
  const identity = parseRawExportIdentity(value.identity);

  return registryId.ok && fenceToken.ok && identity.ok
    ? {
        ok: true,
        value: {
          registryId: registryId.value,
          fenceToken: fenceToken.value,
          identity: identity.value,
          physicalObjectName: value.physicalObjectName,
          placementEpoch: value.placementEpoch,
          schemaVersion: value.schemaVersion,
          stateVersion: value.stateVersion,
        },
      }
    : { ok: false, error: { code: "export_manifest_corrupt" } };
}

function parseExportTables(
  values: readonly unknown[],
): Result<readonly ActorExportTable[], ActorExportError> {
  const tables: ActorExportTable[] = [];
  const names = new Set<string>();

  for (const value of values) {
    if (
      !plainObject(value) ||
      !exportableTableName(value.name) ||
      !Array.isArray(value.columns) ||
      !Array.isArray(value.rows) ||
      names.has(value.name)
    ) {
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    }

    const columns = parseIdentifierArray(value.columns);

    if (!columns.ok || columns.value.length === 0) {
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    }

    const rows = parsePortableRows(value.rows, columns.value.length);

    if (!rows.ok) {
      return rows;
    }

    names.add(value.name);
    tables.push({ name: value.name, columns: columns.value, rows: rows.value });
  }

  tables.sort(compareExportTables);
  return { ok: true, value: tables };
}

function parseExportKvEntries(
  values: readonly unknown[],
): Result<readonly ActorExportKvEntry[], ActorExportError> {
  const entries: ActorExportKvEntry[] = [];
  const keys = new Set<string>();

  for (const value of values) {
    if (
      !plainObject(value) ||
      !isNonEmptyString(value.key) ||
      keys.has(value.key)
    ) {
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    }

    const parsed = parsePortableValue(value.value);

    if (!parsed.ok) {
      return parsed;
    }

    keys.add(value.key);
    entries.push({ key: value.key, value: parsed.value });
  }

  entries.sort(compareKvEntries);
  return { ok: true, value: entries };
}

function parseExportR2Objects(
  values: readonly unknown[],
): Result<readonly ActorExportR2Object[], ActorExportError> {
  const objects: ActorExportR2Object[] = [];

  for (const value of values) {
    if (
      !plainObject(value) ||
      !isNonEmptyString(value.sourceKey) ||
      !isNonEmptyString(value.archiveKey) ||
      !isNonNegativeInteger(value.size) ||
      !isNonEmptyString(value.digestB64)
    ) {
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    }

    const customMetadata = parseR2Metadata(value.customMetadata);
    if (!customMetadata.ok) return customMetadata;
    const httpMetadata = parseR2Metadata(value.httpMetadata);
    if (!httpMetadata.ok) return httpMetadata;
    objects.push({
      customMetadata: customMetadata.value,
      httpMetadata: httpMetadata.value,
      sourceKey: value.sourceKey,
      archiveKey: value.archiveKey,
      size: value.size,
      digestB64: value.digestB64,
    });
  }

  return { ok: true, value: objects };
}

function parseR2Metadata(
  value: unknown,
): Result<Readonly<Record<string, string>> | null, ActorExportError> {
  // Missing metadata belongs to older persisted exports.
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!plainObject(value))
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string")
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    metadata[key] = entry;
  }
  return { ok: true, value: metadata };
}

function parsePortableRows(
  values: readonly unknown[],
  columnCount: number,
): Result<readonly (readonly PortableStateValue[])[], ActorExportError> {
  const rows: PortableStateValue[][] = [];

  for (const value of values) {
    if (!Array.isArray(value) || value.length !== columnCount) {
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    }

    const row: PortableStateValue[] = [];

    for (const cell of value) {
      const parsed = parsePortableValue(cell);

      if (!parsed.ok) {
        return parsed;
      }

      row.push(parsed.value);
    }

    rows.push(row);
  }

  rows.sort(comparePortableRows);
  return { ok: true, value: rows };
}

function parsePortableValue(
  value: unknown,
): Result<PortableStateValue, ActorExportError> {
  if (!plainObject(value) || typeof value.kind !== "string") {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  switch (value.kind) {
    case "null":
      return Object.keys(value).length === 1
        ? { ok: true, value: { kind: "null" } }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    case "boolean":
      return typeof value.value === "boolean"
        ? { ok: true, value: { kind: "boolean", value: value.value } }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    case "number":
      return typeof value.value === "number" && Number.isFinite(value.value)
        ? { ok: true, value: { kind: "number", value: value.value } }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    case "string":
      return typeof value.value === "string"
        ? { ok: true, value: { kind: "string", value: value.value } }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    case "bytes":
      return typeof value.valueB64 === "string" &&
        decodeBase64(value.valueB64) !== null
        ? { ok: true, value: { kind: "bytes", valueB64: value.valueB64 } }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    case "array":
      return parsePortableArray(value.values);
    case "object":
      return parsePortableObject(value.entries);
    default:
      return { ok: false, error: { code: "export_manifest_corrupt" } };
  }
}

function parsePortableArray(
  value: unknown,
): Result<PortableStateValue, ActorExportError> {
  if (!Array.isArray(value)) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const values: PortableStateValue[] = [];

  for (const item of value) {
    const parsed = parsePortableValue(item);

    if (!parsed.ok) {
      return parsed;
    }

    values.push(parsed.value);
  }

  return { ok: true, value: { kind: "array", values } };
}

function parsePortableObject(
  value: unknown,
): Result<PortableStateValue, ActorExportError> {
  if (!Array.isArray(value)) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const entries: PortableActorEntry[] = [];
  const keys = new Set<string>();

  for (const item of value) {
    if (
      !plainObject(item) ||
      typeof item.key !== "string" ||
      keys.has(item.key)
    ) {
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    }

    const parsed = parsePortableValue(item.value);

    if (!parsed.ok) {
      return parsed;
    }

    keys.add(item.key);
    entries.push({ key: item.key, value: parsed.value });
  }

  entries.sort(compareObjectEntries);
  return { ok: true, value: { kind: "object", entries } };
}

function parseIdentifierArray(
  values: readonly unknown[],
): Result<readonly string[], ActorExportError> {
  const columns: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (
      typeof value !== "string" ||
      !IDENTIFIER_PATTERN.test(value) ||
      seen.has(value)
    ) {
      return { ok: false, error: { code: "export_manifest_corrupt" } };
    }

    seen.add(value);
    columns.push(value);
  }

  return { ok: true, value: columns };
}

function parseExportIdentity(
  row: ActivationExportRow,
): Result<ActorIdentity, ActorExportError> {
  return parseRawExportIdentity({
    objectKind: row.object_kind,
    organisationId: row.organisation_id,
    logicalObjectId: row.logical_object_id,
  });
}

function parseRawExportIdentity(
  value: unknown,
): Result<ActorIdentity, ActorExportError> {
  if (
    !plainObject(value) ||
    typeof value.organisationId !== "string" ||
    typeof value.logicalObjectId !== "string"
  ) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  const organisationId = parseOrganisationId(value.organisationId);

  if (!organisationId.ok) {
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  }

  switch (value.objectKind) {
    case "organisation":
      return value.logicalObjectId === organisationId.value
        ? {
            ok: true,
            value: {
              objectKind: "organisation",
              organisationId: organisationId.value,
              logicalObjectId: organisationId.value,
            },
          }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    case "surface": {
      const id = parseChannelId(value.logicalObjectId);
      return id.ok
        ? {
            ok: true,
            value: {
              objectKind: "surface",
              organisationId: organisationId.value,
              logicalObjectId: id.value,
            },
          }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    }
    case "session": {
      const id = parseSessionId(value.logicalObjectId);
      return id.ok
        ? {
            ok: true,
            value: {
              objectKind: "session",
              organisationId: organisationId.value,
              logicalObjectId: id.value,
            },
          }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    }
    case "thread": {
      const id = parseThreadId(value.logicalObjectId);
      return id.ok
        ? {
            ok: true,
            value: {
              objectKind: "thread",
              organisationId: organisationId.value,
              logicalObjectId: id.value,
            },
          }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    }
    case "case": {
      const id = parseCaseId(value.logicalObjectId);
      return id.ok
        ? {
            ok: true,
            value: {
              objectKind: "case",
              organisationId: organisationId.value,
              logicalObjectId: id.value,
            },
          }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    }
    case "connector": {
      const id = parseConnectorId(value.logicalObjectId);
      return id.ok
        ? {
            ok: true,
            value: {
              objectKind: "connector",
              organisationId: organisationId.value,
              logicalObjectId: id.value,
            },
          }
        : { ok: false, error: { code: "export_manifest_corrupt" } };
    }
    default:
      return { ok: false, error: { code: "export_manifest_corrupt" } };
  }
}

function tableColumns(sql: SqlStorage, table: string): readonly string[] {
  requireIdentifier(table);
  const rows = sql
    .exec<TableColumnRow>(`PRAGMA table_info(${table})`)
    .toArray();
  rows.sort(compareColumnRows);
  const columns: string[] = [];

  for (const row of rows) {
    requireIdentifier(row.name);
    columns.push(row.name);
  }

  return columns;
}

function exportableTableNames(sql: SqlStorage): readonly string[] {
  const rows = sql
    .exec<SchemaTableRow>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`,
    )
    .toArray();
  const names: string[] = [];

  for (const row of rows) {
    if (exportableTableName(row.name)) {
      names.push(row.name);
    }
  }

  return names;
}

function exportableTableName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    IDENTIFIER_PATTERN.test(value) &&
    !value.startsWith("sqlite_") &&
    !/^_+cf_/u.test(value) &&
    !INTERNAL_TABLES.has(value)
  );
}

function requireIdentifier(value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`invalid_sql_identifier:${value}`);
  }
}

function sameLogicalIdentity(
  left: ActorIdentity,
  right: ActorIdentity,
): boolean {
  return (
    left.objectKind === right.objectKind &&
    left.organisationId === right.organisationId &&
    left.logicalObjectId === right.logicalObjectId
  );
}

function actorExportKey(
  organisationId: OrganisationId,
  exportId: ActorExportId,
): string {
  return `state-object-exports/${organisationId}/${exportId}/manifest.bin`;
}

function actorReferencedArchiveKey(
  organisationId: OrganisationId,
  exportId: ActorExportId,
  index: number,
): string {
  return `state-object-exports/${organisationId}/${exportId}/objects/${index}.bin`;
}

function questionMark(): string {
  return "?";
}

/**
 * The payload digest covers canonical JSON, so it does not depend on the order
 * in which the producer or the parser happens to build the payload's fields.
 */
function payloadDigest(payload: ActorExportPayloadV1): Promise<string> {
  return sha256Base64(canonicalJson(payload));
}

async function sha256Base64(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeBase64(new Uint8Array(digest));
}

function bytesFromUnknown(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validExportId(value: unknown): value is ActorExportId {
  return typeof value === "string" && EXPORT_ID_PATTERN.test(value);
}

function validExportRef(value: unknown): value is ActorExportRef {
  if (
    !plainObject(value) ||
    !validExportId(value.exportId) ||
    typeof value.organisationId !== "string" ||
    typeof value.key !== "string" ||
    !isNonEmptyString(value.payloadDigestB64) ||
    !validTimestamp(value.createdAt)
  ) {
    return false;
  }

  const organisationId = parseOrganisationId(value.organisationId);

  return (
    organisationId.ok &&
    value.key === actorExportKey(organisationId.value, value.exportId)
  );
}

function validTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function equalPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) {
    return false;
  }

  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (value[index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareExportTables(
  left: ActorExportTable,
  right: ActorExportTable,
): number {
  return compareStrings(left.name, right.name);
}

function compareKvEntries(
  left: ActorExportKvEntry,
  right: ActorExportKvEntry,
): number {
  return compareStrings(left.key, right.key);
}

function compareObjectEntries(
  left: PortableActorEntry,
  right: PortableActorEntry,
): number {
  return compareStrings(left.key, right.key);
}

function comparePortableRows(
  left: readonly PortableStateValue[],
  right: readonly PortableStateValue[],
): number {
  return compareStrings(JSON.stringify(left), JSON.stringify(right));
}

function compareColumnRows(
  left: TableColumnRow,
  right: TableColumnRow,
): number {
  return left.cid - right.cid;
}

function exportReadFailure(error: unknown): Result<never, ActorExportError> {
  return {
    ok: false,
    error: { code: "export_read_failed", detail: errorMessage(error) },
  };
}

function exportWriteFailure(error: unknown): Result<never, ActorExportError> {
  return {
    ok: false,
    error: { code: "export_write_failed", detail: errorMessage(error) },
  };
}
