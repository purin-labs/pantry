import type { OrganisationDatabase } from "../../database-handles";
import type { Result } from "../../result";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type {
  FileContextProvider,
  FileGrantAdmission,
  FileGrantSyncState,
  ProviderFileCursor,
  ProviderFileRevision,
} from "@purin-labs/contracts";

import {
  parseOrganisationId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../ids";
import {
  ACTIVE_FILE_GRANT_VISIBILITY_SQL,
  fileExecutionFence,
} from "./authority-sql";
import {
  FILE_DAILY_SOURCE_BYTE_BUDGET,
  parseFileGrantSyncState,
  parseFileProjectionCommand,
  parseProviderFileCursor,
  type FileProjectionCommand,
} from "./domain";
import { isPositiveInteger } from "@purin-labs/std";

type FileGrantSyncRow = Readonly<{
  state: unknown;
  leaseId: unknown;
  leaseExpiresAt: unknown;
  startedAt: unknown;
  reconciledAt: unknown;
  attempt: unknown;
  reason: unknown;
  nextRunAt: unknown;
  observedFileCount: unknown;
  maxFileCount: unknown;
  cappedAt: unknown;
}>;

type FileCursorRow = Readonly<{ cursorJson: unknown }>;

export type FileResourceSourceMetadata = Readonly<{
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: FileContextProvider;
  readonly providerFileId: string;
  readonly providerRevision: ProviderFileRevision;
  readonly displayName: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly deepLink: string;
  readonly observedAt: number;
}>;

export type FileResourceSourceFact = FileResourceSourceMetadata &
  Readonly<{
    readonly sourceSequence: number;
  }>;

export type PendingFileProjectionOutboxEntry = Readonly<{
  readonly organisationId: OrganisationId;
  readonly outboxId: string;
  readonly command: FileProjectionCommand;
}>;

export type DueFileGrantReconciliation = Readonly<{
  readonly organisationId: OrganisationId;
  readonly grantId: string;
}>;

export type FileGrantSyncView = Readonly<{
  readonly grantId: string;
  readonly state: FileGrantSyncState;
}>;

export type FileExtractionBudgetReservation =
  | Readonly<{
      readonly kind: "inactive";
      readonly admittedSourceBytes?: never;
    }>
  | Readonly<{
      readonly kind: "reserved";
      readonly admittedSourceBytes: number;
    }>
  | Readonly<{
      readonly kind: "exhausted";
      readonly admittedSourceBytes: number;
    }>;

export async function initializeFileGrantSync(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly grantId: string;
    readonly grantRevision: number;
    readonly integrationAccountId: IntegrationAccountId;
    readonly nextRunAt: number;
    readonly now: number;
  }>,
): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO file_grant_sync (
       organisation_id, grant_id, grant_revision, integration_account_id, state,
       next_run_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (organisation_id, grant_id) DO UPDATE SET
       grant_revision = excluded.grant_revision,
       integration_account_id = excluded.integration_account_id,
       state = 'pending', lease_id = NULL, lease_expires_at = NULL,
       started_at = NULL, reconciled_at = NULL, attempt = NULL, reason = NULL,
       next_run_at = excluded.next_run_at, observed_file_count = NULL,
       max_file_count = NULL, capped_at = NULL, updated_at = excluded.updated_at`,
    )
    .bind(
      input.organisationId,
      input.grantId,
      input.grantRevision,
      input.integrationAccountId,
      input.nextRunAt,
      input.now,
    )
    .run();
}

export async function upsertFileResourceSource(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly metadata: FileResourceSourceMetadata;
    readonly now: number;
  }>,
): Promise<
  Result<
    FileResourceSourceFact,
    { readonly code: "organisation_execution_authority_inactive" }
  >
> {
  const fence = fileExecutionFence(input.scope);
  const revisionJson = JSON.stringify(input.metadata.providerRevision);
  const row = await input.scope.database
    .prepare(
      `INSERT INTO file_resource_source (
       organisation_id, integration_account_id, provider, provider_file_id,
       source_sequence, provider_revision_json, display_name, display_path,
       media_type, deep_link, content_state, content_digest, metadata_only_reason,
       segment_count, observed_at, updated_at
     ) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ? WHERE ${fence.sql}
     ON CONFLICT (organisation_id, integration_account_id, provider_file_id) DO UPDATE SET
       source_sequence = CASE
         WHEN file_resource_source.provider_revision_json <> excluded.provider_revision_json
         THEN file_resource_source.source_sequence + 1
         ELSE file_resource_source.source_sequence
       END,
       provider_revision_json = excluded.provider_revision_json,
       display_name = excluded.display_name,
       display_path = excluded.display_path,
       media_type = excluded.media_type,
       deep_link = excluded.deep_link,
       content_state = CASE
         WHEN file_resource_source.provider_revision_json <> excluded.provider_revision_json
         THEN 'pending'
         ELSE file_resource_source.content_state
       END,
       content_digest = CASE
         WHEN file_resource_source.provider_revision_json <> excluded.provider_revision_json
         THEN NULL ELSE file_resource_source.content_digest
       END,
       metadata_only_reason = CASE
         WHEN file_resource_source.provider_revision_json <> excluded.provider_revision_json
         THEN NULL ELSE file_resource_source.metadata_only_reason
       END,
       segment_count = CASE
         WHEN file_resource_source.provider_revision_json <> excluded.provider_revision_json
         THEN NULL ELSE file_resource_source.segment_count
       END,
       observed_at = excluded.observed_at,
       updated_at = excluded.updated_at
     RETURNING source_sequence AS sourceSequence`,
    )
    .bind(
      input.scope.organisationId,
      input.metadata.integrationAccountId,
      input.metadata.provider,
      input.metadata.providerFileId,
      revisionJson,
      input.metadata.displayName,
      input.metadata.displayPath,
      input.metadata.mediaType,
      input.metadata.deepLink,
      input.metadata.observedAt,
      input.now,
      ...fence.bindings,
    )
    .first<{ readonly sourceSequence: unknown }>();
  if (row === null)
    return {
      ok: false,
      error: { code: "organisation_execution_authority_inactive" },
    };
  if (!isPositiveInteger(row.sourceSequence)) {
    throw new Error("file_resource_source_sequence_invalid");
  }
  return {
    ok: true,
    value: { ...input.metadata, sourceSequence: row.sourceSequence },
  };
}

function fileMutationApplied(result: D1Result): boolean {
  return d1Changes(result) > 0;
}

export async function listPendingFileProjectionOutbox(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly limit: number;
  }>,
): Promise<readonly PendingFileProjectionOutboxEntry[]> {
  const rows = await input.db
    .prepare(
      `SELECT outbox_id AS outboxId, command_json AS commandJson
       FROM file_projection_outbox
      WHERE organisation_id = ? AND delivered_at IS NULL
      ORDER BY created_at, outbox_id LIMIT ?`,
    )
    .bind(input.organisationId, input.limit)
    .all<{
      readonly outboxId: unknown;
      readonly commandJson: unknown;
    }>();
  const entries: PendingFileProjectionOutboxEntry[] = [];
  for (const row of rows.results ?? []) {
    if (typeof row.outboxId !== "string" || typeof row.commandJson !== "string")
      continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.commandJson);
    } catch {
      continue;
    }
    const command = parseFileProjectionCommand(raw);
    if (command.ok) {
      entries.push({
        organisationId: input.organisationId,
        outboxId: row.outboxId,
        command: command.value,
      });
    }
  }
  return entries;
}

export async function listPendingFileProjectionOutboxGlobal(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly limit: number;
  }>,
): Promise<readonly PendingFileProjectionOutboxEntry[]> {
  const rows = await input.db
    .prepare(
      `SELECT organisation_id AS organisationId, outbox_id AS outboxId, command_json AS commandJson
       FROM file_projection_outbox
      WHERE delivered_at IS NULL
      ORDER BY created_at, organisation_id, outbox_id LIMIT ?`,
    )
    .bind(input.limit)
    .all<{
      readonly organisationId: unknown;
      readonly outboxId: unknown;
      readonly commandJson: unknown;
    }>();
  const entries: PendingFileProjectionOutboxEntry[] = [];
  for (const row of rows.results ?? []) {
    if (
      typeof row.organisationId !== "string" ||
      typeof row.outboxId !== "string" ||
      typeof row.commandJson !== "string"
    )
      continue;
    const organisationId = parseOrganisationId(row.organisationId);
    if (!organisationId.ok) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.commandJson);
    } catch {
      continue;
    }
    const command = parseFileProjectionCommand(raw);
    if (command.ok && command.value.organisationId === organisationId.value) {
      entries.push({
        organisationId: organisationId.value,
        outboxId: row.outboxId,
        command: command.value,
      });
    }
  }
  return entries;
}

export async function listDueFileGrantReconciliations(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly now: number;
    readonly limit: number;
  }>,
): Promise<readonly DueFileGrantReconciliation[]> {
  const rows = await input.db
    .prepare(
      `SELECT sync.organisation_id AS organisationId, sync.grant_id AS grantId
       FROM file_grant_sync AS sync
       JOIN access_grant AS grant
         ON grant.organisation_id = sync.organisation_id
        AND grant.grant_id = sync.grant_id
        AND grant.lifecycle = 'active'
        AND grant.revision = sync.grant_revision
      WHERE (
        (sync.state IN ('pending', 'ready', 'retry_wait') AND sync.next_run_at <= ?)
        OR (sync.state = 'reconciling' AND sync.lease_expires_at <= ?)
      )
      ORDER BY COALESCE(sync.next_run_at, sync.lease_expires_at), sync.organisation_id, sync.grant_id
      LIMIT ?`,
    )
    .bind(input.now, input.now, input.limit)
    .all<{
      readonly organisationId: unknown;
      readonly grantId: unknown;
    }>();
  const grants: DueFileGrantReconciliation[] = [];
  for (const row of rows.results ?? []) {
    if (
      typeof row.organisationId !== "string" ||
      typeof row.grantId !== "string" ||
      row.grantId.length === 0
    )
      continue;
    const organisationId = parseOrganisationId(row.organisationId);
    if (organisationId.ok)
      grants.push({
        organisationId: organisationId.value,
        grantId: row.grantId,
      });
  }
  return grants;
}

export async function markFileProjectionOutboxDelivered(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly outboxId: string;
    readonly deliveredAt: number;
  }>,
): Promise<boolean> {
  const fence = fileExecutionFence(input.scope);
  const result = await input.scope.database
    .prepare(
      `UPDATE file_projection_outbox SET delivered_at = ?
      WHERE organisation_id = ? AND outbox_id = ? AND delivered_at IS NULL AND ${fence.sql}`,
    )
    .bind(
      input.deliveredAt,
      input.scope.organisationId,
      input.outboxId,
      ...fence.bindings,
    )
    .run();
  return d1Changes(result) === 1;
}

export async function scheduleFileReconciliationHint(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
    readonly nextRunAt: number;
  }>,
): Promise<number> {
  const fence = fileExecutionFence(input.scope);
  const result = await input.scope.database
    .prepare(
      `UPDATE file_grant_sync
        SET state = CASE WHEN state = 'reconciling' THEN 'pending' ELSE state END,
            lease_id = CASE WHEN state = 'reconciling' THEN NULL ELSE lease_id END,
            lease_expires_at = CASE WHEN state = 'reconciling' THEN NULL ELSE lease_expires_at END,
            started_at = CASE WHEN state = 'reconciling' THEN NULL ELSE started_at END,
            next_run_at = CASE
              WHEN state = 'reconciling' OR next_run_at IS NULL OR next_run_at > ? THEN ?
              ELSE next_run_at
            END,
            updated_at = ?
      WHERE organisation_id = ? AND integration_account_id = ?
        AND state IN ('pending', 'reconciling', 'ready', 'retry_wait')
        AND ${fence.sql}`,
    )
    .bind(
      input.nextRunAt,
      input.nextRunAt,
      input.nextRunAt,
      input.scope.organisationId,
      input.integrationAccountId,
      ...fence.bindings,
    )
    .run();
  return d1Changes(result);
}

export function fileAccountErasureStatements(
  db: Pick<OrganisationDatabase, "prepare">,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "DELETE FROM context_projection WHERE organisation_id = ? AND source_kind = 'file_segment' AND json_extract(source_json, '$.integrationAccountId') = ?",
      )
      .bind(organisationId, integrationAccountId),
    db
      .prepare(
        "DELETE FROM file_projection_outbox WHERE organisation_id = ? AND integration_account_id = ?",
      )
      .bind(organisationId, integrationAccountId),
    db
      .prepare(
        "DELETE FROM file_provider_cursor WHERE organisation_id = ? AND integration_account_id = ?",
      )
      .bind(organisationId, integrationAccountId),
    db
      .prepare(
        "DELETE FROM file_grant_admission WHERE organisation_id = ? AND integration_account_id = ?",
      )
      .bind(organisationId, integrationAccountId),
    db
      .prepare(
        "DELETE FROM file_grant_sync WHERE organisation_id = ? AND integration_account_id = ?",
      )
      .bind(organisationId, integrationAccountId),
    db
      .prepare(
        "DELETE FROM file_extraction_budget WHERE organisation_id = ? AND integration_account_id = ?",
      )
      .bind(organisationId, integrationAccountId),
    db
      .prepare(
        "DELETE FROM file_resource_source WHERE organisation_id = ? AND integration_account_id = ?",
      )
      .bind(organisationId, integrationAccountId),
  ];
}

export async function claimFileGrantReconciliation(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly grantId: string;
    readonly leaseId: string;
    readonly startedAt: number;
    readonly leaseExpiresAt: number;
  }>,
): Promise<boolean> {
  const fence = fileExecutionFence(input.scope);
  const result = await input.scope.database
    .prepare(
      `UPDATE file_grant_sync
        SET state = 'reconciling', lease_id = ?, lease_expires_at = ?, started_at = ?,
            reconciled_at = NULL, attempt = NULL, reason = NULL, next_run_at = NULL,
            observed_file_count = NULL, max_file_count = NULL, capped_at = NULL,
            updated_at = ?
      WHERE organisation_id = ? AND grant_id = ?
        AND (
          (state IN ('pending', 'ready', 'retry_wait') AND next_run_at <= ?)
          OR (state = 'reconciling' AND lease_expires_at <= ?)
        ) AND ${fence.sql}`,
    )
    .bind(
      input.leaseId,
      input.leaseExpiresAt,
      input.startedAt,
      input.startedAt,
      input.scope.organisationId,
      input.grantId,
      input.startedAt,
      input.startedAt,
      ...fence.bindings,
    )
    .run();
  return d1Changes(result) === 1;
}

export async function settleFileGrantReady(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly grantId: string;
    readonly leaseId: string;
    readonly reconciledAt: number;
    readonly nextRunAt: number;
  }>,
): Promise<boolean> {
  return settleClaimedFileGrant(input, {
    kind: "ready",
    reconciledAt: input.reconciledAt,
    nextRunAt: input.nextRunAt,
  });
}

export async function settleFileGrantRetry(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly grantId: string;
    readonly leaseId: string;
    readonly attempt: number;
    readonly reason: string;
    readonly nextRunAt: number;
  }>,
): Promise<boolean> {
  return settleClaimedFileGrant(input, {
    kind: "retry_wait",
    attempt: input.attempt,
    reason: input.reason,
    nextRunAt: input.nextRunAt,
  });
}

export async function settleFileGrantCapped(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly grantId: string;
    readonly leaseId: string;
    readonly observedFileCount: number;
    readonly cappedAt: number;
  }>,
): Promise<boolean> {
  return settleClaimedFileGrant(input, {
    kind: "capped",
    observedFileCount: input.observedFileCount,
    maxFileCount: 1_000,
    cappedAt: input.cappedAt,
  });
}

export async function readFileGrantSync(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly grantId: string;
  }>,
): Promise<FileGrantSyncState | null> {
  const row = await input.db
    .prepare(
      `SELECT state, lease_id AS leaseId, lease_expires_at AS leaseExpiresAt,
            started_at AS startedAt, reconciled_at AS reconciledAt, attempt,
            reason, next_run_at AS nextRunAt,
            observed_file_count AS observedFileCount,
            max_file_count AS maxFileCount, capped_at AS cappedAt
       FROM file_grant_sync WHERE organisation_id = ? AND grant_id = ?`,
    )
    .bind(input.organisationId, input.grantId)
    .first<FileGrantSyncRow>();
  return row === null ? null : parseFileGrantSyncState(syncStateFromRow(row));
}

export async function listFileGrantSyncViews(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
  }>,
): Promise<readonly FileGrantSyncView[]> {
  const rows = await input.db
    .prepare(
      `SELECT grant_id AS grantId, state, lease_id AS leaseId,
            lease_expires_at AS leaseExpiresAt, started_at AS startedAt,
            reconciled_at AS reconciledAt, attempt, reason,
            next_run_at AS nextRunAt, observed_file_count AS observedFileCount,
            max_file_count AS maxFileCount, capped_at AS cappedAt
       FROM file_grant_sync WHERE organisation_id = ? ORDER BY grant_id`,
    )
    .bind(input.organisationId)
    .all<FileGrantSyncRow & Readonly<{ readonly grantId: unknown }>>();
  const views: FileGrantSyncView[] = [];
  for (const row of rows.results ?? []) {
    if (typeof row.grantId !== "string" || row.grantId.length === 0) continue;
    const state = parseFileGrantSyncState(syncStateFromRow(row));
    if (state !== null) views.push({ grantId: row.grantId, state });
  }
  return views;
}

export async function replaceFileGrantAdmissions(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly grantId: string;
    readonly grantRevision: number;
    readonly admissions: readonly FileGrantAdmission[];
    readonly admittedAt: number;
  }>,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    input.db
      .prepare(
        "DELETE FROM file_grant_admission WHERE organisation_id = ? AND grant_id = ?",
      )
      .bind(input.organisationId, input.grantId),
  ];
  for (const admission of input.admissions) {
    if (
      admission.grantId !== input.grantId ||
      admission.grantRevision !== input.grantRevision
    ) {
      throw new Error("file_grant_admission_identity_mismatch");
    }
    statements.push(
      input.db
        .prepare(
          `INSERT INTO file_grant_admission (
         organisation_id, grant_id, grant_revision, integration_account_id, provider,
         provider_file_id, containing_scope_key, provider_revision_json, admitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.organisationId,
          admission.grantId,
          admission.grantRevision,
          admission.integrationAccountId,
          admission.provider,
          admission.providerFileId,
          admission.containingScopeKey,
          JSON.stringify(admission.providerRevision),
          input.admittedAt,
        ),
    );
  }
  await input.db.batch(statements);
}

export async function commitFileCursorAndOutbox(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
    readonly scopeKey: string;
    readonly cursor: ProviderFileCursor;
    readonly commands: readonly Readonly<{
      readonly outboxId: string;
      readonly command: FileProjectionCommand;
    }>[];
    readonly now: number;
  }>,
): Promise<boolean> {
  const fence = fileExecutionFence(input.scope);
  const statements: D1PreparedStatement[] = [
    input.scope.database
      .prepare(
        `INSERT INTO file_provider_cursor (
         organisation_id, integration_account_id, scope_key, cursor_json, updated_at
       ) SELECT ?, ?, ?, ?, ? WHERE ${fence.sql}
       ON CONFLICT (organisation_id, integration_account_id, scope_key) DO UPDATE SET
         cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`,
      )
      .bind(
        input.scope.organisationId,
        input.integrationAccountId,
        input.scopeKey,
        JSON.stringify(input.cursor),
        input.now,
        ...fence.bindings,
      ),
  ];
  for (const entry of input.commands) {
    if (
      entry.command.organisationId !== input.scope.organisationId ||
      entry.command.integrationAccountId !== input.integrationAccountId
    ) {
      throw new Error("file_projection_outbox_identity_mismatch");
    }
    statements.push(
      input.scope.database
        .prepare(
          `INSERT INTO file_projection_outbox (
         organisation_id, outbox_id, integration_account_id, grant_id, grant_revision,
         provider_file_id, source_sequence, command_json, created_at, delivered_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${fence.sql}
       ON CONFLICT (organisation_id, outbox_id) DO NOTHING`,
        )
        .bind(
          input.scope.organisationId,
          entry.outboxId,
          input.integrationAccountId,
          entry.command.grantId,
          entry.command.grantRevision,
          entry.command.providerFileId,
          entry.command.sourceSequence,
          JSON.stringify(entry.command),
          input.now,
          ...fence.bindings,
        ),
    );
  }
  const results = await input.scope.database.batch(statements);
  return results.some(fileMutationApplied);
}

export async function commitFileGrantReconciliation(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly grantId: string;
    readonly grantRevision: number;
    readonly integrationAccountId: IntegrationAccountId;
    readonly scopeKey: string;
    readonly cursor: ProviderFileCursor;
    readonly admissions: readonly FileGrantAdmission[];
    readonly commands: readonly Readonly<{
      readonly outboxId: string;
      readonly command: FileProjectionCommand;
    }>[];
    readonly now: number;
  }>,
): Promise<boolean> {
  const fence = fileExecutionFence(input.scope);
  const statements: D1PreparedStatement[] = [
    input.scope.database
      .prepare(
        `DELETE FROM file_grant_admission WHERE organisation_id = ? AND grant_id = ? AND ${fence.sql}`,
      )
      .bind(input.scope.organisationId, input.grantId, ...fence.bindings),
  ];
  for (const admission of input.admissions) {
    if (
      admission.grantId !== input.grantId ||
      admission.grantRevision !== input.grantRevision ||
      admission.integrationAccountId !== input.integrationAccountId
    ) {
      throw new Error("file_grant_reconciliation_admission_identity_mismatch");
    }
    statements.push(
      input.scope.database
        .prepare(
          `INSERT INTO file_grant_admission (
         organisation_id, grant_id, grant_revision, integration_account_id, provider,
         provider_file_id, containing_scope_key, provider_revision_json, admitted_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${fence.sql}`,
        )
        .bind(
          input.scope.organisationId,
          admission.grantId,
          admission.grantRevision,
          admission.integrationAccountId,
          admission.provider,
          admission.providerFileId,
          admission.containingScopeKey,
          JSON.stringify(admission.providerRevision),
          input.now,
          ...fence.bindings,
        ),
    );
  }
  statements.push(
    prepareSupersedeUnadmittedFileProjections({
      db: input.scope.database,
      organisationId: input.scope.organisationId,
      integrationAccountId: input.integrationAccountId,
      condition: ` AND ${fence.sql}`,
      bindings: fence.bindings,
      reason: "provider_resource_unavailable",
      now: input.now,
    }),
  );
  statements.push(
    input.scope.database
      .prepare(
        `INSERT INTO file_provider_cursor (
       organisation_id, integration_account_id, scope_key, cursor_json, updated_at
     ) SELECT ?, ?, ?, ?, ? WHERE ${fence.sql}
     ON CONFLICT (organisation_id, integration_account_id, scope_key) DO UPDATE SET
       cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`,
      )
      .bind(
        input.scope.organisationId,
        input.integrationAccountId,
        input.scopeKey,
        JSON.stringify(input.cursor),
        input.now,
        ...fence.bindings,
      ),
  );
  for (const entry of input.commands) {
    if (
      entry.command.organisationId !== input.scope.organisationId ||
      entry.command.grantId !== input.grantId ||
      entry.command.grantRevision !== input.grantRevision ||
      entry.command.integrationAccountId !== input.integrationAccountId
    ) {
      throw new Error("file_grant_reconciliation_command_identity_mismatch");
    }
    statements.push(
      input.scope.database
        .prepare(
          `INSERT INTO file_projection_outbox (
         organisation_id, outbox_id, integration_account_id, grant_id, grant_revision,
         provider_file_id, source_sequence, command_json, created_at, delivered_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${fence.sql}
       ON CONFLICT (organisation_id, outbox_id) DO NOTHING`,
        )
        .bind(
          input.scope.organisationId,
          entry.outboxId,
          input.integrationAccountId,
          input.grantId,
          input.grantRevision,
          entry.command.providerFileId,
          entry.command.sourceSequence,
          JSON.stringify(entry.command),
          input.now,
          ...fence.bindings,
        ),
    );
  }
  const results = await input.scope.database.batch(statements);
  return results.some(fileMutationApplied);
}

export async function commitFileGrantUnavailable(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly grantId: string;
    readonly integrationAccountId: IntegrationAccountId;
    readonly now: number;
  }>,
): Promise<void> {
  const fence = fileExecutionFence(input.scope);
  await input.scope.database.batch([
    input.scope.database
      .prepare(
        `DELETE FROM file_grant_admission WHERE organisation_id = ? AND grant_id = ? AND ${fence.sql}`,
      )
      .bind(input.scope.organisationId, input.grantId, ...fence.bindings),
    prepareSupersedeUnadmittedFileProjections({
      db: input.scope.database,
      organisationId: input.scope.organisationId,
      integrationAccountId: input.integrationAccountId,
      condition: ` AND ${fence.sql}`,
      bindings: fence.bindings,
      reason: "provider_resource_unavailable",
      now: input.now,
    }),
  ]);
}

export function prepareRevokedFileGrantCleanup(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    receiptId: string;
    grantId: string;
    integrationAccountId: IntegrationAccountId;
    now: number;
  }>,
): D1PreparedStatement[] {
  // Cleanup follows receipt settlement in the same batch. Its row counts vary,
  // so each statement checks the committed operation and its placement directly.
  const condition = ` AND EXISTS (
    SELECT 1 FROM control_mutation_receipt WHERE receipt_id = ? AND organisation_scope = ?
      AND operation = 'access_control.grant.revoke'
      AND json_extract(response_body, '$.grant.grantId') = ?
  ) AND EXISTS (
    SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
      AND placement_cell_id = ? AND fence_token = ? AND status = 'active'
  )`;
  const bindings = [
    input.receiptId,
    input.scope.organisationId,
    input.grantId,
    input.scope.organisationId,
    input.scope.placement.placementEpoch,
    input.scope.placement.placementCellId,
    input.scope.fenceToken,
  ];
  const db = input.scope.database;
  return [
    db
      .prepare(
        `DELETE FROM file_grant_admission WHERE organisation_id = ? AND grant_id = ?${condition}`,
      )
      .bind(input.scope.organisationId, input.grantId, ...bindings),
    db
      .prepare(
        `DELETE FROM file_grant_sync WHERE organisation_id = ? AND grant_id = ?${condition}`,
      )
      .bind(input.scope.organisationId, input.grantId, ...bindings),
    prepareSupersedeUnadmittedFileProjections({
      db,
      organisationId: input.scope.organisationId,
      integrationAccountId: input.integrationAccountId,
      reason: "grant_revoked",
      now: input.now,
      condition,
      bindings,
    }),
  ];
}

export function supersedeUnadmittedFileProjectionsStatement(
  input: Readonly<{
    db: Pick<OrganisationDatabase, "prepare">;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    reason: "provider_resource_unavailable" | "grant_revoked";
    now: number;
  }>,
): D1PreparedStatement {
  return prepareSupersedeUnadmittedFileProjections({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    reason: input.reason,
    now: input.now,
    condition: "",
    bindings: [],
  });
}

function prepareSupersedeUnadmittedFileProjections(
  input: Readonly<{
    readonly db: Pick<OrganisationDatabase, "prepare">;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly reason: "provider_resource_unavailable" | "grant_revoked";
    readonly now: number;
    readonly condition: string;
    readonly bindings: readonly (string | number)[];
  }>,
): D1PreparedStatement {
  return input.db
    .prepare(
      `UPDATE context_projection AS projection
        SET lifecycle = 'superseded', content_digest = NULL, indexed_at = NULL,
            bounded_text = NULL, enqueued_at = NULL, failed_at = NULL,
            failure_reason = NULL, retry_at = NULL, superseded_at = ?,
            superseded_reason = ?, updated_at = ?
      WHERE projection.organisation_id = ? AND projection.source_kind = 'file_segment'
        AND json_extract(projection.source_json, '$.integrationAccountId') = ?
        AND projection.lifecycle <> 'superseded'
        AND NOT EXISTS (
          SELECT 1
            FROM file_grant_admission AS admission
            JOIN access_grant AS grant_record
              ON grant_record.organisation_id = admission.organisation_id
             AND grant_record.grant_id = admission.grant_id
             AND grant_record.revision = admission.grant_revision
           WHERE admission.organisation_id = projection.organisation_id
             AND admission.integration_account_id = ?
             AND admission.provider_file_id = projection.provider_file_id
             AND grant_record.lifecycle = 'active'
             AND ${ACTIVE_FILE_GRANT_VISIBILITY_SQL} = projection.visibility_key
        )${input.condition}`,
    )
    .bind(
      input.now,
      input.reason,
      input.now,
      input.organisationId,
      input.integrationAccountId,
      input.integrationAccountId,
      ...input.bindings,
    );
}

export async function readFileProviderCursor(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly scopeKey: string;
  }>,
): Promise<ProviderFileCursor | null> {
  const row = await input.db
    .prepare(
      `SELECT cursor_json AS cursorJson FROM file_provider_cursor
      WHERE organisation_id = ? AND integration_account_id = ? AND scope_key = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId, input.scopeKey)
    .first<FileCursorRow>();
  if (row === null || typeof row.cursorJson !== "string") return null;
  try {
    return parseProviderFileCursor(JSON.parse(row.cursorJson));
  } catch {
    return null;
  }
}

export async function reserveFileExtractionBudget(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
    readonly utcDay: string;
    readonly sourceBytes: number;
    readonly now: number;
  }>,
): Promise<FileExtractionBudgetReservation> {
  const fence = fileExecutionFence(input.scope);
  const reserved = await input.scope.database
    .prepare(
      `INSERT INTO file_extraction_budget (
       organisation_id, integration_account_id, utc_day, admitted_source_bytes,
       maximum_source_bytes, updated_at
     ) SELECT ?, ?, ?, ?, ?, ? WHERE ${fence.sql}
     ON CONFLICT (organisation_id, integration_account_id, utc_day) DO UPDATE SET
       admitted_source_bytes = admitted_source_bytes + excluded.admitted_source_bytes,
       updated_at = excluded.updated_at
     WHERE maximum_source_bytes = excluded.maximum_source_bytes
       AND admitted_source_bytes + excluded.admitted_source_bytes <= maximum_source_bytes
     RETURNING admitted_source_bytes AS admittedSourceBytes`,
    )
    .bind(
      input.scope.organisationId,
      input.integrationAccountId,
      input.utcDay,
      input.sourceBytes,
      FILE_DAILY_SOURCE_BYTE_BUDGET,
      input.now,
      ...fence.bindings,
    )
    .first<{ readonly admittedSourceBytes: unknown }>();
  const row =
    reserved ??
    (await input.scope.database
      .prepare(
        `SELECT admitted_source_bytes AS admittedSourceBytes
       FROM file_extraction_budget
      WHERE organisation_id = ? AND integration_account_id = ? AND utc_day = ?
        AND ${fence.sql}`,
      )
      .bind(
        input.scope.organisationId,
        input.integrationAccountId,
        input.utcDay,
        ...fence.bindings,
      )
      .first<{ readonly admittedSourceBytes: unknown }>());
  if (row === null && !(await input.scope.isActive())) {
    return { kind: "inactive" };
  }
  if (
    row === null ||
    !Number.isSafeInteger(row.admittedSourceBytes) ||
    typeof row.admittedSourceBytes !== "number"
  ) {
    throw new Error("file_extraction_budget_invalid");
  }
  if (reserved !== null) {
    return { kind: "reserved", admittedSourceBytes: row.admittedSourceBytes };
  }
  return { kind: "exhausted", admittedSourceBytes: row.admittedSourceBytes };
}

async function settleClaimedFileGrant(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly grantId: string;
    readonly leaseId: string;
  }>,
  state: Exclude<
    FileGrantSyncState,
    { readonly kind: "pending" | "reconciling" }
  >,
): Promise<boolean> {
  const columns = syncStateColumns(state);
  const fence = fileExecutionFence(input.scope);
  const result = await input.scope.database
    .prepare(
      `UPDATE file_grant_sync
        SET state = ?, lease_id = NULL, lease_expires_at = NULL, started_at = NULL,
            reconciled_at = ?, attempt = ?, reason = ?, next_run_at = ?,
            observed_file_count = ?, max_file_count = ?, capped_at = ?, updated_at = ?
      WHERE organisation_id = ? AND grant_id = ? AND state = 'reconciling' AND lease_id = ? AND ${fence.sql}`,
    )
    .bind(
      state.kind,
      columns.reconciledAt,
      columns.attempt,
      columns.reason,
      columns.nextRunAt,
      columns.observedFileCount,
      columns.maxFileCount,
      columns.cappedAt,
      columns.updatedAt,
      input.scope.organisationId,
      input.grantId,
      input.leaseId,
      ...fence.bindings,
    )
    .run();
  return d1Changes(result) === 1;
}

function syncStateColumns(
  state: Exclude<
    FileGrantSyncState,
    { readonly kind: "pending" | "reconciling" }
  >,
): Readonly<{
  readonly reconciledAt: number | null;
  readonly attempt: number | null;
  readonly reason: string | null;
  readonly nextRunAt: number | null;
  readonly observedFileCount: number | null;
  readonly maxFileCount: number | null;
  readonly cappedAt: number | null;
  readonly updatedAt: number;
}> {
  switch (state.kind) {
    case "ready":
      return {
        reconciledAt: state.reconciledAt,
        attempt: null,
        reason: null,
        nextRunAt: state.nextRunAt,
        observedFileCount: null,
        maxFileCount: null,
        cappedAt: null,
        updatedAt: state.reconciledAt,
      };
    case "retry_wait":
      return {
        reconciledAt: null,
        attempt: state.attempt,
        reason: state.reason,
        nextRunAt: state.nextRunAt,
        observedFileCount: null,
        maxFileCount: null,
        cappedAt: null,
        updatedAt: state.nextRunAt,
      };
    case "capped":
      return {
        reconciledAt: null,
        attempt: null,
        reason: null,
        nextRunAt: null,
        observedFileCount: state.observedFileCount,
        maxFileCount: state.maxFileCount,
        cappedAt: state.cappedAt,
        updatedAt: state.cappedAt,
      };
  }
}

function syncStateFromRow(row: FileGrantSyncRow): unknown {
  switch (row.state) {
    case "pending":
      return { kind: row.state, nextRunAt: row.nextRunAt };
    case "reconciling":
      return {
        kind: row.state,
        leaseId: row.leaseId,
        leaseExpiresAt: row.leaseExpiresAt,
        startedAt: row.startedAt,
      };
    case "ready":
      return {
        kind: row.state,
        reconciledAt: row.reconciledAt,
        nextRunAt: row.nextRunAt,
      };
    case "retry_wait":
      return {
        kind: row.state,
        attempt: row.attempt,
        reason: row.reason,
        nextRunAt: row.nextRunAt,
      };
    case "capped":
      return {
        kind: row.state,
        observedFileCount: row.observedFileCount,
        maxFileCount: row.maxFileCount,
        cappedAt: row.cappedAt,
      };
    default:
      return null;
  }
}

function d1Changes(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

/**
 * Adds the pending sync of an active file grant at its current revision,
 * when the statement before it in the batch changed one row.
 */
export function prepareChangedFileGrantSync(
  db: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{
    organisationId: string;
    grantId: string;
    integrationAccountId: string;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO file_grant_sync (
       organisation_id, grant_id, grant_revision, integration_account_id,
       state, next_run_at, updated_at
     )
     SELECT organisation_id, grant_id, revision, ?, 'pending', ?, ?
       FROM access_grant
      WHERE organisation_id = ? AND grant_id = ? AND lifecycle = 'active' AND changes() = 1`,
    )
    .bind(
      input.integrationAccountId,
      input.now,
      input.now,
      input.organisationId,
      input.grantId,
    );
}

/** Adds the pending sync of a new file grant at its first revision. */
export function prepareNewFileGrantSync(
  db: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{
    organisationId: string;
    grantId: string;
    integrationAccountId: string;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO file_grant_sync (
             organisation_id, grant_id, grant_revision, integration_account_id,
             state, next_run_at, updated_at
           ) VALUES (?, ?, 1, ?, 'pending', ?, ?)`,
    )
    .bind(
      input.organisationId,
      input.grantId,
      input.integrationAccountId,
      input.now,
      input.now,
    );
}

/** Deletes the admissions and then the sync of a revoked file grant. */
export function prepareRevokedFileGrantRows(
  db: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{ organisationId: string; grantId: string }>,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "DELETE FROM file_grant_admission WHERE organisation_id = ? AND grant_id = ?",
      )
      .bind(input.organisationId, input.grantId),
    db
      .prepare(
        "DELETE FROM file_grant_sync WHERE organisation_id = ? AND grant_id = ?",
      )
      .bind(input.organisationId, input.grantId),
  ];
}
