import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  FileContextProvider,
  ProviderFileRevision,
  RequestAuthority,
} from "@purin-labs/contracts";

import type {
  CanonicalFileReference,
  FileReadToolResult,
  FileSearchToolResult,
} from "../../agent-tools/catalog/types";
import { encodeContextVisibility } from "@purin-labs/authority/authorization/access-grants/visibility";
import type {
  AccessGrantTarget,
  ContextVisibility,
} from "@purin-labs/authority/authorization/access-grants/types";
import { readAccessGrant } from "@purin-labs/authority/data/access-grants";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  decideContextAdmission,
  createCurrentSourceFlowLabel,
  joinFlowLabels,
  FlowLabel,
  ObservationEvidence,
} from "@purin-labs/authority/policy/index";
import { createContextProjectionReader } from "../projection";
import {
  FILE_SOURCE_MAX_BYTES,
  createFileProjectionCommand,
  parseProviderFileRevision,
  type FileProjectionCommand,
} from "./domain";
import {
  reserveFileExtractionBudget,
  scheduleFileReconciliationHint,
} from "./persistence";
import { ProviderFileProjectionSourceReader } from "./provider-source";
import type { FileProviderCredentialStore } from "../../provider-workflows/file-context-credential";
import { normalizeFileText, segmentFileText } from "./projection";
import { ACTIVE_FILE_GRANT_VISIBILITY_SQL } from "./authority-sql";
import { isPositiveInteger, sha256Hex, canonicalJson } from "@purin-labs/std";

const FILE_SEARCH_QUERY_MAX_CHARS = 256;
const FILE_SEARCH_MAX_RESULTS = 20;
const FILE_READ_MAX_SEGMENTS = 8;

export type {
  CanonicalFileReference,
  FileReadToolResult,
  FileSearchToolResult,
};

export type FileToolObservation = Readonly<{
  readonly inputLabel: FlowLabel;
  readonly evidence: ObservationEvidence;
}>;

type FileToolAuthorityRow = Readonly<{
  readonly grantId: unknown;
  readonly grantRevision: unknown;
  readonly sourceSequence: unknown;
  readonly providerRevisionJson: unknown;
  readonly visibilityKey: unknown;
  readonly flowLabelJson: unknown;
  readonly provenanceJson: unknown;
  readonly contentDigest: unknown;
  readonly indexedAt: unknown;
}>;

type AuthorizedFileRead = Readonly<{
  readonly command: FileProjectionCommand;
  readonly title: string;
  readonly displayPath: string;
  readonly deepLink: string;
  readonly metadataOnlyReason: string | null;
  readonly resourceScope: string;
  readonly inputLabel: FlowLabel;
  readonly contentDigest: string;
  readonly observedAt: number;
}>;

type ParsedAuthorizedFileRead = Omit<AuthorizedFileRead, "inputLabel">;

export async function searchGrantedFiles(
  input: Readonly<{
    readonly db: D1Database;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
    readonly requestAuthority: RequestAuthority;
    readonly visibility: readonly ContextVisibility[];
    readonly query: string;
    readonly limit: number;
    readonly observe: (observation: FileToolObservation) => Promise<void>;
  }>,
): Promise<readonly FileSearchToolResult[]> {
  const query = normalizeQuery(input.query);
  if (
    query === null ||
    input.limit < 1 ||
    input.limit > FILE_SEARCH_MAX_RESULTS
  ) {
    throw new Error("file_search_arguments_invalid");
  }
  const results = await createContextProjectionReader(input.db).search({
    organisationId: input.organisationId,
    visibility: input.visibility,
    sourceKind: "file_segment",
    query,
    limit: input.limit,
  });
  const admitted: FileSearchToolResult[] = [];
  for (const result of results) {
    const projection = result.projection;
    if (
      projection.source.kind !== "file_segment" ||
      projection.provenance.kind !== "integration_file"
    )
      continue;
    const label = await FlowLabel.restore(projection.inputLabel);
    if (!label.ok) continue;
    const decision = await decideContextAdmission({
      subject: {
        kind: "authority_derived",
        requestAuthority: input.requestAuthority,
        caseId: input.caseId,
      },
      inputLabel: label.value,
    });
    if (decision.kind !== "admit") continue;
    const evidence = await createFileObservation({
      organisationId: input.organisationId,
      integrationAccountId: projection.provenance.integrationAccountId,
      resourceScope: projection.provenance.resourceScope,
      sourceRevision: projection.sourceRevision,
      contentDigest: projection.contentDigest,
      inputLabel: label.value,
      observedAt: projection.indexedAt,
    });
    await input.observe({ inputLabel: label.value, evidence });
    const reference = fileReference(projection.source);
    if (reference === null) continue;
    admitted.push({
      reference,
      segmentIndex: projection.source.segmentIndex,
      sourceRevision: projection.sourceRevision,
      title: projection.provenance.displayName,
      displayPath: projection.provenance.displayPath,
      deepLink: projection.provenance.deepLink,
      excerpt: projection.boundedText,
      metadataOnlyReason: projection.provenance.metadataOnlyReason,
    });
  }
  return admitted;
}

export async function readGrantedFile(
  input: Readonly<{
    readonly env: Env;
    readonly scope: OrganisationExecutionScope;
    readonly authorizeExecution: () => Promise<void>;
    readonly storeCredential: FileProviderCredentialStore;
    readonly caseId: CaseId;
    readonly requestAuthority: RequestAuthority;
    readonly visibility: readonly ContextVisibility[];
    readonly reference: CanonicalFileReference;
    readonly startSegment: number;
    readonly fetcher: typeof fetch;
    readonly now: number;
    readonly observe: (observation: FileToolObservation) => Promise<void>;
  }>,
): Promise<FileReadToolResult> {
  if (!Number.isSafeInteger(input.startSegment) || input.startSegment < 0) {
    throw new Error("file_read_start_segment_invalid");
  }
  await input.authorizeExecution();
  const authority = await readFileToolAuthority({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    caseId: input.caseId,
    requestAuthority: input.requestAuthority,
    visibility: input.visibility,
    reference: input.reference,
  });
  if (authority === null) throw new Error("file_read_not_authorized");
  if (authority.metadataOnlyReason !== null) {
    await observeAuthorizedFileRead(
      input,
      authority,
      authority.contentDigest,
      authority.observedAt,
    );
    return {
      kind: "metadata_only",
      reference: input.reference,
      title: authority.title,
      displayPath: authority.displayPath,
      deepLink: authority.deepLink,
      reason: authority.metadataOnlyReason,
    };
  }
  const grant = await readAccessGrant({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    grantId: authority.command.grantId,
  });
  if (
    !grant.ok ||
    grant.value.lifecycle.kind !== "active" ||
    !grantCanAuthorizeCommand(authority.command, grant.value.target)
  ) {
    throw new Error("file_read_not_authorized");
  }

  const reader = new ProviderFileProjectionSourceReader({
    env: input.env,
    db: input.scope.database,
    storeCredential: input.storeCredential,
    command: authority.command,
    fetcher: input.fetcher,
    now: input.now,
  });
  const metadata = await reader.readMetadata(authority.command);
  await input.authorizeExecution();
  if (
    !metadata.ok ||
    !sameProviderRevision(
      metadata.value.providerRevision,
      authority.command.providerRevision,
    )
  ) {
    await hintReconciliation(input.scope, authority.command, input.now);
    throw new Error(
      metadata.ok ? "file_read_revision_changed" : metadata.error.code,
    );
  }
  if (
    !(await metadataRemainsInGrant({
      displayPath: metadata.value.displayPath,
      command: authority.command,
      target: grant.value.target,
      reader,
    }))
  ) {
    await input.authorizeExecution();
    await hintReconciliation(input.scope, authority.command, input.now);
    throw new Error("file_read_membership_changed");
  }
  if (metadata.value.extraction.kind === "metadata_only") {
    return {
      kind: "metadata_only",
      reference: input.reference,
      title: metadata.value.displayName,
      displayPath: metadata.value.displayPath,
      deepLink: metadata.value.deepLink,
      reason: metadata.value.extraction.reason,
    };
  }
  await input.authorizeExecution();
  const budget = await reserveFileExtractionBudget({
    scope: input.scope,
    integrationAccountId: input.reference.integrationAccountId,
    utcDay: new Date(input.now).toISOString().slice(0, 10),
    sourceBytes: metadata.value.sourceBytes,
    now: input.now,
  });
  if (budget.kind === "inactive") {
    throw new Error("organisation_execution_authority_inactive");
  }
  if (budget.kind === "exhausted")
    throw new Error("file_daily_budget_exhausted");
  const content = await reader.readTextContent({
    command: authority.command,
    metadata: { ...metadata.value, extraction: metadata.value.extraction },
    maximumBytes: FILE_SOURCE_MAX_BYTES,
  });
  await input.authorizeExecution();
  if (!content.ok) {
    if (content.error.retryable)
      await hintReconciliation(input.scope, authority.command, input.now);
    throw new Error(content.error.code);
  }
  const text = decodeNormalizedText(content.value);
  await observeAuthorizedFileRead(
    input,
    authority,
    await sha256Hex(text),
    input.now,
  );
  const allSegments = segmentFileText(text);
  const segments = allSegments.slice(
    input.startSegment,
    input.startSegment + FILE_READ_MAX_SEGMENTS,
  );
  const nextSegment = input.startSegment + segments.length;
  return {
    kind: "content",
    reference: input.reference,
    title: metadata.value.displayName,
    displayPath: metadata.value.displayPath,
    deepLink: metadata.value.deepLink,
    startSegment: input.startSegment,
    segments,
    continuation:
      nextSegment < allSegments.length
        ? { kind: "more", nextSegment }
        : { kind: "complete" },
  };
}

function grantCanAuthorizeCommand(
  command: FileProjectionCommand,
  target: AccessGrantTarget,
): boolean {
  if (
    target.kind !== "file_resource" ||
    target.integrationAccountId !== command.integrationAccountId
  )
    return false;
  switch (target.scope.kind) {
    case "dropbox_file":
      return (
        command.provider === "dropbox" &&
        target.scope.providerFileId === command.providerFileId
      );
    case "dropbox_folder":
      return command.provider === "dropbox";
    case "gdrive_file":
      return (
        command.provider === "google_drive" &&
        target.scope.providerFileId === command.providerFileId
      );
  }
}

export async function readGrantedFileMetadata(
  input: Parameters<typeof readFileToolAuthority>[0],
): Promise<Readonly<{
  title: string;
  sourceRevision: number;
  inputLabel: FlowLabel;
  evidence: ObservationEvidence;
}> | null> {
  const authority = await readFileToolAuthority(input);
  if (authority === null) return null;
  const contentDigest = await sha256Hex(
    canonicalJson({
      reference: {
        kind: "file",
        integrationAccountId: input.reference.integrationAccountId,
        provider: input.reference.provider,
        providerFileId: input.reference.providerFileId,
        label: authority.title,
      },
      revision: String(authority.command.sourceSequence),
    }),
  );
  const evidence = await createFileObservation({
    organisationId: input.organisationId,
    integrationAccountId: input.reference.integrationAccountId,
    resourceScope: authority.resourceScope,
    sourceRevision: authority.command.sourceSequence,
    contentDigest,
    inputLabel: authority.inputLabel,
    observedAt: authority.observedAt,
  });
  const current = await readFileToolAuthority(input);
  if (
    current === null ||
    current.command.grantRevision !== authority.command.grantRevision ||
    current.command.sourceSequence !== authority.command.sourceSequence
  )
    return null;
  return {
    title: authority.title,
    sourceRevision: authority.command.sourceSequence,
    inputLabel: authority.inputLabel,
    evidence,
  };
}

async function readFileToolAuthority(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
    readonly requestAuthority: RequestAuthority;
    readonly visibility: readonly ContextVisibility[];
    readonly reference: CanonicalFileReference;
  }>,
): Promise<AuthorizedFileRead | null> {
  const visibilityKeys = [
    ...new Set(input.visibility.map(encodeContextVisibility)),
  ];
  if (visibilityKeys.length === 0) return null;
  const placeholders = visibilityKeys.map(questionMark).join(", ");
  const row = await input.db
    .prepare(
      `SELECT grant_record.grant_id AS grantId, grant_record.revision AS grantRevision,
            source.source_sequence AS sourceSequence,
            source.provider_revision_json AS providerRevisionJson,
            projection.visibility_key AS visibilityKey,
            projection.flow_label_json AS flowLabelJson,
            projection.provenance_json AS provenanceJson,
            projection.content_digest AS contentDigest,
            projection.indexed_at AS indexedAt
       FROM context_projection AS projection
       JOIN file_resource_source AS source
         ON source.organisation_id = projection.organisation_id
        AND source.integration_account_id = ?
        AND source.provider_file_id = projection.provider_file_id
       JOIN access_grant AS grant_record
         ON grant_record.organisation_id = projection.organisation_id
       JOIN file_grant_admission AS admission
         ON admission.organisation_id = grant_record.organisation_id
        AND admission.grant_id = grant_record.grant_id
        AND admission.grant_revision = grant_record.revision
        AND admission.integration_account_id = source.integration_account_id
        AND admission.provider = ? AND admission.provider_file_id = source.provider_file_id
       JOIN integration_account AS account
         ON account.organisation_id = source.organisation_id
        AND account.integration_account_id = source.integration_account_id
      WHERE projection.organisation_id = ? AND projection.source_kind = 'file_segment'
        AND projection.provider_file_id = ? AND projection.lifecycle = 'ready'
        AND projection.visibility_key IN (${placeholders})
        AND ${ACTIVE_FILE_GRANT_VISIBILITY_SQL} = projection.visibility_key
        AND grant_record.lifecycle = 'active' AND account.lifecycle = 'active'
      ORDER BY projection.source_revision DESC, projection.updated_at DESC LIMIT 1`,
    )
    .bind(
      input.reference.integrationAccountId,
      input.reference.provider,
      input.organisationId,
      input.reference.providerFileId,
      ...visibilityKeys,
    )
    .first<FileToolAuthorityRow>();
  if (row === null) return null;
  const parsed = parseAuthorizedFileRead(row, input);
  if (parsed === null) return null;
  const storedLabel = await restoreFlowLabel(row.flowLabelJson);
  if (storedLabel === null) return null;
  const currentLabel = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.reference.integrationAccountId,
    capabilityId: "file.read",
    resourceScope: parsed.resourceScope,
    grantIds: [parsed.command.grantId],
  });
  if (!currentLabel.ok) return null;
  const joined = await joinFlowLabels(storedLabel, currentLabel.value);
  if (!joined.ok) return null;
  const label = joined.value;
  const decision = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: input.requestAuthority,
      caseId: input.caseId,
    },
    inputLabel: label,
  });
  return decision.kind === "admit" ? { ...parsed, inputLabel: label } : null;
}

function parseAuthorizedFileRead(
  row: FileToolAuthorityRow,
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly reference: CanonicalFileReference;
  }>,
): ParsedAuthorizedFileRead | null {
  if (
    typeof row.grantId !== "string" ||
    !isPositiveInteger(row.grantRevision) ||
    !isPositiveInteger(row.sourceSequence) ||
    typeof row.providerRevisionJson !== "string" ||
    typeof row.visibilityKey !== "string" ||
    typeof row.flowLabelJson !== "string" ||
    typeof row.provenanceJson !== "string" ||
    typeof row.contentDigest !== "string" ||
    typeof row.indexedAt !== "number" ||
    !Number.isSafeInteger(row.indexedAt) ||
    row.indexedAt < 0
  )
    return null;
  let rawRevision: unknown;
  let provenance: unknown;
  try {
    rawRevision = JSON.parse(row.providerRevisionJson);
    provenance = JSON.parse(row.provenanceJson);
  } catch {
    return null;
  }
  const providerRevision = parseProviderFileRevision(rawRevision);
  if (
    providerRevision === null ||
    !sameProviderRevisionForProvider(
      input.reference.provider,
      providerRevision,
    ) ||
    !isFileProvenance(provenance, input.reference)
  )
    return null;
  return {
    command: createFileProjectionCommand({
      organisationId: input.organisationId,
      grantId: row.grantId,
      grantRevision: row.grantRevision,
      integrationAccountId: input.reference.integrationAccountId,
      provider: input.reference.provider,
      providerFileId: input.reference.providerFileId,
      sourceSequence: row.sourceSequence,
      providerRevision,
      visibilityKey: row.visibilityKey,
    }),
    title: provenance.displayName,
    displayPath: provenance.displayPath,
    deepLink: provenance.deepLink,
    metadataOnlyReason: provenance.metadataOnlyReason,
    resourceScope: provenance.resourceScope,
    contentDigest: row.contentDigest,
    observedAt: row.indexedAt,
  };
}

async function observeAuthorizedFileRead(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly observe: (observation: FileToolObservation) => Promise<void>;
  }>,
  authority: AuthorizedFileRead,
  contentDigest: string,
  observedAt: number,
): Promise<void> {
  const evidence = await createFileObservation({
    organisationId: input.scope.organisationId,
    integrationAccountId: authority.command.integrationAccountId,
    resourceScope: authority.resourceScope,
    sourceRevision: authority.command.sourceSequence,
    contentDigest,
    inputLabel: authority.inputLabel,
    observedAt,
  });
  await input.observe({ inputLabel: authority.inputLabel, evidence });
}

async function createFileObservation(
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId | string;
    readonly resourceScope: string;
    readonly sourceRevision: number;
    readonly contentDigest: string;
    readonly inputLabel: FlowLabel;
    readonly observedAt: number;
  }>,
): Promise<ObservationEvidence> {
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "integration_resource",
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      resourceScope: input.resourceScope,
    },
    sourceRevision: input.sourceRevision,
    contentDigest: input.contentDigest,
    inputLabel: input.inputLabel,
    observedAt: input.observedAt,
  });
  if (!evidence.ok) throw new Error(evidence.error.code);
  return evidence.value;
}

function isFileProvenance(
  value: unknown,
  reference: CanonicalFileReference,
): value is Readonly<{
  readonly provider: FileContextProvider;
  readonly integrationAccountId: string;
  readonly displayName: string;
  readonly displayPath: string;
  readonly deepLink: string;
  readonly metadataOnlyReason: string | null;
  readonly resourceScope: string;
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === reference.provider &&
    "integrationAccountId" in value &&
    value.integrationAccountId === reference.integrationAccountId &&
    "displayName" in value &&
    typeof value.displayName === "string" &&
    "displayPath" in value &&
    typeof value.displayPath === "string" &&
    "deepLink" in value &&
    typeof value.deepLink === "string" &&
    "metadataOnlyReason" in value &&
    (value.metadataOnlyReason === null ||
      typeof value.metadataOnlyReason === "string") &&
    "resourceScope" in value &&
    typeof value.resourceScope === "string" &&
    value.resourceScope.length > 0
  );
}

async function metadataRemainsInGrant(
  input: Readonly<{
    readonly displayPath: string;
    readonly command: FileProjectionCommand;
    readonly target: AccessGrantTarget;
    readonly reader: ProviderFileProjectionSourceReader;
  }>,
): Promise<boolean> {
  if (
    input.target.kind !== "file_resource" ||
    input.target.integrationAccountId !== input.command.integrationAccountId
  )
    return false;
  switch (input.target.scope.kind) {
    case "dropbox_file":
      return (
        input.command.provider === "dropbox" &&
        input.target.scope.providerFileId === input.command.providerFileId
      );
    case "dropbox_folder": {
      if (input.command.provider !== "dropbox") return false;
      const folder = await input.reader.readDropboxFolderPath(
        input.target.scope.providerFolderId,
      );
      if (!folder.ok) return false;
      const folderPath = folder.value.replace(/\/+$/u, "");
      return (
        input.displayPath === folderPath ||
        input.displayPath.startsWith(`${folderPath}/`)
      );
    }
    case "gdrive_file":
      return (
        input.command.provider === "google_drive" &&
        input.target.scope.providerFileId === input.command.providerFileId
      );
  }
}

async function hintReconciliation(
  scope: OrganisationExecutionScope,
  command: FileProjectionCommand,
  now: number,
): Promise<void> {
  await scheduleFileReconciliationHint({
    scope,
    integrationAccountId: command.integrationAccountId,
    nextRunAt: now,
  });
}

function normalizeQuery(value: string): string | null {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length > 0 &&
    Array.from(normalized).length <= FILE_SEARCH_QUERY_MAX_CHARS
    ? normalized
    : null;
}

function fileReference(
  source: Readonly<{
    readonly integrationAccountId: string;
    readonly provider: FileContextProvider;
    readonly providerFileId: string;
  }>,
): CanonicalFileReference | null {
  const integrationAccountId = parseIntegrationAccountId(
    source.integrationAccountId,
  );
  if (!integrationAccountId.ok) return null;
  return {
    integrationAccountId: integrationAccountId.value,
    provider: source.provider,
    providerFileId: source.providerFileId,
  };
}

async function restoreFlowLabel(raw: unknown): Promise<FlowLabel | null> {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const restored = await FlowLabel.restore(value);
  return restored.ok ? restored.value : null;
}

function decodeNormalizedText(bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new Error("file_text_encoding_invalid");
  }
  return normalizeFileText(decoded);
}

function sameProviderRevision(
  left: ProviderFileRevision,
  right: ProviderFileRevision,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameProviderRevisionForProvider(
  provider: FileContextProvider,
  revision: ProviderFileRevision,
): boolean {
  return (
    (provider === "dropbox" && revision.kind === "dropbox") ||
    (provider === "google_drive" && revision.kind === "gdrive")
  );
}

function questionMark(): string {
  return "?";
}
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
