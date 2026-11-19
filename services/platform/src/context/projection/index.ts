import { parseOrganisationId, type OrganisationId } from "../../ids";
import type { JsonObject } from "../../http";
import type { Result } from "../../result";
import type {
  CaseContent,
  UserMessage,
  FileContextProvider,
} from "@purin-labs/contracts";
import { FlowLabel, type SerializedFlowLabel } from "../../policy";
import {
  encodeContextVisibility,
  parseContextVisibility as parseStoredContextVisibility,
} from "../../authorization/access-grants/visibility";
import type { ContextVisibility } from "../../authorization/access-grants/types";
import { ACTIVE_FILE_GRANT_VISIBILITY_SQL } from "../files/authority-sql";
import { deriveUserMessageViews } from "../../messages/message-wasm";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  isNonBlankString,
  isRecord,
  isSha256Hex,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
  sha256Hex,
} from "@purin-labs/std";

export type { ContextVisibility } from "../../authorization/access-grants/types";

export const CONTEXT_PROJECTION_COMMAND_TYPE = "context.projection.v1" as const;
export const MAX_BOUNDED_CONTEXT_TEXT_CHARS = 4_096;

export type Timestamp = number;
export type ContextProjectionRevision = number;
export type Sha256Digest = string;

export type CaseContextReplayAuthority =
  | Readonly<{ readonly kind: "partition_independent" }>
  | Readonly<{
      readonly kind: "authority_partition";
      readonly authorityPartitionDigest: Sha256Digest;
    }>;

export type CaseContextSourceRef = {
  readonly kind: "case_entry";
  readonly caseId: string;
  readonly entryId: string;
};

export type FileSegmentContextSourceRef = {
  readonly kind: "file_segment";
  readonly integrationAccountId: string;
  readonly provider: FileContextProvider;
  readonly providerFileId: string;
  readonly segmentIndex: number;
};

export type CanonicalContextSourceRef =
  CaseContextSourceRef | FileSegmentContextSourceRef;

export type ContextRetrievalEvidence = {
  readonly exactPhraseMatch: boolean;
  readonly tokenOverlapMillionths: number;
  readonly recencyRank: number;
};

export type ContextProjectionProvenance =
  | Readonly<{ readonly kind: "case_entry" }>
  | Readonly<{
      readonly kind: "integration_file";
      readonly integrationAccountId: string;
      readonly provider: FileContextProvider;
      readonly resourceScope: string;
      readonly displayName: string;
      readonly displayPath: string;
      readonly deepLink: string;
      readonly mediaType: string;
      readonly metadataOnlyReason: string | null;
    }>;

/** Case projection messages name the canonical journal entry read from the Case actor. */
export type ContextProjectionCommand = {
  readonly type: typeof CONTEXT_PROJECTION_COMMAND_TYPE;
  readonly organisationId: OrganisationId;
  readonly source: CaseContextSourceRef;
  readonly sourceRevision: ContextProjectionRevision;
};

type ContextProjectionParseError =
  | { readonly code: "object_required" }
  | { readonly code: "invalid_field"; readonly field: string };

type ContextProjectionCommandError =
  | ContextProjectionParseError
  | { readonly code: "storage_failure"; readonly retryable: true };

export type CaseContextSource = {
  readonly organisationId: OrganisationId;
  readonly source: CaseContextSourceRef;
  readonly sourceRevision: ContextProjectionRevision;
  readonly replayAuthority: CaseContextReplayAuthority;
  /** The digest persisted with the accepted journal entry is canonical. */
  readonly contentDigest: Sha256Digest;
  readonly content: CaseContent;
  /** Visibility is derived from the accepted journal authority. */
  readonly visibility: ContextVisibility;
  readonly inputLabel: SerializedFlowLabel;
  readonly observedAt: Timestamp;
};

export type CaseContextSourceReaderError =
  { readonly code: "source_missing" } | { readonly code: "storage_failure" };

/** The projection never reads Case storage directly. */
export interface CaseContextSourceReader {
  read(
    input: Readonly<{
      readonly organisationId: OrganisationId;
      readonly source: CaseContextSourceRef;
      readonly sourceRevision: ContextProjectionRevision;
    }>,
  ): Promise<Result<CaseContextSource, CaseContextSourceReaderError>>;
}

type ReadyContextProjectionFields = {
  readonly kind: "ready";
  readonly organisationId: OrganisationId;
  readonly sourceRevision: ContextProjectionRevision;
  readonly contentDigest: Sha256Digest;
  readonly visibility: ContextVisibility;
  readonly inputLabel: SerializedFlowLabel;
  readonly indexedAt: Timestamp;
  readonly boundedText: string;
  /** The model-visible rendering; bounded_text remains the retrieval index. */
  readonly modelText: string;
  readonly provenance: ContextProjectionProvenance;
};

export type ReadyContextProjection =
  | Readonly<
      ReadyContextProjectionFields & {
        readonly source: CaseContextSourceRef;
        readonly replayAuthority: CaseContextReplayAuthority;
      }
    >
  | Readonly<
      ReadyContextProjectionFields & {
        readonly source: FileSegmentContextSourceRef;
      }
    >;

export type ContextProjectionSearchRequest =
  | Readonly<{
      readonly organisationId: OrganisationId;
      readonly visibility: readonly ContextVisibility[];
      readonly sourceKind: "all";
      readonly authorityPartitionDigest: Sha256Digest;
      readonly query: string;
      readonly limit: number;
    }>
  | Readonly<{
      readonly organisationId: OrganisationId;
      readonly visibility: readonly ContextVisibility[];
      readonly sourceKind: "file_segment";
      readonly query: string;
      readonly limit: number;
    }>;

export type ContextProjectionSearchResult = {
  readonly projection: ReadyContextProjection;
  readonly retrievalEvidence: ContextRetrievalEvidence;
};

/** The assembler receives only this read-side boundary. */
export interface ContextProjectionReader {
  readReady(
    input: Readonly<{
      readonly organisationId: OrganisationId;
      readonly source: CanonicalContextSourceRef;
      readonly sourceRevision: ContextProjectionRevision;
    }>,
  ): Promise<ReadyContextProjection | null>;
  search(
    input: ContextProjectionSearchRequest,
  ): Promise<readonly ContextProjectionSearchResult[]>;
}

export type ContextProjectionSkipReason =
  "source_missing" | "source_digest_mismatch" | "unsupported_content";

export type ContextProjectionApplyResult =
  | { readonly kind: "applied"; readonly projection: ReadyContextProjection }
  | { readonly kind: "duplicate"; readonly projection: ReadyContextProjection }
  | { readonly kind: "stale"; readonly projection: ReadyContextProjection }
  | { readonly kind: "skipped"; readonly reason: ContextProjectionSkipReason };

type ContextProjectionRow = {
  readonly organisation_id: unknown;
  readonly source_kind: unknown;
  readonly source_key: unknown;
  readonly source_json: unknown;
  readonly source_revision: unknown;
  readonly content_digest: unknown;
  readonly visibility_json: unknown;
  readonly visibility_key: unknown;
  readonly flow_label_json: unknown;
  readonly indexed_at: unknown;
  readonly bounded_text: unknown;
  readonly model_text: unknown;
  readonly provenance_json: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
};

/**
 * A row of a search. Many rows store the same label, so the read returns
 * each distinct label text one time: the row whose `projection_rowid` equals
 * its `flow_label_carrier` holds the text for every row with that carrier.
 */
type ContextProjectionSearchRow = ContextProjectionRow & {
  readonly projection_rowid: unknown;
  readonly flow_label_carrier: unknown;
};

type ParsedProjectionRowFields = {
  readonly organisationId: string;
  readonly sourceRevision: number;
  readonly contentDigest: string;
  readonly visibility: ContextVisibility;
  readonly visibilityKey: string;
  readonly inputLabel: SerializedFlowLabel;
  readonly indexedAt: number;
  readonly boundedText: string;
  readonly modelText: string;
  readonly provenance: ContextProjectionProvenance;
};

type ParsedProjectionRow =
  | Readonly<
      ParsedProjectionRowFields & {
        readonly source: CaseContextSourceRef;
        readonly replayAuthority: CaseContextReplayAuthority;
      }
    >
  | Readonly<
      ParsedProjectionRowFields & {
        readonly source: FileSegmentContextSourceRef;
      }
    >;

type ProjectionWrite = {
  readonly organisationId: OrganisationId;
  readonly source: CaseContextSourceRef;
  readonly sourceRevision: ContextProjectionRevision;
  readonly replayAuthority: CaseContextReplayAuthority;
  readonly contentDigest: Sha256Digest;
  readonly visibility: ContextVisibility;
  readonly inputLabel: SerializedFlowLabel;
  readonly indexedAt: Timestamp;
  readonly boundedText: string;
  readonly modelText: string;
  readonly now: Timestamp;
};

type ContextProjectionStatement = {
  bind(...values: readonly unknown[]): ContextProjectionStatement;
  run(): Promise<unknown>;
  first<TResult>(): Promise<TResult | null>;
  all<TResult>(): Promise<{ readonly results: readonly TResult[] }>;
};

type ContextProjectionDatabase = {
  prepare(query: string): ContextProjectionStatement;
};

export function createContextProjectionCommand(input: {
  readonly organisationId: OrganisationId;
  readonly source: CaseContextSourceRef;
  readonly sourceRevision: ContextProjectionRevision;
}): ContextProjectionCommand {
  return { type: CONTEXT_PROJECTION_COMMAND_TYPE, ...input };
}

export function parseContextProjectionCommand(
  raw: unknown,
): Result<ContextProjectionCommand, ContextProjectionParseError> {
  if (!isRecord(raw)) return { ok: false, error: { code: "object_required" } };
  const unknownField = firstUnknownCommandField(raw);
  if (unknownField !== null) return invalidField(unknownField);
  if (raw.type !== CONTEXT_PROJECTION_COMMAND_TYPE) return invalidField("type");

  const organisationId = readIdentifier(raw, "organisationId");
  if (!organisationId.ok) return organisationId;
  const parsedOrganisationId = parseOrganisationId(organisationId.value);
  if (!parsedOrganisationId.ok) return invalidField("organisationId");
  const source = parseSourceRef(raw.source);
  if (!source.ok) return source;
  if (source.value.kind !== "case_entry") return invalidField("source.kind");
  const sourceRevision = readPositiveInteger(raw, "sourceRevision");
  if (!sourceRevision.ok) return sourceRevision;

  return {
    ok: true,
    value: {
      type: CONTEXT_PROJECTION_COMMAND_TYPE,
      organisationId: parsedOrganisationId.value,
      source: source.value,
      sourceRevision: sourceRevision.value,
    },
  };
}

export async function handleContextProjectionQueueMessage(
  input: Readonly<{
    readonly db: ContextProjectionDatabase;
    readonly sourceReader: CaseContextSourceReader;
    readonly message: unknown;
    readonly now: Timestamp;
  }>,
): Promise<
  Result<ContextProjectionApplyResult, ContextProjectionCommandError>
> {
  const parsed = parseContextProjectionCommand(input.message);
  if (!parsed.ok) return parsed;
  return applyContextProjectionCommand({
    db: input.db,
    sourceReader: input.sourceReader,
    command: parsed.value,
    now: input.now,
  });
}

export async function applyContextProjectionCommand(
  input: Readonly<{
    readonly db: ContextProjectionDatabase;
    readonly sourceReader: CaseContextSourceReader;
    readonly command: ContextProjectionCommand;
    readonly now: Timestamp;
  }>,
): Promise<
  Result<ContextProjectionApplyResult, ContextProjectionCommandError>
> {
  try {
    const existing = await readProjectionRow(
      input.db,
      input.command.organisationId,
      input.command.source,
    );
    if (existing !== null) {
      return existing.sourceRevision === input.command.sourceRevision
        ? {
            ok: true,
            value: {
              kind: "duplicate",
              projection: projectionFromParsedRow(
                input.command.organisationId,
                existing,
              ),
            },
          }
        : existing.sourceRevision > input.command.sourceRevision
          ? {
              ok: true,
              value: {
                kind: "stale",
                projection: projectionFromParsedRow(
                  input.command.organisationId,
                  existing,
                ),
              },
            }
          : await materializeNewerProjection(input);
    }
    return await materializeNewerProjection(input);
  } catch {
    return retryableStorageFailure();
  }
}

export function createContextProjectionReader(
  db: ContextProjectionDatabase,
): ContextProjectionReader {
  return {
    readReady: readReadyProjection.bind(null, db),
    search: searchContextProjections.bind(null, db),
  };
}

async function readContextProjection(
  db: ContextProjectionDatabase,
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly source: CanonicalContextSourceRef;
    readonly sourceRevision: ContextProjectionRevision;
  }>,
): Promise<ReadyContextProjection | null> {
  const row = await readProjectionRow(db, input.organisationId, input.source);
  if (row === null || row.sourceRevision !== input.sourceRevision) return null;
  return projectionFromParsedRow(input.organisationId, row);
}

export async function searchContextProjections(
  db: ContextProjectionDatabase,
  input: ContextProjectionSearchRequest,
): Promise<readonly ContextProjectionSearchResult[]> {
  const visibilityKeys = uniqueStrings(input.visibility.map(visibilityKey));
  if (visibilityKeys.length === 0 || input.limit <= 0) return [];

  const normalizedQuery = normalizeBoundedText(input.query);
  const placeholders = visibilityKeys.map(createPlaceholder).join(", ");
  const candidateLimit = Math.min(160, Math.max(input.limit, input.limit * 8));
  const expression = fileSearchExpression(normalizedQuery);
  const bindings: unknown[] = [input.organisationId, ...visibilityKeys];
  if (input.sourceKind === "all") bindings.push(input.authorityPartitionDigest);
  if (expression !== null) bindings.push(expression);
  bindings.push(candidateLimit);
  const result = await db
    .prepare(
      projectionSearchSql(placeholders, expression !== null, input.sourceKind),
    )
    .bind(...bindings)
    .all<ContextProjectionSearchRow>();
  const allowedVisibilityKeys = new Set(visibilityKeys);
  const labelTexts = new Map<number, unknown>();
  for (const row of result.results) {
    const carrier = row.flow_label_carrier;
    if (typeof carrier === "number" && row.projection_rowid === carrier)
      labelTexts.set(carrier, row.flow_label_json);
  }
  // Rows with one carrier store the same label text, so it restores one time.
  // A row that names no carrier of this read has no label and is left out.
  const labels = new Map<unknown, Promise<StoredLabel>>();
  const rows: ContextProjectionSearchResult[] = [];
  for (const row of result.results) {
    const carrier = row.flow_label_carrier;
    let label = labels.get(carrier);
    if (label === undefined) {
      label = restoreStoredLabel(
        typeof carrier === "number" ? labelTexts.get(carrier) : null,
      );
      labels.set(carrier, label);
    }
    const parsed = await parseProjectionRow(row, label);
    if (
      !parsed.ok ||
      parsed.value.organisationId !== input.organisationId ||
      !allowedVisibilityKeys.has(parsed.value.visibilityKey)
    )
      continue;
    const projection = projectionFromParsedRow(
      input.organisationId,
      parsed.value,
    );
    rows.push({
      projection,
      retrievalEvidence: retrievalEvidenceFor(projection, normalizedQuery),
    });
  }
  rows.sort(compareSearchResults);
  return rows.slice(0, input.limit);
}

function projectionSearchSql(
  visibilityPlaceholders: string,
  usesFts: boolean,
  sourceKind: ContextProjectionSearchRequest["sourceKind"],
): string {
  const ftsJoin = usesFts
    ? "JOIN context_projection_fts ON context_projection_fts.rowid = projection.rowid"
    : "";
  const ftsPredicate = usesFts ? "AND context_projection_fts MATCH ?" : "";
  const sourcePredicate =
    sourceKind === "file_segment"
      ? "AND projection.source_kind = 'file_segment'"
      : `AND (
         projection.source_kind = 'file_segment' OR (
           projection.source_kind = 'case_entry'
           AND json_valid(projection.provenance_json)
           AND CASE WHEN json_valid(projection.provenance_json)
                    THEN json_extract(projection.provenance_json, '$.kind')
               END = 'case_entry'
           AND (
             CASE WHEN json_valid(projection.provenance_json)
                  THEN json_extract(projection.provenance_json, '$.replayAuthority.kind')
              END = 'partition_independent'
             OR (
               CASE WHEN json_valid(projection.provenance_json)
                    THEN json_extract(projection.provenance_json, '$.replayAuthority.kind')
                END = 'authority_partition'
               AND CASE WHEN json_valid(projection.provenance_json)
                        THEN json_extract(
                          projection.provenance_json,
                          '$.replayAuthority.authorityPartitionDigest'
                        )
                    END = ?
             )
           )
         )
       )`;
  // The candidates of a search mostly store the same few labels, and a label
  // is far larger than the rest of its row. The outer read keeps the label
  // text on one row of each group of equal texts and names that row on the
  // others.
  return `WITH candidate AS (
          SELECT projection.rowid AS projection_rowid,
                 projection.organisation_id, projection.source_kind, projection.source_key,
                 projection.source_json, projection.source_revision, projection.content_digest,
                 projection.visibility_json, projection.visibility_key, projection.flow_label_json,
                 projection.indexed_at, projection.bounded_text, projection.model_text, projection.provenance_json,
                 projection.created_at, projection.updated_at
            FROM context_projection AS projection
            ${ftsJoin}
           WHERE projection.organisation_id = ? AND projection.lifecycle = 'ready'
             AND projection.visibility_key IN (${visibilityPlaceholders})
             ${sourcePredicate}
             AND (
               projection.source_kind = 'case_entry' OR EXISTS (
                 SELECT 1
                   FROM access_grant AS grant_record
                   JOIN file_grant_admission AS admission
                     ON admission.organisation_id = grant_record.organisation_id
                    AND admission.grant_id = grant_record.grant_id
                    AND admission.grant_revision = grant_record.revision
                   JOIN integration_account AS account
                     ON account.organisation_id = admission.organisation_id
                    AND account.integration_account_id = admission.integration_account_id
                  WHERE projection.source_kind = 'file_segment'
                    AND grant_record.organisation_id = projection.organisation_id
                    AND grant_record.lifecycle = 'active'
                    AND admission.integration_account_id = json_extract(
                      projection.source_json, '$.integrationAccountId'
                    )
                    AND admission.provider = json_extract(projection.source_json, '$.provider')
                    AND admission.provider_file_id = projection.provider_file_id
                    AND ${ACTIVE_FILE_GRANT_VISIBILITY_SQL} = projection.visibility_key
                    AND account.lifecycle = 'active'
               )
             )
             ${ftsPredicate}
           ORDER BY projection.indexed_at DESC, projection.source_kind, projection.source_key
           LIMIT ?
          )
          SELECT organisation_id, source_kind, source_key, source_json, source_revision,
                 content_digest, visibility_json, visibility_key, indexed_at, bounded_text,
                 model_text, provenance_json, created_at, updated_at, projection_rowid,
                 MIN(projection_rowid) OVER same_label AS flow_label_carrier,
                 CASE WHEN projection_rowid = MIN(projection_rowid) OVER same_label
                      THEN flow_label_json END AS flow_label_json
            FROM candidate
          WINDOW same_label AS (PARTITION BY flow_label_json)
           ORDER BY indexed_at DESC, source_kind, source_key`;
}

function fileSearchExpression(normalizedQuery: string): string | null {
  const tokens = uniqueStrings(tokenize(normalizedQuery)).slice(0, 32);
  return tokens.length === 0 ? null : tokens.map(quoteFtsToken).join(" OR ");
}

function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

async function materializeNewerProjection(
  input: Readonly<{
    readonly db: ContextProjectionDatabase;
    readonly sourceReader: CaseContextSourceReader;
    readonly command: ContextProjectionCommand;
    readonly now: Timestamp;
  }>,
): Promise<
  Result<ContextProjectionApplyResult, ContextProjectionCommandError>
> {
  const source = await input.sourceReader.read({
    organisationId: input.command.organisationId,
    source: input.command.source,
    sourceRevision: input.command.sourceRevision,
  });
  if (!source.ok) {
    return retryableStorageFailure();
  }
  const validation = await validateSourceForProjection(
    input.command,
    source.value,
  );
  if (validation.kind === "skipped") {
    return { ok: true, value: validation };
  }
  const projection = await persistProjection(input.db, {
    organisationId: input.command.organisationId,
    source: input.command.source,
    sourceRevision: input.command.sourceRevision,
    replayAuthority: source.value.replayAuthority,
    contentDigest: source.value.contentDigest,
    visibility: source.value.visibility,
    inputLabel: source.value.inputLabel,
    indexedAt: source.value.observedAt,
    boundedText: validation.boundedText,
    modelText: validation.modelText,
    now: input.now,
  });
  return projection.sourceRevision === input.command.sourceRevision
    ? { ok: true, value: { kind: "applied", projection } }
    : { ok: true, value: { kind: "stale", projection } };
}

async function validateSourceForProjection(
  command: ContextProjectionCommand,
  source: CaseContextSource,
): Promise<
  | {
      readonly kind: "ready";
      readonly boundedText: string;
      readonly modelText: string;
    }
  | { readonly kind: "skipped"; readonly reason: ContextProjectionSkipReason }
> {
  if (
    source.organisationId !== command.organisationId ||
    source.source.kind !== "case_entry" ||
    source.source.caseId !== command.source.caseId ||
    source.source.entryId !== command.source.entryId ||
    source.sourceRevision !== command.sourceRevision
  ) {
    return { kind: "skipped", reason: "source_missing" };
  }
  if (source.contentDigest.length === 0) {
    return { kind: "skipped", reason: "source_digest_mismatch" };
  }
  if (
    source.contentDigest !== (await sha256Hex(JSON.stringify(source.content)))
  ) {
    return { kind: "skipped", reason: "source_digest_mismatch" };
  }
  const boundedText = boundedTextForContent(source.content);
  return boundedText === null
    ? { kind: "skipped", reason: "unsupported_content" }
    : {
        kind: "ready",
        boundedText,
        modelText: modelTextForContent(source.content) ?? boundedText,
      };
}

async function persistProjection(
  db: ContextProjectionDatabase,
  write: ProjectionWrite,
): Promise<ReadyContextProjection> {
  await db
    .prepare(
      `INSERT INTO context_projection (
       organisation_id, source_kind, source_key, source_json, source_revision,
       source_revision_json, lifecycle, content_digest,
       visibility_json, visibility_key, flow_label_json, indexed_at, bounded_text, model_text,
       provenance_json, created_at, updated_at
     ) VALUES (?, 'case_entry', ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (organisation_id, source_kind, source_key, visibility_key) DO UPDATE SET
       source_json = excluded.source_json,
       source_revision = excluded.source_revision,
       source_revision_json = excluded.source_revision_json,
       lifecycle = 'ready',
       content_digest = excluded.content_digest,
       visibility_json = excluded.visibility_json,
       visibility_key = excluded.visibility_key,
       flow_label_json = excluded.flow_label_json,
       indexed_at = excluded.indexed_at,
       bounded_text = excluded.bounded_text,
       model_text = excluded.model_text,
       provenance_json = excluded.provenance_json,
       updated_at = excluded.updated_at
     WHERE excluded.source_revision >= context_projection.source_revision`,
    )
    .bind(
      write.organisationId,
      sourceIdentityKey(write.source),
      JSON.stringify(write.source),
      write.sourceRevision,
      JSON.stringify({ kind: "case_entry", sequence: write.sourceRevision }),
      write.contentDigest,
      JSON.stringify(write.visibility),
      visibilityKey(write.visibility),
      JSON.stringify(write.inputLabel),
      write.indexedAt,
      write.boundedText,
      write.modelText,
      JSON.stringify(caseProjectionProvenance(write.replayAuthority)),
      write.now,
      write.now,
    )
    .run();
  const row = await readProjectionRow(db, write.organisationId, write.source);
  if (row === null) throw new Error("context_projection_insert_not_visible");
  return projectionFromParsedRow(write.organisationId, row);
}

function caseProjectionProvenance(
  replayAuthority: CaseContextReplayAuthority,
): Readonly<{
  readonly kind: "case_entry";
  readonly replayAuthority: CaseContextReplayAuthority;
}> {
  return { kind: "case_entry", replayAuthority };
}

async function readReadyProjection(
  db: ContextProjectionDatabase,
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly source: CanonicalContextSourceRef;
    readonly sourceRevision: ContextProjectionRevision;
  }>,
): Promise<ReadyContextProjection | null> {
  return readContextProjection(db, input);
}

async function readProjectionRow(
  db: ContextProjectionDatabase,
  organisationId: OrganisationId,
  source: CanonicalContextSourceRef,
): Promise<ParsedProjectionRow | null> {
  const row = await db
    .prepare(
      `SELECT organisation_id, source_kind, source_key, source_json, source_revision, content_digest,
            visibility_json, visibility_key, flow_label_json, indexed_at, bounded_text, model_text, provenance_json,
            created_at, updated_at
       FROM context_projection
      WHERE organisation_id = ? AND source_kind = ? AND source_key = ?
        AND lifecycle = 'ready'
      ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(organisationId, source.kind, sourceIdentityKey(source))
    .first<ContextProjectionRow>();
  if (row === null) return null;
  const parsed = await parseProjectionRow(row);
  if (!parsed.ok) {
    if (
      source.kind === "case_entry" &&
      parseCaseProjectionProvenance(row.provenance_json) === null
    ) {
      return null;
    }
    throw new Error("context_projection_row_invalid");
  }
  return parsed.value;
}

function projectionFromParsedRow(
  organisationId: OrganisationId,
  row: ParsedProjectionRow,
): ReadyContextProjection {
  if (isCaseParsedProjectionRow(row)) {
    return {
      kind: "ready",
      organisationId,
      source: row.source,
      replayAuthority: row.replayAuthority,
      sourceRevision: row.sourceRevision,
      contentDigest: row.contentDigest,
      visibility: row.visibility,
      inputLabel: row.inputLabel,
      indexedAt: row.indexedAt,
      boundedText: row.boundedText,
      modelText: row.modelText,
      provenance: row.provenance,
    };
  }
  return {
    kind: "ready",
    organisationId,
    source: row.source,
    sourceRevision: row.sourceRevision,
    contentDigest: row.contentDigest,
    visibility: row.visibility,
    inputLabel: row.inputLabel,
    indexedAt: row.indexedAt,
    boundedText: row.boundedText,
    modelText: row.modelText,
    provenance: row.provenance,
  };
}

function isCaseParsedProjectionRow(
  row: ParsedProjectionRow,
): row is VariantBy<ParsedProjectionRow, "source", CaseContextSourceRef> {
  return row.source.kind === "case_entry";
}

/** The label that a row stores, restored from its JSON text. */
type StoredLabel =
  | { readonly kind: "restored"; readonly label: SerializedFlowLabel }
  | { readonly kind: "absent" | "malformed" | "refused" };

async function restoreStoredLabel(raw: unknown): Promise<StoredLabel> {
  const text = readRowString(raw);
  if (text === null) return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  const restored = await FlowLabel.restore(value);
  return restored.ok
    ? { kind: "restored", label: restored.value.toJSON() }
    : { kind: "refused" };
}

/**
 * Parse one stored row. A search gives the restored label of the row's
 * carrier. Every other read restores the label that the row holds.
 */
async function parseProjectionRow(
  row: ContextProjectionRow,
  storedLabel: Promise<StoredLabel> = restoreStoredLabel(row.flow_label_json),
): Promise<Result<ParsedProjectionRow, ContextProjectionParseError>> {
  const organisationId = readRowIdentifier(row.organisation_id);
  const sourceKind = readRowString(row.source_kind);
  const sourceKey = readRowString(row.source_key);
  const sourceJson = readRowString(row.source_json);
  const sourceRevision = positiveIntegerOrNull(row.source_revision);
  const contentDigest = readRowString(row.content_digest);
  const visibilityJson = readRowString(row.visibility_json);
  const rowVisibilityKey = readRowString(row.visibility_key);
  const inputLabel = await storedLabel;
  const indexedAt = nonNegativeIntegerOrNull(row.indexed_at);
  const boundedText = readRowString(row.bounded_text);
  if (
    organisationId === null ||
    (sourceKind !== "case_entry" && sourceKind !== "file_segment") ||
    sourceKey === null ||
    sourceJson === null ||
    sourceRevision === null ||
    contentDigest === null ||
    visibilityJson === null ||
    rowVisibilityKey === null ||
    inputLabel.kind === "absent" ||
    indexedAt === null ||
    boundedText === null
  ) {
    return invalidField("projection_row");
  }
  // Rows written before the model rendering existed fall back to the retrieval
  // text rather than losing the entry.
  const modelText = readRowString(row.model_text) ?? boundedText;
  let rawVisibility: unknown;
  let rawSource: unknown;
  try {
    rawVisibility = JSON.parse(visibilityJson);
    rawSource = JSON.parse(sourceJson);
  } catch {
    return invalidField("visibility_json");
  }
  if (inputLabel.kind === "malformed") return invalidField("visibility_json");
  const visibility = parseContextVisibility(rawVisibility);
  const source = parseSourceRef(rawSource);
  if (
    !visibility.ok ||
    inputLabel.kind !== "restored" ||
    !source.ok ||
    visibilityKey(visibility.value) !== rowVisibilityKey
  ) {
    return invalidField("visibility");
  }
  if (
    source.value.kind !== sourceKind ||
    sourceIdentityKey(source.value) !== sourceKey
  ) {
    return invalidField("source_key");
  }
  const provenance = parseProjectionProvenance(
    source.value,
    row.provenance_json,
  );
  if (provenance === null) return invalidField("provenance_json");
  if (source.value.kind === "case_entry") {
    const replayAuthority = parseCaseProjectionProvenance(row.provenance_json);
    if (replayAuthority === null) return invalidField("provenance_json");
    return {
      ok: true,
      value: {
        organisationId,
        source: source.value,
        replayAuthority,
        sourceRevision,
        contentDigest,
        visibility: visibility.value,
        visibilityKey: rowVisibilityKey,
        inputLabel: inputLabel.label,
        indexedAt,
        boundedText,
        modelText,
        provenance,
      },
    };
  }
  return {
    ok: true,
    value: {
      organisationId,
      source: source.value,
      sourceRevision,
      contentDigest,
      visibility: visibility.value,
      visibilityKey: rowVisibilityKey,
      inputLabel: inputLabel.label,
      indexedAt,
      boundedText,
      modelText,
      provenance,
    },
  };
}

function parseProjectionProvenance(
  source: CanonicalContextSourceRef,
  raw: unknown,
): ContextProjectionProvenance | null {
  if (source.kind === "case_entry") {
    return parseCaseProjectionProvenance(raw) === null
      ? null
      : { kind: "case_entry" };
  }
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.provider !== source.provider ||
    value.integrationAccountId !== source.integrationAccountId ||
    !isNonBlankString(value.resourceScope) ||
    !isBoundedString(value.displayName, 512) ||
    !isBoundedString(value.displayPath, 2_048) ||
    !isTrustedProviderDeepLink(source.provider, value.deepLink) ||
    !isBoundedString(value.mediaType, 256) ||
    (value.metadataOnlyReason !== null &&
      !isBoundedString(value.metadataOnlyReason, 256))
  ) {
    return null;
  }
  return {
    kind: "integration_file",
    integrationAccountId: source.integrationAccountId,
    provider: source.provider,
    resourceScope: value.resourceScope,
    displayName: value.displayName,
    displayPath: value.displayPath,
    deepLink: value.deepLink,
    mediaType: value.mediaType,
    metadataOnlyReason: value.metadataOnlyReason,
  };
}

function parseCaseProjectionProvenance(
  raw: unknown,
): CaseContextReplayAuthority | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.kind !== "case_entry" ||
    !isRecord(value.replayAuthority)
  ) {
    return null;
  }
  if (
    value.replayAuthority.kind === "partition_independent" &&
    Object.keys(value.replayAuthority).length === 1
  ) {
    return { kind: "partition_independent" };
  }
  return value.replayAuthority.kind === "authority_partition" &&
    Object.keys(value.replayAuthority).length === 2 &&
    isSha256Hex(value.replayAuthority.authorityPartitionDigest)
    ? {
        kind: "authority_partition",
        authorityPartitionDigest:
          value.replayAuthority.authorityPartitionDigest,
      }
    : null;
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function isTrustedProviderDeepLink(
  provider: FileContextProvider,
  value: unknown,
): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return provider === "dropbox"
      ? url.hostname === "www.dropbox.com" || url.hostname === "dropbox.com"
      : url.hostname === "drive.google.com" ||
          url.hostname === "docs.google.com";
  } catch {
    return false;
  }
}

/**
 * The model-visible rendering of a Case entry.
 *
 * Retrieval indexes authored text only; the model needs the whole message, or
 * a file mentioned in an earlier turn silently disappears from history.
 */
function modelTextForContent(content: CaseContent): string | null {
  if (content.kind !== "user_message" && content.kind !== "record_message") {
    return boundedTextForContent(content);
  }

  // The same Rust renderer the turn prompt uses, so a replayed entry and a
  // live one describe the message identically.
  const derived = deriveUserMessageViews(content.message);

  if (!derived.ok) {
    return boundedTextForContent(content);
  }

  const normalized = normalizeBoundedText(derived.value.views.modelPrompt);

  return normalized.length === 0 ? null : normalized;
}

function boundedTextForContent(content: CaseContent): string | null {
  const raw = sourceText(content);
  if (raw === null) return null;
  const normalized = normalizeBoundedText(raw);
  return normalized.length === 0 ? null : normalized;
}

function sourceText(content: CaseContent): string | null {
  switch (content.kind) {
    case "record_message":
    case "user_message":
      // Authored text only. Links and attachment manifests are provenance, not
      // prose, and indexing them would let a filename dominate retrieval.
      return userMessageAuthoredText(content.message);
    case "text":
      return content.text;
    case "artifact":
      return content.preview;
    case "commerce_reference":
    case "entity_plane_proposal":
      return null;
  }
}

function userMessageAuthoredText(message: UserMessage): string | null {
  const parts = [message.firstPart, ...message.remainingParts];
  const authored: string[] = [];

  for (const part of parts) {
    if (part.kind === "text") {
      authored.push(part.text);
    } else if (
      part.kind === "link" &&
      part.link.presentation.kind === "label"
    ) {
      authored.push(part.link.presentation.label);
    }
  }

  return authored.length === 0 ? null : authored.join(" ");
}

function normalizeBoundedText(value: string): string {
  const normalized = value
    .slice(0, MAX_BOUNDED_CONTEXT_TEXT_CHARS * 4)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized)
    .slice(0, MAX_BOUNDED_CONTEXT_TEXT_CHARS)
    .join("");
}

function retrievalEvidenceFor(
  projection: ReadyContextProjection,
  normalizedQuery: string,
): ContextProjectionSearchResult["retrievalEvidence"] {
  const exactPhraseMatch =
    normalizedQuery.length > 0 &&
    projection.boundedText.includes(normalizedQuery);
  const queryTokens = uniqueStrings(tokenize(normalizedQuery));
  const textTokens = new Set(tokenize(projection.boundedText));
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  const tokenOverlapMillionths =
    queryTokens.length === 0
      ? 0
      : Math.floor((overlap * 1_000_000) / queryTokens.length);
  return {
    exactPhraseMatch,
    tokenOverlapMillionths,
    recencyRank: projection.indexedAt,
  };
}

function compareSearchResults(
  left: ContextProjectionSearchResult,
  right: ContextProjectionSearchResult,
): number {
  if (
    left.retrievalEvidence.exactPhraseMatch !==
    right.retrievalEvidence.exactPhraseMatch
  ) {
    return left.retrievalEvidence.exactPhraseMatch ? -1 : 1;
  }
  if (
    left.retrievalEvidence.tokenOverlapMillionths !==
    right.retrievalEvidence.tokenOverlapMillionths
  ) {
    return (
      right.retrievalEvidence.tokenOverlapMillionths -
      left.retrievalEvidence.tokenOverlapMillionths
    );
  }
  if (
    left.retrievalEvidence.recencyRank !== right.retrievalEvidence.recencyRank
  ) {
    return (
      right.retrievalEvidence.recencyRank - left.retrievalEvidence.recencyRank
    );
  }
  return sourceSortKey(left.projection).localeCompare(
    sourceSortKey(right.projection),
  );
}

function sourceSortKey(projection: ReadyContextProjection): string {
  return `${sourceIdentityKey(projection.source)}\u0000${projection.sourceRevision}`;
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(nonEmptyString);
}

function nonEmptyString(value: string): boolean {
  return value.length > 0;
}

function visibilityKey(visibility: ContextVisibility): string {
  return encodeContextVisibility(visibility);
}

function sourceIdentityKey(source: CanonicalContextSourceRef): string {
  switch (source.kind) {
    case "case_entry":
      return `${source.caseId}\u0000${source.entryId}`;
    case "file_segment":
      return `${source.integrationAccountId}\u0000${source.provider}\u0000${source.providerFileId}\u0000${source.segmentIndex}`;
  }
}

function parseSourceRef(
  raw: unknown,
): Result<CanonicalContextSourceRef, ContextProjectionParseError> {
  if (!isRecord(raw)) return invalidField("source");
  switch (raw.kind) {
    case "case_entry": {
      const caseId = readIdentifier(raw, "caseId");
      if (!caseId.ok) return invalidField("source.caseId");
      const entryId = readIdentifier(raw, "entryId");
      if (!entryId.ok) return invalidField("source.entryId");
      return {
        ok: true,
        value: {
          kind: "case_entry",
          caseId: caseId.value,
          entryId: entryId.value,
        },
      };
    }
    case "file_segment": {
      const integrationAccountId = readIdentifier(raw, "integrationAccountId");
      if (!integrationAccountId.ok)
        return invalidField("source.integrationAccountId");
      const providerFileId = readIdentifier(raw, "providerFileId");
      if (!providerFileId.ok) return invalidField("source.providerFileId");
      if (raw.provider !== "dropbox" && raw.provider !== "google_drive") {
        return invalidField("source.provider");
      }
      if (
        typeof raw.segmentIndex !== "number" ||
        !Number.isSafeInteger(raw.segmentIndex) ||
        raw.segmentIndex < 0
      ) {
        return invalidField("source.segmentIndex");
      }
      return {
        ok: true,
        value: {
          kind: "file_segment",
          integrationAccountId: integrationAccountId.value,
          provider: raw.provider,
          providerFileId: providerFileId.value,
          segmentIndex: raw.segmentIndex,
        },
      };
    }
    default:
      return invalidField("source.kind");
  }
}

function parseContextVisibility(
  raw: unknown,
): Result<ContextVisibility, ContextProjectionParseError> {
  const parsed = parseStoredContextVisibility(raw);
  return parsed.ok ? parsed : invalidField(`visibility.${parsed.error.field}`);
}

function readIdentifier(
  raw: JsonObject,
  field: string,
): Result<string, ContextProjectionParseError> {
  const value = raw[field];
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u.test(value)
    ? { ok: true, value }
    : invalidField(field);
}

function readPositiveInteger(
  raw: JsonObject,
  field: string,
): Result<number, ContextProjectionParseError> {
  const value = raw[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : invalidField(field);
}

function readRowIdentifier(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readRowString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

function invalidField(field: string): {
  ok: false;
  error: { code: "invalid_field"; field: string };
} {
  return { ok: false, error: { code: "invalid_field", field } };
}

function retryableStorageFailure(): {
  ok: false;
  error: { code: "storage_failure"; retryable: true };
} {
  return { ok: false, error: { code: "storage_failure", retryable: true } };
}

function firstUnknownCommandField(raw: JsonObject): string | null {
  const allowed = new Set([
    "type",
    "organisationId",
    "source",
    "sourceRevision",
  ]);
  return Object.keys(raw).find((field) => !allowed.has(field)) ?? null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function createPlaceholder(_value: string, index: number): string {
  return `?${index + 2}`;
}
