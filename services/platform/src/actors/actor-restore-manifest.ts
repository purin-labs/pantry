import type { OrganisationPlacementBindings } from "../organisation-execution-scope";
import type { ActorIdentity, RetiredActorRecord } from "./actor-registry";
import {
  loadActorExport,
  parseActorExportRef,
  type ActorExportEnvelopeV1,
  type ActorExportError,
  type ActorExportRef,
} from "./actor-export";
import type { Env } from "../env";
import {
  parseCaseId,
  parseConnectorId,
  parseSessionId,
  parseOrganisationId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import {
  readRetainedActorRelocationExports,
  type ActorRelocationError,
  type ActorRelocationId,
} from "./actor-relocation";
import {
  encodeBase64,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";

export type ActorRestoreCounts = {
  readonly tableCount: number;
  readonly rowCount: number;
  readonly kvEntryCount: number;
  readonly r2ObjectCount: number;
  readonly r2Bytes: number;
};

export type ActorRestoreManifestObject = {
  readonly identity: ActorIdentity;
  readonly sourceSchemaVersion: number;
  readonly sourceStateVersion: number;
  readonly exportRef: ActorExportRef;
  readonly payloadDigestB64: string;
  readonly counts: ActorRestoreCounts;
};

type ActorRestoreManifestBase = {
  readonly format: "satyr-state-object-restore-manifest";
  readonly organisationId: OrganisationId;
  readonly sourcePlacementEpoch: number;
  readonly createdAt: number;
  readonly objects: readonly ActorRestoreManifestObject[];
  readonly manifestDigestB64: string;
};

export type ActorRestoreManifest = ActorRestoreManifestBase &
  (
    | { readonly version: 1; readonly retiredActors: readonly [] }
    | {
        readonly version: 2;
        readonly retiredActors: readonly RetiredActorRecord[];
      }
  );

export type ActorRestoreManifestError =
  | ActorRelocationError
  | ActorExportError
  | { readonly code: "invalid_restore_manifest"; readonly field: string }
  | { readonly code: "restore_manifest_checksum_mismatch" }
  | { readonly code: "restore_manifest_source_mismatch" };

type RestoreManifestBindings = OrganisationPlacementBindings &
  Pick<Env, "DB" | "ARCHIVE" | "DATA_ENCRYPTION_ROOT">;
type RestoreArchiveBindings = Pick<Env, "ARCHIVE" | "DATA_ENCRYPTION_ROOT">;
const RESTORE_MANIFEST_FORMAT = "satyr-state-object-restore-manifest";
const RESTORE_MANIFEST_VERSION = 2;
const textEncoder = new TextEncoder();

export async function prepareActorRestoreManifest(input: {
  readonly env: RestoreManifestBindings;
  readonly relocationId: ActorRelocationId;
  readonly now: number;
}): Promise<Result<ActorRestoreManifest, ActorRestoreManifestError>> {
  const relocation = await readRetainedActorRelocationExports({
    env: input.env,
    relocationId: input.relocationId,
  });

  if (!relocation.ok) {
    return relocation;
  }

  const objects: ActorRestoreManifestObject[] = [];

  for (const exported of relocation.value.exports) {
    const loaded = await loadActorExport({
      bucket: input.env.ARCHIVE,
      root: input.env.DATA_ENCRYPTION_ROOT,
      ref: exported.exportRef,
    });

    if (!loaded.ok) {
      return loaded;
    }

    if (
      !exportMatchesRelocation(
        loaded.value,
        exported,
        relocation.value.sourcePlacementEpoch,
      )
    ) {
      return { ok: false, error: { code: "restore_manifest_source_mismatch" } };
    }

    objects.push(manifestObjectFromEnvelope(loaded.value, exported.exportRef));
  }

  objects.sort(compareManifestObjects);

  if (!uniqueManifestObjects(objects) || objects.length === 0) {
    return { ok: false, error: { code: "restore_manifest_source_mismatch" } };
  }

  return createRestoreManifest({
    organisationId: relocation.value.organisationId,
    sourcePlacementEpoch: relocation.value.sourcePlacementEpoch,
    createdAt: input.now,
    objects,
    retiredActors: relocation.value.retiredActors,
  });
}

export async function parseActorRestoreManifest(
  raw: unknown,
): Promise<Result<ActorRestoreManifest, ActorRestoreManifestError>> {
  if (!isRecord(raw)) {
    return invalidManifest("manifest");
  }

  if (typeof raw.organisationId !== "string") {
    return invalidManifest("organisationId");
  }

  const organisationId = parseOrganisationId(raw.organisationId);

  if (
    raw.format !== RESTORE_MANIFEST_FORMAT ||
    (raw.version !== 1 && raw.version !== RESTORE_MANIFEST_VERSION) ||
    !organisationId.ok ||
    !isPositiveInteger(raw.sourcePlacementEpoch) ||
    !timestamp(raw.createdAt) ||
    !Array.isArray(raw.objects) ||
    raw.objects.length === 0 ||
    !isNonEmptyString(raw.manifestDigestB64)
  ) {
    return invalidManifest("manifest");
  }

  const objects: ActorRestoreManifestObject[] = [];

  for (let index = 0; index < raw.objects.length; index += 1) {
    const parsed = parseManifestObject(
      raw.objects[index],
      organisationId.value,
      index,
    );

    if (!parsed.ok) {
      return parsed;
    }

    objects.push(parsed.value);
  }

  objects.sort(compareManifestObjects);

  if (!uniqueManifestObjects(objects)) {
    return invalidManifest("objects");
  }

  const retired = parseRetiredActors(raw, organisationId.value, objects);
  if (!retired.ok) return retired;
  const candidate: ActorRestoreManifest =
    raw.version === 1
      ? {
          format: RESTORE_MANIFEST_FORMAT,
          version: 1,
          organisationId: organisationId.value,
          sourcePlacementEpoch: raw.sourcePlacementEpoch,
          createdAt: raw.createdAt,
          objects,
          retiredActors: [],
          manifestDigestB64: raw.manifestDigestB64,
        }
      : {
          format: RESTORE_MANIFEST_FORMAT,
          version: 2,
          organisationId: organisationId.value,
          sourcePlacementEpoch: raw.sourcePlacementEpoch,
          createdAt: raw.createdAt,
          objects,
          retiredActors: retired.value,
          manifestDigestB64: raw.manifestDigestB64,
        };
  const expectedDigest = await restoreManifestDigest(candidate);

  return expectedDigest === candidate.manifestDigestB64
    ? { ok: true, value: candidate }
    : { ok: false, error: { code: "restore_manifest_checksum_mismatch" } };
}

export async function verifyActorRestoreManifestExports(input: {
  readonly env: RestoreArchiveBindings;
  readonly manifest: ActorRestoreManifest;
}): Promise<Result<null, ActorRestoreManifestError>> {
  for (const object of input.manifest.objects) {
    const loaded = await loadActorExport({
      bucket: input.env.ARCHIVE,
      root: input.env.DATA_ENCRYPTION_ROOT,
      ref: object.exportRef,
    });

    if (!loaded.ok) {
      return loaded;
    }

    if (!envelopeMatchesManifestObject(loaded.value, object, input.manifest)) {
      return { ok: false, error: { code: "restore_manifest_source_mismatch" } };
    }
  }

  return { ok: true, value: null };
}

export function canonicalActorRestoreManifestJson(
  manifest: ActorRestoreManifest,
): string {
  if (manifest.version === 1) {
    return JSON.stringify({
      format: manifest.format,
      version: 1,
      organisationId: manifest.organisationId,
      sourcePlacementEpoch: manifest.sourcePlacementEpoch,
      createdAt: manifest.createdAt,
      objects: manifest.objects,
      manifestDigestB64: manifest.manifestDigestB64,
    });
  }
  return JSON.stringify(manifest);
}

async function createRestoreManifest(input: {
  readonly organisationId: OrganisationId;
  readonly sourcePlacementEpoch: number;
  readonly createdAt: number;
  readonly objects: readonly ActorRestoreManifestObject[];
  readonly retiredActors: readonly RetiredActorRecord[];
}): Promise<Result<ActorRestoreManifest, ActorRestoreManifestError>> {
  const unsigned: ActorRestoreManifest = {
    format: RESTORE_MANIFEST_FORMAT,
    version: RESTORE_MANIFEST_VERSION,
    organisationId: input.organisationId,
    sourcePlacementEpoch: input.sourcePlacementEpoch,
    createdAt: input.createdAt,
    objects: input.objects,
    retiredActors: input.retiredActors,
    manifestDigestB64: "pending",
  };
  const manifestDigestB64 = await restoreManifestDigest(unsigned);

  return {
    ok: true,
    value: {
      format: RESTORE_MANIFEST_FORMAT,
      version: RESTORE_MANIFEST_VERSION,
      organisationId: input.organisationId,
      sourcePlacementEpoch: input.sourcePlacementEpoch,
      createdAt: input.createdAt,
      objects: input.objects,
      retiredActors: input.retiredActors,
      manifestDigestB64,
    },
  };
}

function manifestObjectFromEnvelope(
  envelope: ActorExportEnvelopeV1,
  exportRef: ActorExportRef,
): ActorRestoreManifestObject {
  return {
    identity: envelope.payload.source.identity,
    sourceSchemaVersion: envelope.payload.source.schemaVersion,
    sourceStateVersion: envelope.payload.source.stateVersion,
    exportRef,
    payloadDigestB64: envelope.payloadDigestB64,
    counts: exportCounts(envelope),
  };
}

function exportCounts(envelope: ActorExportEnvelopeV1): ActorRestoreCounts {
  let rowCount = 0;
  let r2Bytes = 0;

  for (const table of envelope.payload.tables) {
    rowCount += table.rows.length;
  }

  for (const object of envelope.payload.r2) {
    r2Bytes += object.size;
  }

  return {
    tableCount: envelope.payload.tables.length,
    rowCount,
    kvEntryCount: envelope.payload.kv.length,
    r2ObjectCount: envelope.payload.r2.length,
    r2Bytes,
  };
}

function exportMatchesRelocation(
  envelope: ActorExportEnvelopeV1,
  exported: {
    readonly identity: ActorIdentity;
    readonly sourceSchemaVersion: number;
    readonly sourceStateVersion: number;
  },
  sourcePlacementEpoch: number,
): boolean {
  return (
    sameIdentity(envelope.payload.source.identity, exported.identity) &&
    envelope.payload.source.schemaVersion === exported.sourceSchemaVersion &&
    envelope.payload.source.stateVersion === exported.sourceStateVersion &&
    envelope.payload.source.placementEpoch === sourcePlacementEpoch
  );
}

function envelopeMatchesManifestObject(
  envelope: ActorExportEnvelopeV1,
  object: ActorRestoreManifestObject,
  manifest: ActorRestoreManifest,
): boolean {
  return (
    sameIdentity(envelope.payload.source.identity, object.identity) &&
    envelope.payload.source.identity.organisationId ===
      manifest.organisationId &&
    envelope.payload.source.placementEpoch === manifest.sourcePlacementEpoch &&
    envelope.payload.source.schemaVersion === object.sourceSchemaVersion &&
    envelope.payload.source.stateVersion === object.sourceStateVersion &&
    envelope.payloadDigestB64 === object.payloadDigestB64 &&
    sameCounts(exportCounts(envelope), object.counts)
  );
}

function parseManifestObject(
  raw: unknown,
  organisationId: OrganisationId,
  index: number,
): Result<ActorRestoreManifestObject, ActorRestoreManifestError> {
  if (!isRecord(raw)) {
    return invalidManifest(`objects[${index}]`);
  }

  const identity = parseRestoreIdentity(raw.identity, organisationId, index);
  const exportRef = parseActorExportRef(raw.exportRef);
  const counts = parseRestoreCounts(raw.counts, index);

  if (!identity.ok) {
    return identity;
  }

  if (!exportRef.ok) {
    return invalidManifest(`objects[${index}].exportRef`);
  }

  if (!counts.ok) {
    return counts;
  }

  if (
    !isPositiveInteger(raw.sourceSchemaVersion) ||
    !isPositiveInteger(raw.sourceStateVersion) ||
    !isNonEmptyString(raw.payloadDigestB64) ||
    exportRef.value.organisationId !== organisationId ||
    exportRef.value.payloadDigestB64 !== raw.payloadDigestB64
  ) {
    return invalidManifest(`objects[${index}]`);
  }

  return {
    ok: true,
    value: {
      identity: identity.value,
      sourceSchemaVersion: raw.sourceSchemaVersion,
      sourceStateVersion: raw.sourceStateVersion,
      exportRef: exportRef.value,
      payloadDigestB64: raw.payloadDigestB64,
      counts: counts.value,
    },
  };
}

function parseRestoreIdentity(
  raw: unknown,
  organisationId: OrganisationId,
  index: number,
): Result<ActorIdentity, ActorRestoreManifestError> {
  if (!isRecord(raw) || raw.organisationId !== organisationId) {
    return invalidManifest(`objects[${index}].identity`);
  }

  switch (raw.objectKind) {
    case "organisation":
      return raw.logicalObjectId === organisationId
        ? {
            ok: true,
            value: {
              objectKind: raw.objectKind,
              organisationId,
              logicalObjectId: organisationId,
            },
          }
        : invalidManifest(`objects[${index}].identity.logicalObjectId`);
    case "session": {
      if (typeof raw.logicalObjectId !== "string") {
        return invalidManifest(`objects[${index}].identity.logicalObjectId`);
      }

      const logicalObjectId = parseSessionId(raw.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: raw.objectKind,
              organisationId,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : invalidManifest(`objects[${index}].identity.logicalObjectId`);
    }
    case "case": {
      if (typeof raw.logicalObjectId !== "string") {
        return invalidManifest(`objects[${index}].identity.logicalObjectId`);
      }
      const logicalObjectId = parseCaseId(raw.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: raw.objectKind,
              organisationId,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : invalidManifest(`objects[${index}].identity.logicalObjectId`);
    }
    case "connector": {
      if (typeof raw.logicalObjectId !== "string") {
        return invalidManifest(`objects[${index}].identity.logicalObjectId`);
      }
      const logicalObjectId = parseConnectorId(raw.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: raw.objectKind,
              organisationId,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : invalidManifest(`objects[${index}].identity.logicalObjectId`);
    }
    default:
      return invalidManifest(`objects[${index}].identity.objectKind`);
  }
}

function parseRestoreCounts(
  raw: unknown,
  index: number,
): Result<ActorRestoreCounts, ActorRestoreManifestError> {
  if (
    !isRecord(raw) ||
    !isNonNegativeInteger(raw.tableCount) ||
    !isNonNegativeInteger(raw.rowCount) ||
    !isNonNegativeInteger(raw.kvEntryCount) ||
    !isNonNegativeInteger(raw.r2ObjectCount) ||
    !isNonNegativeInteger(raw.r2Bytes)
  ) {
    return invalidManifest(`objects[${index}].counts`);
  }

  return {
    ok: true,
    value: {
      tableCount: raw.tableCount,
      rowCount: raw.rowCount,
      kvEntryCount: raw.kvEntryCount,
      r2ObjectCount: raw.r2ObjectCount,
      r2Bytes: raw.r2Bytes,
    },
  };
}

async function restoreManifestDigest(
  manifest: ActorRestoreManifest,
): Promise<string> {
  const objects: unknown[] = [];

  for (const object of manifest.objects) {
    objects.push(canonicalManifestObject(object));
  }

  const canonical = JSON.stringify(
    manifest.version === 1
      ? {
          format: RESTORE_MANIFEST_FORMAT,
          version: 1,
          organisationId: manifest.organisationId,
          sourcePlacementEpoch: manifest.sourcePlacementEpoch,
          createdAt: manifest.createdAt,
          objects,
        }
      : {
          format: RESTORE_MANIFEST_FORMAT,
          version: 2,
          organisationId: manifest.organisationId,
          sourcePlacementEpoch: manifest.sourcePlacementEpoch,
          createdAt: manifest.createdAt,
          objects,
          retiredActors: manifest.retiredActors.map(canonicalRetiredActor),
        },
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonical),
  );
  return encodeBase64(new Uint8Array(digest));
}

function canonicalRetiredActor(record: RetiredActorRecord): unknown {
  return {
    identity: canonicalIdentity(record.identity),
    lifecycleStatus: "retired",
    schemaVersion: record.schemaVersion,
    stateVersion: record.stateVersion,
    reservedAt: record.reservedAt,
    activatedAt: record.activatedAt,
    exportingAt: record.exportingAt,
    retiredAt: record.retiredAt,
  };
}

function parseRetiredActors(
  raw: Record<string, unknown>,
  organisationId: OrganisationId,
  objects: readonly ActorRestoreManifestObject[],
): Result<readonly RetiredActorRecord[], ActorRestoreManifestError> {
  if (raw.version === 1) {
    return raw.retiredActors === undefined
      ? { ok: true, value: [] }
      : invalidManifest("retiredActors");
  }
  if (!Array.isArray(raw.retiredActors))
    return invalidManifest("retiredActors");
  const records: RetiredActorRecord[] = [];
  const identities = new Set(objects.map(restoreObjectIdentityKey));
  for (const [index, entry] of raw.retiredActors.entries()) {
    if (
      !isRecord(entry) ||
      entry.lifecycleStatus !== "retired" ||
      !isPositiveInteger(entry.schemaVersion) ||
      !isNonNegativeInteger(entry.stateVersion) ||
      !timestamp(entry.reservedAt) ||
      !timestamp(entry.activatedAt) ||
      !timestamp(entry.exportingAt) ||
      !timestamp(entry.retiredAt)
    ) {
      return invalidManifest("retiredActors");
    }
    const identity = parseRestoreIdentity(
      entry.identity,
      organisationId,
      index,
    );
    if (!identity.ok) return identity;
    const key = `${identity.value.objectKind}\u0000${identity.value.logicalObjectId}`;
    if (identities.has(key)) return invalidManifest("retiredActors.identity");
    identities.add(key);
    records.push({
      identity: identity.value,
      lifecycleStatus: "retired",
      schemaVersion: entry.schemaVersion,
      stateVersion: entry.stateVersion,
      reservedAt: entry.reservedAt,
      activatedAt: entry.activatedAt,
      exportingAt: entry.exportingAt,
      retiredAt: entry.retiredAt,
    });
  }
  return { ok: true, value: records };
}

function restoreObjectIdentityKey(object: ActorRestoreManifestObject): string {
  return `${object.identity.objectKind}\u0000${object.identity.logicalObjectId}`;
}

function canonicalManifestObject(object: ActorRestoreManifestObject): unknown {
  return {
    identity: canonicalIdentity(object.identity),
    sourceSchemaVersion: object.sourceSchemaVersion,
    sourceStateVersion: object.sourceStateVersion,
    exportRef: {
      exportId: object.exportRef.exportId,
      organisationId: object.exportRef.organisationId,
      key: object.exportRef.key,
      payloadDigestB64: object.exportRef.payloadDigestB64,
      createdAt: object.exportRef.createdAt,
    },
    payloadDigestB64: object.payloadDigestB64,
    counts: {
      tableCount: object.counts.tableCount,
      rowCount: object.counts.rowCount,
      kvEntryCount: object.counts.kvEntryCount,
      r2ObjectCount: object.counts.r2ObjectCount,
      r2Bytes: object.counts.r2Bytes,
    },
  };
}

function canonicalIdentity(identity: ActorIdentity): unknown {
  return {
    objectKind: identity.objectKind,
    organisationId: identity.organisationId,
    logicalObjectId: identity.logicalObjectId,
  };
}

function compareManifestObjects(
  left: ActorRestoreManifestObject,
  right: ActorRestoreManifestObject,
): number {
  const leftKey = `${left.identity.objectKind}\u0000${left.identity.logicalObjectId}`;
  const rightKey = `${right.identity.objectKind}\u0000${right.identity.logicalObjectId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function uniqueManifestObjects(
  objects: readonly ActorRestoreManifestObject[],
): boolean {
  let previous = "";

  for (const object of objects) {
    const key = `${object.identity.objectKind}\u0000${object.identity.logicalObjectId}`;

    if (key === previous) {
      return false;
    }

    previous = key;
  }

  return true;
}

function sameIdentity(left: ActorIdentity, right: ActorIdentity): boolean {
  return (
    left.objectKind === right.objectKind &&
    left.organisationId === right.organisationId &&
    left.logicalObjectId === right.logicalObjectId
  );
}

function sameCounts(
  left: ActorRestoreCounts,
  right: ActorRestoreCounts,
): boolean {
  return (
    left.tableCount === right.tableCount &&
    left.rowCount === right.rowCount &&
    left.kvEntryCount === right.kvEntryCount &&
    left.r2ObjectCount === right.r2ObjectCount &&
    left.r2Bytes === right.r2Bytes
  );
}

function invalidManifest(
  field: string,
): Result<never, ActorRestoreManifestError> {
  return { ok: false, error: { code: "invalid_restore_manifest", field } };
}

function timestamp(value: unknown): value is number {
  return isNonNegativeInteger(value);
}
