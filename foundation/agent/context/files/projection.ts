import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { ProviderFileRevision } from "@purin-labs/contracts";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { fileProjectionFence } from "./authority-sql";

import { encodeContextVisibility } from "@purin-labs/authority/authorization/access-grants/visibility";
import type {
  AccessGrant,
  ContextVisibility,
} from "@purin-labs/authority/authorization/access-grants/types";
import { readAccessGrant } from "@purin-labs/authority/data/access-grants";
import {
  createCurrentSourceFlowLabel,
  integrationResourceScopeForGrant,
  visibilityForGrantSubject,
} from "@purin-labs/authority/policy/index";
import type { Result } from "@purin-labs/kernel/result";
import {
  FILE_EXTRACTED_TEXT_MAX_BYTES,
  FILE_SOURCE_MAX_BYTES,
  type FileProjectionCommand,
} from "./domain";
import { reserveFileExtractionBudget } from "./persistence";
import { sha256Hex } from "@purin-labs/std";

const FILE_SEGMENT_CHARS = 4_096;

export type FileProjectionMetadata = Readonly<{
  readonly displayName: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly deepLink: string;
  readonly sourceBytes: number;
  readonly providerRevision: ProviderFileRevision;
  readonly extraction:
    | Readonly<{ readonly kind: "text" }>
    | Readonly<{ readonly kind: "metadata_only"; readonly reason: string }>;
}>;

export type FileProjectionSourceError = Readonly<{
  readonly code: string;
  readonly retryable: boolean;
}>;

export interface FileProjectionSourceReader {
  readMetadata(
    command: FileProjectionCommand,
  ): Promise<Result<FileProjectionMetadata, FileProjectionSourceError>>;
  readTextContent(
    input: Readonly<{
      readonly command: FileProjectionCommand;
      readonly metadata: FileProjectionMetadata &
        Readonly<{
          readonly extraction: Readonly<{ readonly kind: "text" }>;
        }>;
      readonly maximumBytes: number;
    }>,
  ): Promise<Result<Uint8Array, FileProjectionSourceError>>;
}

export type FileProjectionApplyResult =
  | Readonly<{ readonly kind: "applied"; readonly segmentCount: number }>
  | Readonly<{ readonly kind: "duplicate"; readonly segmentCount: number }>
  | Readonly<{ readonly kind: "denied"; readonly reason: string }>
  | Readonly<{ readonly kind: "retry"; readonly reason: string }>;

type FileAdmission = Readonly<{
  readonly containingScopeKey: string;
  readonly providerRevision: ProviderFileRevision;
}>;

export async function applyFileProjectionCommand(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly command: FileProjectionCommand;
    readonly sourceReader: FileProjectionSourceReader;
    readonly now: number;
  }>,
): Promise<FileProjectionApplyResult> {
  if (input.scope.organisationId !== input.command.organisationId) {
    return { kind: "denied", reason: "file_command_organisation_mismatch" };
  }
  if (!(await input.scope.isActive())) {
    return {
      kind: "retry",
      reason: "organisation_execution_authority_inactive",
    };
  }
  const authority = await readFileProjectionAuthority(
    input.scope.database,
    input.command,
  );
  if (!authority.ok) return { kind: "denied", reason: authority.error };
  const existing = await readCompletedSource(
    input.scope.database,
    input.command,
  );
  if (!(await input.scope.isActive())) {
    return {
      kind: "retry",
      reason: "organisation_execution_authority_inactive",
    };
  }
  if (existing !== null) return { kind: "duplicate", segmentCount: existing };

  const metadata = await input.sourceReader.readMetadata(input.command);
  if (!(await input.scope.isActive())) {
    return {
      kind: "retry",
      reason: "organisation_execution_authority_inactive",
    };
  }
  if (!metadata.ok) {
    return metadata.error.retryable
      ? { kind: "retry", reason: metadata.error.code }
      : { kind: "denied", reason: metadata.error.code };
  }
  if (
    !sameProviderRevision(
      metadata.value.providerRevision,
      input.command.providerRevision,
    )
  ) {
    return { kind: "retry", reason: "provider_revision_changed" };
  }
  const resourceScope = integrationResourceScopeForGrant(authority.value.grant);
  if (
    resourceScope === null ||
    resourceScope !== authority.value.admission.containingScopeKey
  ) {
    return { kind: "denied", reason: "file_source_scope_mismatch" };
  }
  const flowLabel = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: input.scope.database,
    organisationId: input.command.organisationId,
    integrationAccountId: input.command.integrationAccountId,
    resourceScope,
    capabilityId: "file.read",
    grantIds: [authority.value.grant.grantId],
  });
  if (!flowLabel.ok) return { kind: "denied", reason: flowLabel.error.code };

  const extracted =
    metadata.value.extraction.kind === "metadata_only"
      ? metadataProjection(metadata.value)
      : await extractTextProjection(input, {
          ...metadata.value,
          extraction: metadata.value.extraction,
        });
  if (!extracted.ok) return extracted.error;
  const digest = await sha256Hex(extracted.value.text);
  const segments = segmentFileText(extracted.value.text);
  const statements = fileProjectionStatements({
    scope: input.scope,
    command: input.command,
    visibility: authority.value.visibility,
    flowLabelJson: JSON.stringify(flowLabel.value.toJSON()),
    metadata: metadata.value,
    resourceScope,
    contentDigest: digest,
    segments,
    metadataOnlyReason: extracted.value.metadataOnlyReason,
    now: input.now,
  });
  const results = await input.scope.database.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) {
    return { kind: "retry", reason: "file_projection_authority_changed" };
  }
  return { kind: "applied", segmentCount: segments.length };
}

export function segmentFileText(text: string): readonly string[] {
  const characters = Array.from(text);
  const segments: string[] = [];
  for (let start = 0; start < characters.length; start += FILE_SEGMENT_CHARS) {
    segments.push(characters.slice(start, start + FILE_SEGMENT_CHARS).join(""));
  }
  return segments.length === 0 ? [""] : segments;
}

export function normalizeFileText(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .trim();
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.byteLength <= FILE_EXTRACTED_TEXT_MAX_BYTES) return normalized;
  let end = FILE_EXTRACTED_TEXT_MAX_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    bytes.subarray(0, end),
  );
}

async function readFileProjectionAuthority(
  db: OrganisationDatabase,
  command: FileProjectionCommand,
): Promise<
  Result<
    Readonly<{
      readonly grant: AccessGrant;
      readonly admission: FileAdmission;
      readonly visibility: ContextVisibility;
    }>,
    string
  >
> {
  const grant = await readAccessGrant({
    db,
    organisationId: command.organisationId,
    grantId: command.grantId,
  });
  if (
    !grant.ok ||
    grant.value.lifecycle.kind !== "active" ||
    grant.value.lifecycle.revision !== command.grantRevision ||
    grant.value.target.kind !== "file_resource" ||
    grant.value.target.integrationAccountId !== command.integrationAccountId
  ) {
    return { ok: false, error: "file_grant_inactive" };
  }
  const visibility = visibilityForGrantSubject(grant.value.subject);
  if (encodeContextVisibility(visibility) !== command.visibilityKey) {
    return { ok: false, error: "file_visibility_claim_mismatch" };
  }
  const row = await db
    .prepare(
      `SELECT admission.containing_scope_key AS containingScopeKey,
            admission.provider_revision_json AS providerRevisionJson
       FROM file_grant_admission AS admission
       JOIN integration_account AS account
         ON account.organisation_id = admission.organisation_id
        AND account.integration_account_id = admission.integration_account_id
      WHERE admission.organisation_id = ? AND admission.grant_id = ?
        AND admission.grant_revision = ? AND admission.integration_account_id = ?
        AND admission.provider = ? AND admission.provider_file_id = ?
        AND account.lifecycle = 'active'`,
    )
    .bind(
      command.organisationId,
      command.grantId,
      command.grantRevision,
      command.integrationAccountId,
      command.provider,
      command.providerFileId,
    )
    .first<{
      readonly containingScopeKey: unknown;
      readonly providerRevisionJson: unknown;
    }>();
  if (
    row === null ||
    typeof row.containingScopeKey !== "string" ||
    typeof row.providerRevisionJson !== "string"
  ) {
    return { ok: false, error: "file_admission_missing" };
  }
  const revision = parseStoredRevision(row.providerRevisionJson);
  if (
    revision === null ||
    !sameProviderRevision(revision, command.providerRevision)
  ) {
    return { ok: false, error: "file_admission_revision_mismatch" };
  }
  return {
    ok: true,
    value: {
      grant: grant.value,
      admission: {
        containingScopeKey: row.containingScopeKey,
        providerRevision: revision,
      },
      visibility,
    },
  };
}

async function readCompletedSource(
  db: OrganisationDatabase,
  command: FileProjectionCommand,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT source_sequence AS sourceSequence, provider_revision_json AS providerRevisionJson,
            content_state AS contentState, segment_count AS segmentCount
       FROM file_resource_source
      WHERE organisation_id = ? AND integration_account_id = ? AND provider_file_id = ?`,
    )
    .bind(
      command.organisationId,
      command.integrationAccountId,
      command.providerFileId,
    )
    .first<{
      readonly sourceSequence: unknown;
      readonly providerRevisionJson: unknown;
      readonly contentState: unknown;
      readonly segmentCount: unknown;
    }>();
  if (
    row === null ||
    row.sourceSequence !== command.sourceSequence ||
    typeof row.providerRevisionJson !== "string"
  )
    return null;
  const revision = parseStoredRevision(row.providerRevisionJson);
  if (
    revision === null ||
    !sameProviderRevision(revision, command.providerRevision) ||
    (row.contentState !== "content" && row.contentState !== "metadata_only") ||
    typeof row.segmentCount !== "number" ||
    !Number.isSafeInteger(row.segmentCount)
  ) {
    return null;
  }
  const projection = await db
    .prepare(
      `SELECT COUNT(*) AS segmentCount
       FROM context_projection
      WHERE organisation_id = ? AND source_kind = 'file_segment'
        AND json_extract(source_json, '$.integrationAccountId') = ?
        AND json_extract(source_json, '$.providerFileId') = ?
        AND source_revision = ? AND visibility_key = ? AND lifecycle = 'ready'`,
    )
    .bind(
      command.organisationId,
      command.integrationAccountId,
      command.providerFileId,
      command.sourceSequence,
      command.visibilityKey,
    )
    .first<{ readonly segmentCount: unknown }>();
  return projection?.segmentCount === row.segmentCount
    ? row.segmentCount
    : null;
}

async function extractTextProjection(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly command: FileProjectionCommand;
    readonly sourceReader: FileProjectionSourceReader;
    readonly now: number;
  }>,
  metadata: FileProjectionMetadata &
    Readonly<{
      readonly extraction: Readonly<{ readonly kind: "text" }>;
    }>,
): Promise<
  Result<
    Readonly<{ readonly text: string; readonly metadataOnlyReason: null }>,
    FileProjectionApplyResult
  >
> {
  const budget = await reserveFileExtractionBudget({
    scope: input.scope,
    integrationAccountId: input.command.integrationAccountId,
    utcDay: new Date(input.now).toISOString().slice(0, 10),
    sourceBytes: metadata.sourceBytes,
    now: input.now,
  });
  if (budget.kind === "inactive" || !(await input.scope.isActive())) {
    return {
      ok: false,
      error: {
        kind: "retry",
        reason: "organisation_execution_authority_inactive",
      },
    };
  }
  if (budget.kind === "exhausted") {
    return {
      ok: false,
      error: { kind: "retry", reason: "file_daily_budget_exhausted" },
    };
  }
  const content = await input.sourceReader.readTextContent({
    command: input.command,
    metadata,
    maximumBytes: FILE_SOURCE_MAX_BYTES,
  });
  if (!(await input.scope.isActive())) {
    return {
      ok: false,
      error: {
        kind: "retry",
        reason: "organisation_execution_authority_inactive",
      },
    };
  }
  if (!content.ok) {
    return {
      ok: false,
      error: content.error.retryable
        ? { kind: "retry", reason: content.error.code }
        : { kind: "denied", reason: content.error.code },
    };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(content.value);
  } catch {
    return {
      ok: false,
      error: { kind: "denied", reason: "file_text_encoding_invalid" },
    };
  }
  return {
    ok: true,
    value: { text: normalizeFileText(decoded), metadataOnlyReason: null },
  };
}

function metadataProjection(metadata: FileProjectionMetadata): Result<
  Readonly<{
    readonly text: string;
    readonly metadataOnlyReason: string;
  }>,
  never
> {
  const reason =
    metadata.extraction.kind === "metadata_only"
      ? metadata.extraction.reason
      : "unsupported_media_type";
  return {
    ok: true,
    value: {
      text: normalizeFileText(
        `${metadata.displayName}\n${metadata.displayPath}\n${metadata.mediaType}\n${metadata.deepLink}`,
      ),
      metadataOnlyReason: reason,
    },
  };
}

function fileProjectionStatements(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly command: FileProjectionCommand;
    readonly visibility: ContextVisibility;
    readonly flowLabelJson: string;
    readonly metadata: FileProjectionMetadata;
    readonly resourceScope: string;
    readonly contentDigest: string;
    readonly segments: readonly string[];
    readonly metadataOnlyReason: string | null;
    readonly now: number;
  }>,
): D1PreparedStatement[] {
  const fence = fileProjectionFence(input.scope, input.command);
  const visibilityJson = JSON.stringify(input.visibility);
  const revisionJson = JSON.stringify({
    kind: "file",
    sequence: input.command.sourceSequence,
    providerRevision: input.command.providerRevision,
  });
  const provenanceJson = JSON.stringify({
    provider: input.command.provider,
    integrationAccountId: input.command.integrationAccountId,
    resourceScope: input.resourceScope,
    displayName: input.metadata.displayName,
    displayPath: input.metadata.displayPath,
    deepLink: input.metadata.deepLink,
    mediaType: input.metadata.mediaType,
    metadataOnlyReason: input.metadataOnlyReason,
  });
  const statements: D1PreparedStatement[] = [
    input.scope.database
      .prepare(
        `UPDATE context_projection
        SET lifecycle = 'superseded', content_digest = NULL, indexed_at = NULL,
            bounded_text = NULL, enqueued_at = NULL, failed_at = NULL,
            failure_reason = NULL, retry_at = NULL, superseded_at = ?,
            superseded_reason = 'revision_changed', updated_at = ?
      WHERE organisation_id = ? AND source_kind = 'file_segment'
        AND json_extract(source_json, '$.integrationAccountId') = ?
        AND json_extract(source_json, '$.providerFileId') = ?
        AND visibility_key = ? AND source_revision < ? AND lifecycle <> 'superseded'
        AND ${fence.sql}`,
      )
      .bind(
        input.now,
        input.now,
        input.command.organisationId,
        input.command.integrationAccountId,
        input.command.providerFileId,
        input.command.visibilityKey,
        input.command.sourceSequence,
        ...fence.bindings,
      ),
  ];
  for (
    let segmentIndex = 0;
    segmentIndex < input.segments.length;
    segmentIndex += 1
  ) {
    const source = {
      kind: "file_segment" as const,
      integrationAccountId: input.command.integrationAccountId,
      provider: input.command.provider,
      providerFileId: input.command.providerFileId,
      segmentIndex,
    };
    const sourceKey = fileSourceKey(input.command, segmentIndex);
    statements.push(
      input.scope.database
        .prepare(
          `INSERT INTO context_projection (
         organisation_id, source_kind, source_key, source_json, source_revision,
         source_revision_json, lifecycle, content_digest, visibility_json,
         visibility_key, flow_label_json, indexed_at, bounded_text, title,
         display_path, provenance_json, grant_id, grant_revision, provider_file_id,
         created_at, updated_at
       ) SELECT ?, 'file_segment', ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${fence.sql}
       ON CONFLICT (organisation_id, source_kind, source_key, visibility_key) DO UPDATE SET
         source_json = excluded.source_json,
         source_revision = excluded.source_revision,
         source_revision_json = excluded.source_revision_json,
         lifecycle = 'ready', content_digest = excluded.content_digest,
         visibility_json = excluded.visibility_json,
         flow_label_json = excluded.flow_label_json,
         indexed_at = excluded.indexed_at, bounded_text = excluded.bounded_text,
         title = excluded.title, display_path = excluded.display_path,
         provenance_json = excluded.provenance_json, grant_id = excluded.grant_id,
         grant_revision = excluded.grant_revision, provider_file_id = excluded.provider_file_id,
         enqueued_at = NULL, failed_at = NULL, failure_reason = NULL,
         retry_at = NULL, superseded_at = NULL, superseded_reason = NULL,
         updated_at = excluded.updated_at
       WHERE excluded.source_revision >= context_projection.source_revision`,
        )
        .bind(
          input.command.organisationId,
          sourceKey,
          JSON.stringify(source),
          input.command.sourceSequence,
          revisionJson,
          input.contentDigest,
          visibilityJson,
          input.command.visibilityKey,
          input.flowLabelJson,
          input.now,
          input.segments[segmentIndex],
          input.metadata.displayName,
          input.metadata.displayPath,
          provenanceJson,
          input.command.grantId,
          input.command.grantRevision,
          input.command.providerFileId,
          input.now,
          input.now,
          ...fence.bindings,
        ),
    );
  }
  statements.push(
    input.scope.database
      .prepare(
        `UPDATE context_projection
        SET lifecycle = 'superseded', content_digest = NULL, indexed_at = NULL,
            bounded_text = NULL, enqueued_at = NULL, failed_at = NULL,
            failure_reason = NULL, retry_at = NULL, superseded_at = ?,
            superseded_reason = 'segment_removed', updated_at = ?
      WHERE organisation_id = ? AND source_kind = 'file_segment'
        AND json_extract(source_json, '$.integrationAccountId') = ?
        AND json_extract(source_json, '$.providerFileId') = ?
        AND json_extract(source_json, '$.segmentIndex') >= ?
        AND visibility_key = ? AND lifecycle = 'ready' AND ${fence.sql}`,
      )
      .bind(
        input.now,
        input.now,
        input.command.organisationId,
        input.command.integrationAccountId,
        input.command.providerFileId,
        input.segments.length,
        input.command.visibilityKey,
        ...fence.bindings,
      ),
  );
  statements.push(
    input.scope.database
      .prepare(
        `UPDATE file_resource_source
        SET content_state = ?, content_digest = ?, metadata_only_reason = ?,
            segment_count = ?, updated_at = ?
      WHERE organisation_id = ? AND integration_account_id = ? AND provider_file_id = ?
        AND source_sequence = ? AND provider_revision_json = ? AND ${fence.sql}`,
      )
      .bind(
        input.metadataOnlyReason === null ? "content" : "metadata_only",
        input.metadataOnlyReason === null ? input.contentDigest : null,
        input.metadataOnlyReason,
        input.segments.length,
        input.now,
        input.command.organisationId,
        input.command.integrationAccountId,
        input.command.providerFileId,
        input.command.sourceSequence,
        JSON.stringify(input.command.providerRevision),
        ...fence.bindings,
      ),
  );
  return statements;
}

function fileSourceKey(
  command: FileProjectionCommand,
  segmentIndex: number,
): string {
  return `${command.integrationAccountId}\u0000${command.provider}\u0000${command.providerFileId}\u0000${segmentIndex}`;
}

function parseStoredRevision(value: string): ProviderFileRevision | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || !("kind" in raw)) return null;
  if (raw.kind === "dropbox" && "rev" in raw && typeof raw.rev === "string") {
    return { kind: "dropbox", rev: raw.rev };
  }
  if (
    raw.kind === "gdrive" &&
    "version" in raw &&
    "modifiedTime" in raw &&
    "headRevisionId" in raw &&
    typeof raw.version === "string" &&
    typeof raw.modifiedTime === "string" &&
    (raw.headRevisionId === null || typeof raw.headRevisionId === "string")
  ) {
    return {
      kind: "gdrive",
      version: raw.version,
      modifiedTime: raw.modifiedTime,
      headRevisionId: raw.headRevisionId,
    };
  }
  return null;
}

function sameProviderRevision(
  left: ProviderFileRevision,
  right: ProviderFileRevision,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
