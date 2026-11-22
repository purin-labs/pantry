import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

import type { CredentialVaultBindings } from "../credential-vault/keyring";
import { parseVaultHandle } from "../credential-vault/domain";
import { revokeVaultSecret } from "../credential-vault/service";
import { prepareCustomConnectorAccountsDisable } from "../data/integration-account-writes";
import { prepareCustomConnectorConnectionsDisable } from "../data/provider-connection-writes";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  CustomConnectorDefinitionDigest,
  CustomConnectorId,
  CustomConnectorRevision,
} from "./identity";
import {
  resolveCustomConnectorRevision,
  type CustomConnectorRevisionError,
  type CustomConnectorRevisionRecord,
} from "./revisions";
import { assertNever } from "@purin-labs/std";

type CustomConnectorLifecycleError = CustomConnectorRevisionError
  | { readonly code: "custom_connector_lifecycle_conflict" }
  | { readonly code: "custom_connector_cleanup_required" }
  | { readonly code: "custom_connector_persistence_corrupt" };

export async function retireCustomConnectorRevision(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly affectedIntegrationAccountIds: readonly string[];
  readonly retiredByUserId: UserId;
  readonly now: number;
}): Promise<Result<CustomConnectorRevisionRecord, CustomConnectorLifecycleError>> {
  const revision = await resolveCustomConnectorRevision(input);
  if (!revision.ok) return revision;
  if (
    revision.value.reviewState !== "approved" ||
    revision.value.definitionDigest !== input.definitionDigest
  ) {
    return conflict("custom_connector_revision_conflict");
  }
  const rows = await input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId
       FROM custom_connector_account_binding
       WHERE organisation_id = ? AND connector_id = ? AND accepted_revision = ?
         AND accepted_definition_digest = ? AND lifecycle != 'revoked'
       ORDER BY integration_account_id`,
    )
    .bind(input.organisationId, input.connectorId, input.revision, input.definitionDigest)
    .all<{ integrationAccountId: unknown }>();
  const expected = parseAffectedAccounts(rows.results);
  const acknowledged = [...input.affectedIntegrationAccountIds].sort();
  if (expected === null || !sameStrings(expected, acknowledged)) {
    return conflict("custom_connector_revision_conflict");
  }
  const result = await input.db
    .prepare(
      `UPDATE custom_connector_revision
       SET review_state = 'retired', retired_by_user_id = ?, retired_at = ?
       WHERE organisation_id = ? AND connector_id = ? AND revision = ?
         AND review_state = 'approved' AND definition_digest = ?`,
    )
    .bind(
      input.retiredByUserId,
      input.now,
      input.organisationId,
      input.connectorId,
      input.revision,
      input.definitionDigest,
    )
    .run();
  if (result.meta.changes !== 1) return conflict("custom_connector_revision_conflict");
  const stored = await resolveCustomConnectorRevision(input);
  return stored;
}

export async function disableCustomConnector(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly expectedHeadRevision: CustomConnectorRevision;
  readonly disabledByUserId: UserId;
  readonly now: number;
}): Promise<Result<{ readonly lifecycle: "disabled" }, CustomConnectorLifecycleError>> {
  const session = input.db.withSession("first-primary");
  let results: D1Result[];
  try {
    results = await session.batch([
      session.prepare(
        `UPDATE custom_connector SET lifecycle = 'disabled', updated_at = ?
         WHERE organisation_id = ? AND connector_id = ? AND head_revision = ?
           AND lifecycle IN ('draft', 'active')`,
      ).bind(input.now, input.organisationId, input.connectorId, input.expectedHeadRevision),
      prepareCustomConnectorAccountsDisable(session, {
        disabledByUserId: input.disabledByUserId,
        now: input.now,
        organisationId: input.organisationId,
        connectorId: input.connectorId,
      }),
      session.prepare(
        `UPDATE custom_connector_account_binding
         SET lifecycle = 'disabled', is_default_for_connector = 0,
             disabled_at = ?, updated_at = ?
         WHERE organisation_id = ? AND connector_id = ? AND lifecycle = 'active'`,
      ).bind(input.now, input.now, input.organisationId, input.connectorId),
      prepareCustomConnectorConnectionsDisable(session, {
        now: input.now,
        organisationId: input.organisationId,
        connectorId: input.connectorId,
      }),
    ]);
  } catch {
    return conflict("custom_connector_lifecycle_conflict");
  }
  return results[0]?.meta.changes === 1
    ? { ok: true, value: { lifecycle: "disabled" } }
    : conflict("custom_connector_lifecycle_conflict");
}

export async function resumeCustomConnector(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly expectedHeadRevision: CustomConnectorRevision;
  readonly now: number;
}): Promise<Result<{ readonly lifecycle: "active" }, CustomConnectorLifecycleError>> {
  const result = await input.db.prepare(
    `UPDATE custom_connector SET lifecycle = 'active', updated_at = ?
     WHERE organisation_id = ? AND connector_id = ? AND head_revision = ?
       AND lifecycle = 'disabled'`,
  ).bind(input.now, input.organisationId, input.connectorId, input.expectedHeadRevision).run();
  return result.meta.changes === 1
    ? { ok: true, value: { lifecycle: "active" } }
    : conflict("custom_connector_lifecycle_conflict");
}

export async function removeCustomConnector(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly expectedHeadRevision: CustomConnectorRevision;
  readonly now: number;
}): Promise<Result<{ readonly lifecycle: "removed" }, CustomConnectorLifecycleError>> {
  const state = await input.db.prepare(
    `SELECT connector.lifecycle,
       EXISTS (SELECT 1 FROM custom_connector_account_binding AS binding
         WHERE binding.organisation_id = connector.organisation_id
           AND binding.connector_id = connector.connector_id
           AND binding.lifecycle != 'revoked') AS hasAccounts
     FROM custom_connector AS connector
     WHERE connector.organisation_id = ? AND connector.connector_id = ?
       AND connector.head_revision = ?`,
  ).bind(input.organisationId, input.connectorId, input.expectedHeadRevision)
    .first<{ lifecycle: unknown; hasAccounts: unknown }>();
  if (state === null) return conflict("custom_connector_not_found");
  if (state.lifecycle !== "disabled") return conflict("custom_connector_lifecycle_conflict");
  if (state.hasAccounts !== 0) return conflict("custom_connector_cleanup_required");
  const candidates = await input.db.prepare(
    `SELECT candidate_credential_ref AS candidateCredentialRef
     FROM custom_connector_setup_attempt
     WHERE organisation_id = ? AND connector_id = ?
       AND lifecycle IN ('awaiting_credential', 'credential_stored', 'testing', 'verified')
       AND candidate_credential_ref IS NOT NULL`,
  ).bind(input.organisationId, input.connectorId)
    .all<{ candidateCredentialRef: unknown }>();
  for (const row of candidates.results) {
    if (typeof row.candidateCredentialRef !== "string") {
      return conflict("custom_connector_persistence_corrupt");
    }
    const handle = parseVaultHandle(row.candidateCredentialRef);
    if (!handle.ok) return conflict("custom_connector_persistence_corrupt");
    await revokeVaultSecret({
      db: input.db,
      organisationId: input.organisationId,
      handle: handle.value,
      now: input.now,
    });
  }
  const session = input.db.withSession("first-primary");
  let results: D1Result[];
  try {
    results = await session.batch([
      session.prepare(
        `UPDATE custom_connector_setup_attempt
         SET lifecycle = 'cancelled', attempt_revision = attempt_revision + 1,
             cancelled_by_user_id = created_by_user_id,
             completed_at = ?, updated_at = ?, tested_candidate_generation = NULL,
             test_started_at = NULL, verified_provider_account_id = NULL,
             verified_display_name = NULL, result_schema_digest = NULL, tested_at = NULL
         WHERE organisation_id = ? AND connector_id = ?
           AND lifecycle IN ('awaiting_credential', 'credential_stored', 'testing', 'verified')`,
      ).bind(input.now, input.now, input.organisationId, input.connectorId),
      session.prepare(
        `UPDATE custom_connector SET lifecycle = 'removed', updated_at = ?
         WHERE organisation_id = ? AND connector_id = ? AND head_revision = ?
           AND lifecycle = 'disabled'`,
      ).bind(input.now, input.organisationId, input.connectorId, input.expectedHeadRevision),
    ]);
  } catch {
    return conflict("custom_connector_lifecycle_conflict");
  }
  return results[1]?.meta.changes === 1
    ? { ok: true, value: { lifecycle: "removed" } }
    : conflict("custom_connector_lifecycle_conflict");
}

function parseAffectedAccounts(
  rows: readonly { readonly integrationAccountId: unknown }[],
): readonly string[] | null {
  const values: string[] = [];
  for (const row of rows) {
    if (typeof row.integrationAccountId !== "string") return null;
    values.push(row.integrationAccountId);
  }
  return values;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function conflict(
  code: CustomConnectorLifecycleError["code"],
): Result<never, CustomConnectorLifecycleError> {
  switch (code) {
    case "custom_connector_not_found":
      return { ok: false, error: { code } };
    case "custom_connector_revision_not_found":
      return { ok: false, error: { code } };
    case "custom_connector_revision_conflict":
      return { ok: false, error: { code } };
    case "custom_connector_lifecycle_conflict":
      return { ok: false, error: { code } };
    case "custom_connector_cleanup_required":
      return { ok: false, error: { code } };
    case "custom_connector_persistence_corrupt":
      return { ok: false, error: { code } };
    case "custom_connector_validation_failed":
    case "custom_connector_approval_review_mismatch":
      throw new Error("revision detail is required for this lifecycle error");
    default:
      return assertNever(code, "unexpected custom connector lifecycle code");
  }
}

