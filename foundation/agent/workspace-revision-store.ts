import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  CausationRef,
  CorrelationId,
  IdempotencyKey,
  Sha256Digest,
  Timestamp,
  WorkspaceId,
  WorkspaceRevision,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";

import type { Result } from "@purin-labs/kernel/result";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord, sha256Hex } from "@purin-labs/std";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WORKSPACE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const MAX_WORKSPACE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WORKSPACE_REVISION_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 1_024;
const ENCODER = new TextEncoder();
const PREPARED_WORKSPACE_REVISION = Symbol("prepared_workspace_revision");

type WorkspaceRevisionMutation = {
  readonly organisationId: string;
  readonly workspaceId: WorkspaceId;
  readonly baseRevision: WorkspaceRevision | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalHead: Sha256Digest;
  readonly manifestRef: string;
  readonly manifestDigest: Sha256Digest;
  readonly changesetRef: string;
  readonly changesetDigest: Sha256Digest;
  readonly correlationId: CorrelationId;
  readonly causation: CausationRef;
  readonly committedAt: Timestamp;
};

type WorkspaceRevisionFileCandidate = {
  readonly path: string;
  readonly mediaType: string;
  readonly content: string;
};

type WorkspaceRevisionProposalBase = {
  readonly organisationId: string;
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: IdempotencyKey;
  readonly files: readonly WorkspaceRevisionFileCandidate[];
  readonly correlationId: CorrelationId;
  readonly causation: CausationRef;
  readonly committedAt: Timestamp;
};

/** Plan 92 removed the product-folder changeset; a revision is a genesis. */
export type WorkspaceRevisionProposal = WorkspaceRevisionProposalBase & {
  readonly kind: "genesis";
};

export type WorkspaceRevisionAuthority =
  | {
      readonly kind: "placement";
      readonly authorizeCommit?: never;
    }
  | {
      readonly kind: "execution";
      readonly authorizeCommit: () => Promise<boolean>;
    };

type WorkspaceRevisionCommitResult =
  | { readonly kind: "committed"; readonly receipt: WorkspaceRevisionReceipt }
  | { readonly kind: "duplicate"; readonly receipt: WorkspaceRevisionReceipt };

export type WorkspaceRevisionMaterialization = {
  readonly revision: WorkspaceRevision;
  readonly canonicalHead: Sha256Digest;
  readonly manifestDigest: Sha256Digest;
  readonly manifest: WorkspaceRevisionManifestV1;
};

export type WorkspaceRevisionStoreError =
  | { readonly code: "workspace_execution_authority_inactive" }
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "workspace_revision_input_invalid" }
  | { readonly code: "workspace_revision_idempotency_conflict" }
  | {
      readonly code: "workspace_revision_base_conflict";
      readonly currentRevision: WorkspaceRevision | null;
      readonly currentHead: Sha256Digest | null;
    }
  | { readonly code: "workspace_revision_receipt_missing" }
  | { readonly code: "workspace_revision_missing" }
  | { readonly code: "workspace_revision_receipt_conflict" }
  | { readonly code: "workspace_revision_object_missing" }
  | { readonly code: "workspace_revision_object_corrupt" }
  | { readonly code: "workspace_revision_storage_failed" };

type WorkspaceHeadRow = {
  revision_id: string;
  canonical_head: string;
};

type WorkspaceReceiptRow = {
  request_digest: string;
  receipt_projection: string;
};

type WorkspaceRevisionRow = {
  base_revision_id: string | null;
  canonical_head: string;
  manifest_ref: string;
  manifest_digest: string;
};

type CurrentWorkspaceReceiptRow = {
  revision_id: string;
  canonical_head: string;
  receipt_projection: string;
};

export type PreparedWorkspaceRevisionMutation = {
  readonly authority: WorkspaceRevisionAuthority;
  readonly [PREPARED_WORKSPACE_REVISION]: true;
  readonly scope: OrganisationExecutionScope;
  readonly input: WorkspaceRevisionMutation;
  readonly manifestBytes: Uint8Array;
  readonly changesetBytes: Uint8Array;
  readonly revision: WorkspaceRevision;
  readonly receipt: WorkspaceRevisionReceipt;
  readonly requestDigest: Sha256Digest;
};

type WorkspaceRevisionManifestV1 = {
  readonly schemaVersion: "workspace_revision_manifest.v1";
  readonly organisationId: string;
  readonly workspaceId: WorkspaceId;
  readonly baseRevision: WorkspaceRevision | null;
  readonly files: readonly WorkspaceRevisionManifestFileV1[];
};

type WorkspaceRevisionManifestFileV1 = {
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: Sha256Digest;
  readonly content: string;
};

const PREPARED_MUTATIONS = new WeakSet<object>();

async function authorizeWorkspaceRevision(
  scope: OrganisationExecutionScope,
  authority: WorkspaceRevisionAuthority,
): Promise<Result<true, WorkspaceRevisionStoreError>> {
  switch (authority.kind) {
    case "placement":
      if (!(await scope.isActive()))
        return {
          ok: false,
          error: { code: "organisation_placement_conflict" },
        };
      return { ok: true, value: true };
    case "execution": {
      const [placementActive, executionActive] = await Promise.all([
        scope.isActive(),
        authority.authorizeCommit(),
      ]);
      if (!placementActive)
        return {
          ok: false,
          error: { code: "organisation_placement_conflict" },
        };
      if (!executionActive)
        return {
          ok: false,
          error: { code: "workspace_execution_authority_inactive" },
        };
      return { ok: true, value: true };
    }
    default:
      return assertNever(authority);
  }
}

export function prepareWorkspaceRevisionMutation(
  scope: OrganisationExecutionScope,
  authority: Variant<WorkspaceRevisionAuthority, "placement">,
  archive: R2Bucket,
  proposal: Variant<WorkspaceRevisionProposal, "genesis">,
): Promise<
  Result<PreparedWorkspaceRevisionMutation, WorkspaceRevisionStoreError>
>;
export function prepareWorkspaceRevisionMutation(
  scope: OrganisationExecutionScope,
  authority: Variant<WorkspaceRevisionAuthority, "execution">,
  archive: R2Bucket,
  proposal: WorkspaceRevisionProposal,
): Promise<
  Result<PreparedWorkspaceRevisionMutation, WorkspaceRevisionStoreError>
>;
export async function prepareWorkspaceRevisionMutation(
  scope: OrganisationExecutionScope,
  authority: WorkspaceRevisionAuthority,
  archive: R2Bucket,
  proposal: WorkspaceRevisionProposal,
): Promise<
  Result<PreparedWorkspaceRevisionMutation, WorkspaceRevisionStoreError>
> {
  if (authority.kind === "placement" && proposal.kind !== "genesis")
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  if (scope.organisationId !== proposal.organisationId)
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const initialAuthority = await authorizeWorkspaceRevision(scope, authority);
  if (!initialAuthority.ok) return initialAuthority;
  const normalized = await normalizeProposal(proposal);
  if (!normalized.ok) return normalized;
  const prepared = await prepareMutation(normalized.value.input);
  const materialized: PreparedWorkspaceRevisionMutation = {
    [PREPARED_WORKSPACE_REVISION]: true,
    authority,
    scope,
    input: prepared.input,
    revision: prepared.revision,
    receipt: prepared.receipt,
    requestDigest: prepared.requestDigest,
    manifestBytes: normalized.value.manifestBytes,
    changesetBytes: normalized.value.changesetBytes,
  };
  const stored = await storeRevisionObjects(archive, materialized);
  if (!stored.ok) return stored;
  const storedAuthority = await authorizeWorkspaceRevision(scope, authority);
  if (!storedAuthority.ok) return storedAuthority;
  PREPARED_MUTATIONS.add(materialized);
  return { ok: true, value: materialized };
}

export async function commitWorkspaceRevision(
  archive: R2Bucket,
  prepared: PreparedWorkspaceRevisionMutation,
): Promise<Result<WorkspaceRevisionCommitResult, WorkspaceRevisionStoreError>> {
  if (!PREPARED_MUTATIONS.has(prepared)) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  const scope = prepared.scope;
  const db = scope.database;
  const initialAuthority = await authorizeWorkspaceRevision(
    scope,
    prepared.authority,
  );
  if (!initialAuthority.ok) return initialAuthority;
  const verified = await verifyRevisionObjects(archive, prepared);
  if (!verified.ok) return verified;
  const input = prepared.input;
  if (!validMutation(input)) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  const existing = await readReceiptByIdempotency(db, input);
  const receiptAuthority = await authorizeWorkspaceRevision(
    scope,
    prepared.authority,
  );
  if (!receiptAuthority.ok) return receiptAuthority;
  if (existing !== null) return duplicateReceipt(existing, prepared);

  const head = await readHead(db, input.organisationId, input.workspaceId);
  if (!expectedHead(input.baseRevision, head)) return baseConflict(head);

  const publicationAuthority = await authorizeWorkspaceRevision(
    scope,
    prepared.authority,
  );
  if (!publicationAuthority.ok) return publicationAuthority;

  try {
    // Schema triggers reject stale bases within the same batch as head and receipt publication.
    await db.batch(commitStatements(db, prepared, head));
  } catch {
    const failureAuthority = await authorizeWorkspaceRevision(
      scope,
      prepared.authority,
    );
    if (!failureAuthority.ok) return failureAuthority;
    const racedReceipt = await readReceiptByIdempotency(db, input);
    const racedReceiptAuthority = await authorizeWorkspaceRevision(
      scope,
      prepared.authority,
    );
    if (!racedReceiptAuthority.ok) return racedReceiptAuthority;
    if (racedReceipt !== null) return duplicateReceipt(racedReceipt, prepared);
    const racedHead = await readHead(
      db,
      input.organisationId,
      input.workspaceId,
    );
    if (!expectedHead(input.baseRevision, racedHead))
      return baseConflict(racedHead);
    return { ok: false, error: { code: "workspace_revision_storage_failed" } };
  }

  const committedAuthority = await authorizeWorkspaceRevision(
    scope,
    prepared.authority,
  );
  if (!committedAuthority.ok) return committedAuthority;
  const persisted = await readReceiptByIdempotency(db, input);
  if (
    persisted === null ||
    persisted.request_digest !== prepared.requestDigest
  ) {
    return { ok: false, error: { code: "workspace_revision_storage_failed" } };
  }
  if (persisted.receipt_projection !== JSON.stringify(prepared.receipt)) {
    return {
      ok: false,
      error: { code: "workspace_revision_receipt_conflict" },
    };
  }
  const returnedAuthority = await authorizeWorkspaceRevision(
    scope,
    prepared.authority,
  );
  if (!returnedAuthority.ok) return returnedAuthority;
  return { ok: true, value: { kind: "committed", receipt: prepared.receipt } };
}

export async function verifyWorkspaceRevisionReceipt(
  scope: OrganisationExecutionScope,
  organisationId: string,
  receipt: WorkspaceRevisionReceipt,
): Promise<Result<WorkspaceRevisionReceipt, WorkspaceRevisionStoreError>> {
  if (!validOrganisationId(organisationId) || !validReceipt(receipt)) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  if (scope.organisationId !== organisationId)
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const row = await scope.database
    .withSession("first-primary")
    .prepare(
      `SELECT receipt.receipt_projection
     FROM organisation_placement placement
     LEFT JOIN workspace_revision_receipt receipt
       ON receipt.organisation_id = placement.organisation_id
      AND receipt.receipt_id = ?
     WHERE placement.organisation_id = ? AND placement.placement_epoch = ?
       AND placement.placement_cell_id = ? AND placement.fence_token = ?
       AND placement.status = 'active'
     LIMIT 1`,
    )
    .bind(
      receipt.receiptId,
      organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    )
    .first<{ receipt_projection: unknown }>();
  if (row === null)
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  if (row.receipt_projection === null) {
    return { ok: false, error: { code: "workspace_revision_receipt_missing" } };
  }
  const accepted =
    receipt.outcome === "accepted"
      ? receipt
      : { ...receipt, outcome: "accepted" as const };
  if (row.receipt_projection !== JSON.stringify(accepted)) {
    return {
      ok: false,
      error: { code: "workspace_revision_receipt_conflict" },
    };
  }
  return { ok: true, value: receipt };
}

/**
 * The current receipt of the organisation's default workspace, read with the
 * binding in one statement. Null means the workspace or its receipt is not
 * established or does not verify; the caller then takes the stepwise path,
 * which creates what is missing and reports what is wrong.
 */
export async function readEstablishedDefaultWorkspaceReceipt(
  db: OrganisationDatabase,
  organisationId: string,
): Promise<WorkspaceRevisionReceipt | null> {
  if (!validOrganisationId(organisationId)) return null;
  const row = await db
    .prepare(
      `SELECT
       workspace_revision_head.workspace_id,
       workspace_revision_head.revision_id,
       workspace_revision_head.canonical_head,
       workspace_revision_receipt.receipt_projection
     FROM organisation_default_workspace
     JOIN workspace_revision_head
       ON workspace_revision_head.organisation_id = organisation_default_workspace.organisation_id
      AND workspace_revision_head.workspace_id = organisation_default_workspace.workspace_id
     JOIN workspace_revision_receipt
       ON workspace_revision_receipt.organisation_id = workspace_revision_head.organisation_id
      AND workspace_revision_receipt.workspace_id = workspace_revision_head.workspace_id
      AND workspace_revision_receipt.revision_id = workspace_revision_head.revision_id
     WHERE organisation_default_workspace.organisation_id = ?
     ORDER BY workspace_revision_receipt.committed_at DESC
     LIMIT 1`,
    )
    .bind(organisationId)
    .first<CurrentWorkspaceReceiptRow & { workspace_id: string }>();
  if (row === null || !/^workspace_[A-Za-z0-9._:-]+$/.test(row.workspace_id))
    return null;
  const receipt = currentReceiptFromRow(row, row.workspace_id);
  return receipt.ok ? receipt.value : null;
}

export async function readCurrentWorkspaceRevisionReceipt(
  db: OrganisationDatabase,
  organisationId: string,
  workspaceId: WorkspaceId,
): Promise<Result<WorkspaceRevisionReceipt, WorkspaceRevisionStoreError>> {
  if (
    !validOrganisationId(organisationId) ||
    !/^workspace_[A-Za-z0-9._:-]+$/.test(workspaceId)
  ) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  const row = await db
    .prepare(
      `SELECT
       workspace_revision_head.revision_id,
       workspace_revision_head.canonical_head,
       workspace_revision_receipt.receipt_projection
     FROM workspace_revision_head
     JOIN workspace_revision_receipt
       ON workspace_revision_receipt.organisation_id = workspace_revision_head.organisation_id
      AND workspace_revision_receipt.workspace_id = workspace_revision_head.workspace_id
      AND workspace_revision_receipt.revision_id = workspace_revision_head.revision_id
     WHERE workspace_revision_head.organisation_id = ?
       AND workspace_revision_head.workspace_id = ?
     ORDER BY workspace_revision_receipt.committed_at DESC
     LIMIT 1`,
    )
    .bind(organisationId, workspaceId)
    .first<CurrentWorkspaceReceiptRow>();
  if (row === null) {
    return { ok: false, error: { code: "workspace_revision_receipt_missing" } };
  }
  return currentReceiptFromRow(row, workspaceId);
}

function currentReceiptFromRow(
  row: CurrentWorkspaceReceiptRow,
  workspaceId: string,
): Result<WorkspaceRevisionReceipt, WorkspaceRevisionStoreError> {
  let raw: unknown;
  try {
    raw = JSON.parse(row.receipt_projection);
  } catch {
    return {
      ok: false,
      error: { code: "workspace_revision_receipt_conflict" },
    };
  }
  const receipt = parseWorkspaceReceipt(raw);
  return receipt !== null &&
    receipt.workspaceId === workspaceId &&
    receipt.revision === row.revision_id &&
    receipt.canonicalHead === row.canonical_head
    ? { ok: true, value: receipt }
    : { ok: false, error: { code: "workspace_revision_receipt_conflict" } };
}

export async function workspaceRevisionArchiveKeys(
  db: OrganisationDatabase,
  archive: R2Bucket,
  organisationId: OrganisationId,
): Promise<Result<readonly string[], WorkspaceRevisionStoreError>> {
  const rows = await db
    .prepare(
      `SELECT workspace_id, revision_id, manifest_ref, changeset_ref, changeset_digest
     FROM workspace_revision WHERE organisation_id = ? ORDER BY workspace_id, revision_id`,
    )
    .bind(organisationId)
    .all<{
      workspace_id: string;
      revision_id: string;
      manifest_ref: string;
      changeset_ref: string;
      changeset_digest: string;
    }>();
  const keys = new Set<string>();
  for (const row of rows.results) {
    const revision = await readWorkspaceRevision(db, archive, {
      organisationId,
      workspaceId: row.workspace_id,
      revision: row.revision_id,
    });
    if (!revision.ok) return revision;
    if (
      !validWorkspaceObjectRef(
        row.changeset_ref,
        organisationId,
        row.workspace_id,
      ) ||
      !SHA256_PATTERN.test(row.changeset_digest)
    )
      return {
        ok: false,
        error: { code: "workspace_revision_storage_failed" },
      };
    const changeset = await readRevisionObject(archive, row.changeset_ref);
    if (!changeset.ok) return changeset;
    if ((await sha256Hex(changeset.value)) !== row.changeset_digest)
      return {
        ok: false,
        error: { code: "workspace_revision_object_corrupt" },
      };
    keys.add(row.manifest_ref);
    keys.add(row.changeset_ref);
  }
  return { ok: true, value: [...keys] };
}

export async function readWorkspaceRevision(
  db: OrganisationDatabase,
  archive: R2Bucket,
  input: {
    readonly organisationId: string;
    readonly workspaceId: WorkspaceId;
    readonly revision: WorkspaceRevision;
  },
): Promise<
  Result<WorkspaceRevisionMaterialization, WorkspaceRevisionStoreError>
> {
  if (
    !validOrganisationId(input.organisationId) ||
    !/^workspace_[A-Za-z0-9._:-]+$/.test(input.workspaceId) ||
    !validWorkspaceRevision(input.revision)
  ) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  const row = await db
    .prepare(
      `SELECT base_revision_id, canonical_head, manifest_ref, manifest_digest
     FROM workspace_revision
     WHERE organisation_id = ? AND workspace_id = ? AND revision_id = ?
     LIMIT 1`,
    )
    .bind(input.organisationId, input.workspaceId, input.revision)
    .first<WorkspaceRevisionRow>();
  if (row === null) {
    return { ok: false, error: { code: "workspace_revision_missing" } };
  }
  if (
    !SHA256_PATTERN.test(row.canonical_head) ||
    !SHA256_PATTERN.test(row.manifest_digest) ||
    (row.base_revision_id !== null &&
      !validWorkspaceRevision(row.base_revision_id)) ||
    !validWorkspaceObjectRef(
      row.manifest_ref,
      input.organisationId,
      input.workspaceId,
    )
  ) {
    return { ok: false, error: { code: "workspace_revision_storage_failed" } };
  }
  const bytes = await readRevisionObject(archive, row.manifest_ref);
  if (!bytes.ok) return bytes;
  if ((await sha256Hex(bytes.value)) !== row.manifest_digest) {
    return { ok: false, error: { code: "workspace_revision_object_corrupt" } };
  }
  const manifest = await parseManifest(bytes.value, {
    organisationId: input.organisationId,
    workspaceId: input.workspaceId,
    baseRevision: row.base_revision_id,
  });
  if (manifest === null) {
    return { ok: false, error: { code: "workspace_revision_object_corrupt" } };
  }
  return {
    ok: true,
    value: {
      revision: input.revision,
      canonicalHead: row.canonical_head,
      manifestDigest: row.manifest_digest,
      manifest,
    },
  };
}

function commitStatements(
  db: OrganisationDatabase,
  prepared: PreparedWorkspaceRevisionMutation,
  head: WorkspaceHeadRow | null,
): D1PreparedStatement[] {
  const input = prepared.input;
  const scope = prepared.scope;
  const insertRevision = db
    .prepare(
      `INSERT INTO workspace_revision (
       organisation_id, workspace_id, revision_id, base_revision_id, canonical_head,
       manifest_ref, manifest_digest, changeset_ref, changeset_digest,
       correlation_id, causation_projection, committed_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
       AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      input.organisationId,
      input.workspaceId,
      prepared.revision,
      input.baseRevision,
      input.canonicalHead,
      input.manifestRef,
      input.manifestDigest,
      input.changesetRef,
      input.changesetDigest,
      input.correlationId,
      JSON.stringify(input.causation),
      input.committedAt,
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    );
  const writeHead =
    head === null
      ? db
          .prepare(
            `INSERT INTO workspace_revision_head (
           organisation_id, workspace_id, revision_id, canonical_head, updated_at
         ) SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
           AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
          )
          .bind(
            input.organisationId,
            input.workspaceId,
            prepared.revision,
            input.canonicalHead,
            input.committedAt,
            scope.organisationId,
            scope.placement.placementEpoch,
            scope.placement.placementCellId,
            scope.fenceToken,
          )
      : db
          .prepare(
            `UPDATE workspace_revision_head
         SET revision_id = ?, canonical_head = ?, updated_at = ?
         WHERE organisation_id = ? AND workspace_id = ? AND revision_id = ?
           AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
             AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
          )
          .bind(
            prepared.revision,
            input.canonicalHead,
            input.committedAt,
            input.organisationId,
            input.workspaceId,
            input.baseRevision,
            scope.organisationId,
            scope.placement.placementEpoch,
            scope.placement.placementCellId,
            scope.fenceToken,
          );
  const insertReceipt = db
    .prepare(
      `INSERT INTO workspace_revision_receipt (
       organisation_id, workspace_id, idempotency_key, request_digest, receipt_id,
       revision_id, receipt_projection, committed_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
       AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      input.organisationId,
      input.workspaceId,
      input.idempotencyKey,
      prepared.requestDigest,
      prepared.receipt.receiptId,
      prepared.revision,
      JSON.stringify(prepared.receipt),
      input.committedAt,
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    );
  return [insertRevision, writeHead, insertReceipt];
}

async function normalizeProposal(proposal: WorkspaceRevisionProposal): Promise<
  Result<
    {
      readonly input: WorkspaceRevisionMutation;
      readonly manifestBytes: Uint8Array;
      readonly changesetBytes: Uint8Array;
    },
    WorkspaceRevisionStoreError
  >
> {
  if (!validProposalBase(proposal)) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  const manifest = await buildManifest(proposal, null);
  if (manifest === null) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  const manifestBytes = ENCODER.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > MAX_WORKSPACE_REVISION_OBJECT_BYTES) {
    return { ok: false, error: { code: "workspace_revision_input_invalid" } };
  }
  const manifestDigest = await sha256Hex(manifestBytes);
  const canonicalHead = manifestDigest;
  const changesetBytes = ENCODER.encode(
    JSON.stringify({ kind: "genesis", canonicalHead }),
  );
  const changesetDigest = await sha256Hex(changesetBytes);
  const manifestRef = workspaceObjectRef(
    proposal.organisationId,
    proposal.workspaceId,
    "manifests",
    manifestDigest,
  );
  const changesetRef = workspaceObjectRef(
    proposal.organisationId,
    proposal.workspaceId,
    "changesets",
    changesetDigest,
  );
  return {
    ok: true,
    value: {
      input: {
        organisationId: proposal.organisationId,
        workspaceId: proposal.workspaceId,
        baseRevision: null,
        idempotencyKey: proposal.idempotencyKey,
        canonicalHead,
        manifestRef,
        manifestDigest,
        changesetRef,
        changesetDigest,
        correlationId: proposal.correlationId,
        causation: proposal.causation,
        committedAt: proposal.committedAt,
      },
      manifestBytes,
      changesetBytes,
    },
  };
}

async function buildManifest(
  proposal: WorkspaceRevisionProposal,
  baseRevision: WorkspaceRevision | null,
): Promise<WorkspaceRevisionManifestV1 | null> {
  if (
    proposal.files.length === 0 ||
    proposal.files.length > MAX_WORKSPACE_FILES
  )
    return null;
  const candidates = [...proposal.files].sort(compareWorkspaceFileCandidate);
  const files: WorkspaceRevisionManifestFileV1[] = [];
  let previousPath: string | null = null;
  for (const candidate of candidates) {
    if (
      !validWorkspaceFileCandidate(candidate) ||
      candidate.path === previousPath
    )
      return null;
    const content = ENCODER.encode(candidate.content);
    if (content.byteLength > MAX_WORKSPACE_FILE_BYTES) return null;
    files.push({
      path: candidate.path,
      mediaType: candidate.mediaType,
      byteLength: content.byteLength,
      sha256: await sha256Hex(content),
      content: candidate.content,
    });
    previousPath = candidate.path;
  }
  return {
    schemaVersion: "workspace_revision_manifest.v1",
    organisationId: proposal.organisationId,
    workspaceId: proposal.workspaceId,
    baseRevision,
    files,
  };
}

async function storeRevisionObjects(
  archive: R2Bucket,
  prepared: PreparedWorkspaceRevisionMutation,
): Promise<Result<true, WorkspaceRevisionStoreError>> {
  try {
    const manifestAuthority = await authorizeWorkspaceRevision(
      prepared.scope,
      prepared.authority,
    );
    if (!manifestAuthority.ok) return manifestAuthority;
    await archive.put(prepared.input.manifestRef, prepared.manifestBytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: workspaceObjectMetadata(prepared, "manifest"),
    });
    const changesetAuthority = await authorizeWorkspaceRevision(
      prepared.scope,
      prepared.authority,
    );
    if (!changesetAuthority.ok) return changesetAuthority;
    await archive.put(prepared.input.changesetRef, prepared.changesetBytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: workspaceObjectMetadata(prepared, "changeset"),
    });
  } catch {
    return { ok: false, error: { code: "workspace_revision_storage_failed" } };
  }
  return verifyRevisionObjects(archive, prepared);
}

async function verifyRevisionObjects(
  archive: R2Bucket,
  prepared: PreparedWorkspaceRevisionMutation,
): Promise<Result<true, WorkspaceRevisionStoreError>> {
  const manifestAuthority = await authorizeWorkspaceRevision(
    prepared.scope,
    prepared.authority,
  );
  if (!manifestAuthority.ok) return manifestAuthority;
  const manifest = await readVerifiedObject(
    archive,
    prepared.input.manifestRef,
    prepared.input.manifestDigest,
    prepared.manifestBytes,
  );
  if (!manifest.ok) return manifest;
  const changesetAuthority = await authorizeWorkspaceRevision(
    prepared.scope,
    prepared.authority,
  );
  if (!changesetAuthority.ok) return changesetAuthority;
  return readVerifiedObject(
    archive,
    prepared.input.changesetRef,
    prepared.input.changesetDigest,
    prepared.changesetBytes,
  );
}

async function readVerifiedObject(
  archive: R2Bucket,
  objectRef: string,
  expectedDigest: Sha256Digest,
  expectedBytes: Uint8Array,
): Promise<Result<true, WorkspaceRevisionStoreError>> {
  const loaded = await readRevisionObject(archive, objectRef);
  if (!loaded.ok) return loaded;
  const bytes = loaded.value;
  if (
    !equalBytes(bytes, expectedBytes) ||
    (await sha256Hex(bytes)) !== expectedDigest
  ) {
    return { ok: false, error: { code: "workspace_revision_object_corrupt" } };
  }
  return { ok: true, value: true };
}

async function readRevisionObject(
  archive: R2Bucket,
  objectRef: string,
): Promise<Result<Uint8Array, WorkspaceRevisionStoreError>> {
  let object: R2ObjectBody | null;
  try {
    object = await archive.get(objectRef);
  } catch {
    return { ok: false, error: { code: "workspace_revision_storage_failed" } };
  }
  if (object === null) {
    return { ok: false, error: { code: "workspace_revision_object_missing" } };
  }
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > MAX_WORKSPACE_REVISION_OBJECT_BYTES
  ) {
    return { ok: false, error: { code: "workspace_revision_object_corrupt" } };
  }
  try {
    return { ok: true, value: new Uint8Array(await object.arrayBuffer()) };
  } catch {
    return { ok: false, error: { code: "workspace_revision_storage_failed" } };
  }
}

async function parseManifest(
  bytes: Uint8Array,
  identity: {
    readonly organisationId: string;
    readonly workspaceId: WorkspaceId;
    readonly baseRevision: WorkspaceRevision | null;
  },
): Promise<WorkspaceRevisionManifestV1 | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return null;
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== "workspace_revision_manifest.v1" ||
    raw.organisationId !== identity.organisationId ||
    raw.workspaceId !== identity.workspaceId ||
    raw.baseRevision !== identity.baseRevision ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0 ||
    raw.files.length > MAX_WORKSPACE_FILES
  ) {
    return null;
  }
  const files: WorkspaceRevisionManifestFileV1[] = [];
  let previousPath: string | null = null;
  for (const candidate of raw.files) {
    const parsed = await parseManifestFile(candidate);
    if (parsed === null || parsed.path === previousPath) return null;
    if (previousPath !== null && parsed.path.localeCompare(previousPath) <= 0)
      return null;
    files.push(parsed);
    previousPath = parsed.path;
  }
  return {
    schemaVersion: "workspace_revision_manifest.v1",
    organisationId: identity.organisationId,
    workspaceId: identity.workspaceId,
    baseRevision: identity.baseRevision,
    files,
  };
}

async function parseManifestFile(
  raw: unknown,
): Promise<WorkspaceRevisionManifestFileV1 | null> {
  if (
    !isRecord(raw) ||
    typeof raw.path !== "string" ||
    typeof raw.mediaType !== "string" ||
    typeof raw.byteLength !== "number" ||
    !Number.isSafeInteger(raw.byteLength) ||
    raw.byteLength < 0 ||
    raw.byteLength > MAX_WORKSPACE_FILE_BYTES ||
    typeof raw.sha256 !== "string" ||
    !SHA256_PATTERN.test(raw.sha256) ||
    typeof raw.content !== "string" ||
    !validWorkspaceFileCandidate({
      path: raw.path,
      mediaType: raw.mediaType,
      content: raw.content,
    })
  ) {
    return null;
  }
  const content = ENCODER.encode(raw.content);
  if (
    content.byteLength !== raw.byteLength ||
    (await sha256Hex(content)) !== raw.sha256
  ) {
    return null;
  }
  return {
    path: raw.path,
    mediaType: raw.mediaType,
    byteLength: raw.byteLength,
    sha256: raw.sha256,
    content: raw.content,
  };
}

function workspaceObjectMetadata(
  prepared: PreparedWorkspaceRevisionMutation,
  kind: "manifest" | "changeset",
): Record<string, string> {
  return {
    organisationId: prepared.input.organisationId,
    workspaceId: prepared.input.workspaceId,
    kind,
    sha256:
      kind === "manifest"
        ? prepared.input.manifestDigest
        : prepared.input.changesetDigest,
  };
}

function workspaceObjectRef(
  organisationId: string,
  workspaceId: WorkspaceId,
  kind: "manifests" | "changesets",
  digest: Sha256Digest,
): string {
  return `workspace-revisions/${organisationId}/${workspaceId}/${kind}/${digest}.json`;
}

function validWorkspaceObjectRef(
  value: string,
  organisationId: string,
  workspaceId: WorkspaceId,
): boolean {
  return (
    value.startsWith(`workspace-revisions/${organisationId}/${workspaceId}/`) &&
    value.endsWith(".json")
  );
}

function validProposalBase(proposal: WorkspaceRevisionProposal): boolean {
  return (
    validOrganisationId(proposal.organisationId) &&
    /^workspace_[A-Za-z0-9._:-]+$/.test(proposal.workspaceId) &&
    proposal.idempotencyKey.length > 0 &&
    proposal.correlationId.length > 0 &&
    validCausation(proposal.causation) &&
    Number.isSafeInteger(proposal.committedAt) &&
    proposal.committedAt >= 0
  );
}

function validWorkspaceFileCandidate(
  candidate: WorkspaceRevisionFileCandidate,
): boolean {
  return (
    candidate.path.length > 0 &&
    candidate.path.length <= 512 &&
    WORKSPACE_PATH_PATTERN.test(candidate.path) &&
    candidate.mediaType.length > 0 &&
    candidate.mediaType.length <= 128
  );
}

function compareWorkspaceFileCandidate(
  left: WorkspaceRevisionFileCandidate,
  right: WorkspaceRevisionFileCandidate,
): number {
  return left.path.localeCompare(right.path);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function prepareMutation(
  input: WorkspaceRevisionMutation,
): Promise<
  Omit<
    PreparedWorkspaceRevisionMutation,
    | typeof PREPARED_WORKSPACE_REVISION
    | "scope"
    | "authority"
    | "manifestBytes"
    | "changesetBytes"
  >
> {
  const requestDigest = await sha256Hex(
    JSON.stringify({
      organisationId: input.organisationId,
      workspaceId: input.workspaceId,
      baseRevision: input.baseRevision,
      idempotencyKey: input.idempotencyKey,
      canonicalHead: input.canonicalHead,
      manifestRef: input.manifestRef,
      manifestDigest: input.manifestDigest,
      changesetRef: input.changesetRef,
      changesetDigest: input.changesetDigest,
      correlationId: input.correlationId,
      causation: input.causation,
      committedAt: input.committedAt,
    }),
  );
  const revisionDigest = await sha256Hex(
    JSON.stringify({
      organisationId: input.organisationId,
      workspaceId: input.workspaceId,
      baseRevision: input.baseRevision,
      canonicalHead: input.canonicalHead,
      manifestDigest: input.manifestDigest,
      changesetDigest: input.changesetDigest,
    }),
  );
  const revision = `workspace_revision_${revisionDigest}`;
  const receipt: WorkspaceRevisionReceipt = {
    receiptId: `workspace_receipt_${requestDigest}`,
    outcome: "accepted",
    workspaceId: input.workspaceId,
    revision,
    canonicalHead: input.canonicalHead,
    correlationId: input.correlationId,
    causation: input.causation,
  };
  return { input, revision, receipt, requestDigest };
}

async function readReceiptByIdempotency(
  db: OrganisationDatabase,
  input: Pick<
    WorkspaceRevisionMutation,
    "organisationId" | "workspaceId" | "idempotencyKey"
  >,
): Promise<WorkspaceReceiptRow | null> {
  return db
    .prepare(
      `SELECT request_digest, receipt_projection
     FROM workspace_revision_receipt
     WHERE organisation_id = ? AND workspace_id = ? AND idempotency_key = ?
     LIMIT 1`,
    )
    .bind(input.organisationId, input.workspaceId, input.idempotencyKey)
    .first<WorkspaceReceiptRow>();
}

async function readHead(
  db: OrganisationDatabase,
  organisationId: string,
  workspaceId: WorkspaceId,
): Promise<WorkspaceHeadRow | null> {
  return db
    .prepare(
      `SELECT revision_id, canonical_head
     FROM workspace_revision_head
     WHERE organisation_id = ? AND workspace_id = ?
     LIMIT 1`,
    )
    .bind(organisationId, workspaceId)
    .first<WorkspaceHeadRow>();
}

function duplicateReceipt(
  row: WorkspaceReceiptRow,
  prepared: PreparedWorkspaceRevisionMutation,
): Result<WorkspaceRevisionCommitResult, WorkspaceRevisionStoreError> {
  if (row.request_digest !== prepared.requestDigest) {
    return {
      ok: false,
      error: { code: "workspace_revision_idempotency_conflict" },
    };
  }
  if (row.receipt_projection !== JSON.stringify(prepared.receipt)) {
    return {
      ok: false,
      error: { code: "workspace_revision_receipt_conflict" },
    };
  }
  return {
    ok: true,
    value: {
      kind: "duplicate",
      receipt: { ...prepared.receipt, outcome: "already_applied" },
    },
  };
}

function expectedHead(
  base: WorkspaceRevision | null,
  head: WorkspaceHeadRow | null,
): boolean {
  return base === null ? head === null : head?.revision_id === base;
}

function baseConflict(
  head: WorkspaceHeadRow | null,
): Result<WorkspaceRevisionCommitResult, WorkspaceRevisionStoreError> {
  return {
    ok: false,
    error: {
      code: "workspace_revision_base_conflict",
      currentRevision: head?.revision_id ?? null,
      currentHead: head?.canonical_head ?? null,
    },
  };
}

function validMutation(input: WorkspaceRevisionMutation): boolean {
  return (
    validOrganisationId(input.organisationId) &&
    /^workspace_[A-Za-z0-9._:-]+$/.test(input.workspaceId) &&
    (input.baseRevision === null ||
      validWorkspaceRevision(input.baseRevision)) &&
    input.idempotencyKey.length > 0 &&
    SHA256_PATTERN.test(input.canonicalHead) &&
    validWorkspaceObjectRef(
      input.manifestRef,
      input.organisationId,
      input.workspaceId,
    ) &&
    SHA256_PATTERN.test(input.manifestDigest) &&
    input.changesetRef.length > 0 &&
    SHA256_PATTERN.test(input.changesetDigest) &&
    input.correlationId.length > 0 &&
    validCausation(input.causation) &&
    Number.isSafeInteger(input.committedAt) &&
    input.committedAt >= 0
  );
}

function validReceipt(receipt: WorkspaceRevisionReceipt): boolean {
  return (
    receipt.receiptId.length > 0 &&
    validWorkspaceRevision(receipt.revision) &&
    SHA256_PATTERN.test(receipt.canonicalHead) &&
    receipt.correlationId.length > 0 &&
    validCausation(receipt.causation)
  );
}

export function parseWorkspaceReceipt(
  raw: unknown,
): WorkspaceRevisionReceipt | null {
  if (!isRecord(raw)) return null;
  const receiptId = nonEmptyString(raw.receiptId);
  const outcome =
    raw.outcome === "accepted" || raw.outcome === "already_applied"
      ? raw.outcome
      : null;
  const workspaceId = nonEmptyString(raw.workspaceId);
  const revision = nonEmptyString(raw.revision);
  const canonicalHead = sha256Value(raw.canonicalHead);
  const correlationId = nonEmptyString(raw.correlationId);
  const causation = parseCausation(raw.causation);
  return receiptId === null ||
    outcome === null ||
    workspaceId === null ||
    revision === null ||
    canonicalHead === null ||
    correlationId === null ||
    causation === null
    ? null
    : {
        receiptId,
        outcome,
        workspaceId,
        revision,
        canonicalHead,
        correlationId,
        causation,
      };
}

function parseCausation(raw: unknown): CausationRef | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "ingress": {
      const observationId = nonEmptyString(raw.observationId);
      return observationId === null ? null : { kind: "ingress", observationId };
    }
    case "schedule": {
      const scheduleId = nonEmptyString(raw.scheduleId);
      return scheduleId === null ? null : { kind: "schedule", scheduleId };
    }
    case "command": {
      const commandId = nonEmptyString(raw.commandId);
      return commandId === null ? null : { kind: "command", commandId };
    }
    case "event": {
      const eventId = nonEmptyString(raw.eventId);
      return eventId === null ? null : { kind: "event", eventId };
    }
    case "effect_receipt": {
      const receiptId = nonEmptyString(raw.receiptId);
      return receiptId === null ? null : { kind: "effect_receipt", receiptId };
    }
    case "migration": {
      const migrationId = nonEmptyString(raw.migrationId);
      return migrationId === null ? null : { kind: "migration", migrationId };
    }
    default:
      return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256Value(value: unknown): Sha256Digest | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

// Any identifier the Organisation boundary accepts, whatever its prefix.
function validOrganisationId(value: string): boolean {
  return parseOrganisationId(value).ok;
}

function validWorkspaceRevision(value: string): boolean {
  return /^workspace_revision_[0-9a-f]{64}$/.test(value);
}

function validCausation(causation: CausationRef): boolean {
  switch (causation.kind) {
    case "ingress":
      return causation.observationId.length > 0;
    case "schedule":
      return causation.scheduleId.length > 0;
    case "command":
      return causation.commandId.length > 0;
    case "event":
      return causation.eventId.length > 0;
    case "effect_receipt":
      return causation.receiptId.length > 0;
    case "migration":
      return causation.migrationId.length > 0;
  }
}
