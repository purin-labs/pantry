import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { isSha256Hex } from "@purin-labs/std";
import type {
  EmailAccountRegistration,
  EmailIdentityClaimant,
  EmailIdentityClaimQuery,
  EmailOperationalDirectoryError,
} from "@purin-labs/area-inbox-contract/server/connection-parts";
import type { SupplierEmailContactRegistration } from "@purin-labs/area-inbox-contract/server/inbox-services";
import type { OperationalEmailTarget } from "@purin-labs/area-inbox-contract/server/verified-contacts";

export type { OperationalEmailTarget } from "@purin-labs/area-inbox-contract/server/verified-contacts";

import type { EmailProposalTarget } from "@purin-labs/area-inbox-contract/server/email-review";

export type {
  EmailProposalTarget,
  EmailSelfTestTarget,
} from "@purin-labs/area-inbox-contract/server/email-review";

type OperationalEmailContact = Readonly<{
  readonly organisationId: OrganisationId;
  readonly target: OperationalEmailTarget;
  readonly address: string;
  readonly displayName: string | null;
  readonly state: "active" | "suppressed";
  readonly relationshipState: "active" | "inactive";
  readonly updatedAt: number;
}>;

type EmailSenderAccount = Readonly<{
  readonly integrationAccountId: IntegrationAccountId;
  readonly organisationId: OrganisationId;
  readonly environment: "development" | "production";
  readonly googleSubject: string;
  readonly observedAddress: string;
  readonly addressObservedAt: number;
}>;

export type EmailOperationalProposalProjectionLifecycle =
  | "awaiting_approval"
  | "sent"
  | "send_indeterminate"
  | "rejected"
  | "expired"
  | "superseded"
  | "revoked"
  | "operator_attested_present"
  | "operator_attested_absent";

export type EmailOperationalProposalProjection = Readonly<{
  readonly proposalId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly caseId: string;
  readonly target: EmailProposalTarget;
  readonly currentVersion: number;
  readonly targetDigest: string;
  readonly subjectDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly lifecycleKind: EmailOperationalProposalProjectionLifecycle;
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly indeterminateRfcMessageId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}>;

type EmailOperationalProposalProjectionError = Readonly<{
  readonly code:
    | "email_operational_projection_write_failed"
    | "email_operational_attestation_conflict"
    | "organisation_placement_conflict";
}>;

export async function recordOperationalEmailAttestation(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly proposalId: string;
    readonly attestation: "present" | "absent";
    readonly attestedBy: string;
    readonly attestedAt: number;
  }>,
): Promise<Result<null, EmailOperationalProposalProjectionError>> {
  const lifecycleKind =
    input.attestation === "present"
      ? "operator_attested_present"
      : "operator_attested_absent";
  try {
    const results = await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO email_operational_attestation (
             organisation_id, proposal_id, attestation,
             attested_by_user_id, attested_at
           )
           SELECT ?, ?, ?, ?, ?
           FROM email_operational_proposal_projection
           WHERE organisation_id = ? AND proposal_id = ?
             AND lifecycle_kind = 'send_indeterminate'
           ON CONFLICT (organisation_id, proposal_id) DO NOTHING`,
        )
        .bind(
          input.organisationId,
          input.proposalId,
          input.attestation,
          input.attestedBy,
          input.attestedAt,
          input.organisationId,
          input.proposalId,
        ),
      input.db
        .prepare(
          `UPDATE email_operational_proposal_projection
           SET lifecycle_kind = ?, updated_at = ?
           WHERE organisation_id = ? AND proposal_id = ?
             AND lifecycle_kind = 'send_indeterminate'`,
        )
        .bind(
          lifecycleKind,
          input.attestedAt,
          input.organisationId,
          input.proposalId,
        ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      return {
        ok: false,
        error: { code: "email_operational_attestation_conflict" },
      };
    }
    return { ok: true, value: null };
  } catch {
    return {
      ok: false,
      error: { code: "email_operational_projection_write_failed" },
    };
  }
}

export async function projectEmailOperationalProposal(input: {
  readonly scope: OrganisationExecutionScope;
  readonly integrationAccountId: IntegrationAccountId;
  readonly proposalId: string;
  readonly caseId: string;
  readonly target: EmailProposalTarget;
  readonly currentVersion: number;
  readonly targetDigest: string;
  readonly subjectDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly lifecycleKind: EmailOperationalProposalProjectionLifecycle;
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly indeterminateRfcMessageId: string | null;
  readonly createdAt: number;
  readonly now: number;
}): Promise<Result<null, EmailOperationalProposalProjectionError>> {
  if (
    !isSha256Hex(input.targetDigest) ||
    !isSha256Hex(input.subjectDigest) ||
    !isSha256Hex(input.bodyDigest) ||
    !isSha256Hex(input.snapshotDigest) ||
    input.currentVersion <= 0 ||
    input.now < input.createdAt ||
    !parseEmailProposalTarget(input.target)
  ) {
    return {
      ok: false,
      error: { code: "email_operational_projection_write_failed" },
    };
  }
  try {
    const db = input.scope.database.withSession("first-primary");
    const statement = db
      .prepare(
        `INSERT INTO email_operational_proposal_projection (
           proposal_id, organisation_id, integration_account_id, case_id, target_json,
           current_version, target_digest, subject_digest, body_digest,
           snapshot_digest, lifecycle_kind, provider_message_id, provider_thread_id,
           indeterminate_rfc_message_id, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
           AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')
         ON CONFLICT (proposal_id) DO UPDATE SET
           integration_account_id = excluded.integration_account_id,
           case_id = excluded.case_id,
           target_json = excluded.target_json,
           current_version = excluded.current_version,
           target_digest = excluded.target_digest,
           subject_digest = excluded.subject_digest,
           body_digest = excluded.body_digest,
           snapshot_digest = excluded.snapshot_digest,
           lifecycle_kind = CASE
             WHEN email_operational_proposal_projection.lifecycle_kind IN (
               'operator_attested_present', 'operator_attested_absent'
             ) AND excluded.lifecycle_kind = 'send_indeterminate'
             THEN email_operational_proposal_projection.lifecycle_kind
             ELSE excluded.lifecycle_kind
           END,
           provider_message_id = excluded.provider_message_id,
           provider_thread_id = excluded.provider_thread_id,
           indeterminate_rfc_message_id = excluded.indeterminate_rfc_message_id,
           updated_at = excluded.updated_at
         WHERE email_operational_proposal_projection.organisation_id = excluded.organisation_id
           AND excluded.current_version >= email_operational_proposal_projection.current_version`,
      )
      .bind(
        input.proposalId,
        input.scope.organisationId,
        input.integrationAccountId,
        input.caseId,
        JSON.stringify(input.target),
        input.currentVersion,
        input.targetDigest,
        input.subjectDigest,
        input.bodyDigest,
        input.snapshotDigest,
        input.lifecycleKind,
        input.providerMessageId,
        input.providerThreadId,
        input.indeterminateRfcMessageId,
        input.createdAt,
        input.now,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      );
    const statements = [statement];
    if (
      input.target.kind === "self_test" &&
      input.lifecycleKind !== "awaiting_approval"
    ) {
      statements.push(
        db
          .prepare(
            `DELETE FROM email_self_test WHERE organisation_id = ? AND self_test_id = ?
         AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
           AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
          )
          .bind(
            input.scope.organisationId,
            input.target.selfTestId,
            input.scope.organisationId,
            input.scope.placement.placementEpoch,
            input.scope.placement.placementCellId,
            input.scope.fenceToken,
          ),
      );
    }
    const results = await db.batch(statements);
    if (results[0]?.meta.changes !== 1 || !(await input.scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    return { ok: true, value: null };
  } catch {
    return {
      ok: false,
      error: { code: "email_operational_projection_write_failed" },
    };
  }
}

export async function readEmailOperationalProposalProjection(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly proposalId: string;
}): Promise<EmailOperationalProposalProjection | null> {
  const row = await input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
          integration_account_id AS integrationAccountId, case_id AS caseId,
          target_json AS targetJson, current_version AS currentVersion,
          target_digest AS targetDigest, subject_digest AS subjectDigest,
          body_digest AS bodyDigest, snapshot_digest AS snapshotDigest,
          lifecycle_kind AS lifecycleKind, provider_message_id AS providerMessageId,
          provider_thread_id AS providerThreadId,
          indeterminate_rfc_message_id AS indeterminateRfcMessageId,
          created_at AS createdAt, updated_at AS updatedAt
       FROM email_operational_proposal_projection
       WHERE organisation_id = ? AND proposal_id = ?`,
    )
    .bind(input.organisationId, input.proposalId)
    .first<OperationalProposalProjectionRow>();
  return parseOperationalProposalProjectionRow(row);
}

export async function listEmailOperationalProposalProjections(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly limit: number;
}): Promise<readonly EmailOperationalProposalProjection[]> {
  const rows = await input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
          integration_account_id AS integrationAccountId, case_id AS caseId,
          target_json AS targetJson, current_version AS currentVersion,
          target_digest AS targetDigest, subject_digest AS subjectDigest,
          body_digest AS bodyDigest, snapshot_digest AS snapshotDigest,
          lifecycle_kind AS lifecycleKind, provider_message_id AS providerMessageId,
          provider_thread_id AS providerThreadId,
          indeterminate_rfc_message_id AS indeterminateRfcMessageId,
          created_at AS createdAt, updated_at AS updatedAt
       FROM email_operational_proposal_projection
       WHERE organisation_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(input.organisationId, input.limit)
    .all<OperationalProposalProjectionRow>();
  return (rows.results ?? [])
    .map(parseOperationalProposalProjectionRow)
    .filter(isPresent);
}

export async function listEmailOperationalProposalProjectionsForCase(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly limit: number;
}): Promise<readonly EmailOperationalProposalProjection[]> {
  const rows = await input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
          integration_account_id AS integrationAccountId, case_id AS caseId,
          target_json AS targetJson, current_version AS currentVersion,
          target_digest AS targetDigest, subject_digest AS subjectDigest,
          body_digest AS bodyDigest, snapshot_digest AS snapshotDigest,
          lifecycle_kind AS lifecycleKind, provider_message_id AS providerMessageId,
          provider_thread_id AS providerThreadId,
          indeterminate_rfc_message_id AS indeterminateRfcMessageId,
          created_at AS createdAt, updated_at AS updatedAt
       FROM email_operational_proposal_projection
       WHERE organisation_id = ? AND case_id = ?
       ORDER BY updated_at DESC, proposal_id ASC
       LIMIT ?`,
    )
    .bind(input.organisationId, input.caseId, input.limit)
    .all<OperationalProposalProjectionRow>();
  return (rows.results ?? [])
    .map(parseOperationalProposalProjectionRow)
    .filter(isPresent);
}

export async function readLatestEmailOperationalProposalProjectionForCase(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
}): Promise<EmailOperationalProposalProjection | null> {
  const row = await input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
          integration_account_id AS integrationAccountId, case_id AS caseId,
          target_json AS targetJson, current_version AS currentVersion,
          target_digest AS targetDigest, subject_digest AS subjectDigest,
          body_digest AS bodyDigest, snapshot_digest AS snapshotDigest,
          lifecycle_kind AS lifecycleKind, provider_message_id AS providerMessageId,
          provider_thread_id AS providerThreadId,
          indeterminate_rfc_message_id AS indeterminateRfcMessageId,
          created_at AS createdAt, updated_at AS updatedAt
       FROM email_operational_proposal_projection
       WHERE organisation_id = ? AND case_id = ?
       ORDER BY updated_at DESC, proposal_id ASC
       LIMIT 1`,
    )
    .bind(input.organisationId, input.caseId)
    .first<OperationalProposalProjectionRow>();
  return parseOperationalProposalProjectionRow(row);
}

export async function registerEmailSenderAccount(
  input: EmailAccountRegistration,
): Promise<Result<null, EmailOperationalDirectoryError>> {
  if (
    input.googleSubject.trim().length === 0 ||
    !isEmailAddress(input.observedAddress)
  ) {
    return { ok: false, error: { code: "email_sender_account_invalid" } };
  }
  const claimed = await readEmailSenderIdentityClaimant(input);
  if (
    claimed !== null &&
    (claimed.organisationId !== input.organisationId ||
      claimed.integrationAccountId !== input.integrationAccountId)
  ) {
    return { ok: false, error: { code: "email_sender_identity_claimed" } };
  }
  try {
    await input.db
      .prepare(
        `INSERT INTO email_sender_account (
          integration_account_id, organisation_id, environment, google_subject,
          observed_address, address_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (integration_account_id) DO UPDATE SET
          organisation_id = excluded.organisation_id,
          environment = excluded.environment,
          google_subject = excluded.google_subject,
          observed_address = excluded.observed_address,
          address_observed_at = excluded.address_observed_at`,
      )
      .bind(
        input.integrationAccountId,
        input.organisationId,
        input.environment,
        input.googleSubject.trim(),
        normalizeEmailAddress(input.observedAddress),
        input.now,
      )
      .run();
    return { ok: true, value: null };
  } catch {
    return {
      ok: false,
      error: { code: "email_operational_directory_write_failed" },
    };
  }
}

export async function readEmailSenderIdentityClaimant(
  input: EmailIdentityClaimQuery,
): Promise<EmailIdentityClaimant | null> {
  return input.db
    .prepare(
      `SELECT organisation_id AS organisationId, integration_account_id AS integrationAccountId
       FROM email_sender_account
       WHERE environment = ? AND google_subject = ?`,
    )
    .bind(input.environment, input.googleSubject)
    .first<{
      readonly organisationId: string;
      readonly integrationAccountId: string;
    }>();
}

export async function resolveEmailSenderAccount(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
  }>,
): Promise<Result<EmailSenderAccount, EmailOperationalDirectoryError>> {
  const row = await input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId,
          organisation_id AS organisationId, environment, google_subject AS googleSubject,
          observed_address AS observedAddress,
          address_observed_at AS addressObservedAt
       FROM email_sender_account
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<{
      readonly integrationAccountId: unknown;
      readonly organisationId: unknown;
      readonly environment: unknown;
      readonly googleSubject: unknown;
      readonly observedAddress: unknown;
      readonly addressObservedAt: unknown;
    }>();
  if (row === null) {
    return { ok: false, error: { code: "email_sender_account_not_found" } };
  }
  const integrationAccountId =
    typeof row.integrationAccountId === "string"
      ? parseIntegrationAccountId(row.integrationAccountId)
      : null;
  const organisationId =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : null;
  if (
    integrationAccountId === null ||
    !integrationAccountId.ok ||
    organisationId === null ||
    !organisationId.ok ||
    (row.environment !== "development" && row.environment !== "production") ||
    typeof row.googleSubject !== "string" ||
    row.googleSubject.length === 0 ||
    typeof row.observedAddress !== "string" ||
    !isEmailAddress(row.observedAddress) ||
    typeof row.addressObservedAt !== "number" ||
    !Number.isSafeInteger(row.addressObservedAt) ||
    organisationId.value !== input.organisationId ||
    integrationAccountId.value !== input.integrationAccountId
  ) {
    return { ok: false, error: { code: "email_sender_account_invalid" } };
  }
  return {
    ok: true,
    value: {
      integrationAccountId: integrationAccountId.value,
      organisationId: organisationId.value,
      environment: row.environment,
      googleSubject: row.googleSubject,
      observedAddress: normalizeEmailAddress(row.observedAddress),
      addressObservedAt: row.addressObservedAt,
    },
  };
}

export async function registerOperationalEmailContact(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly target: OperationalEmailTarget;
    readonly address: string;
    readonly displayName: string | null;
    readonly state: "active" | "suppressed";
    readonly relationshipState: "active" | "inactive";
    readonly now: number;
  }>,
): Promise<Result<null, EmailOperationalDirectoryError>> {
  if (!isTarget(input.target) || !isEmailAddress(input.address)) {
    return { ok: false, error: { code: "email_operational_contact_invalid" } };
  }
  const entityId =
    input.target.kind === "customer_contact"
      ? input.target.customerId
      : input.target.supplierId;
  const normalizedAddress = normalizeEmailAddress(input.address);
  const existing = await input.db
    .prepare(
      `SELECT contact_revision AS contactRevision,
          observed_address AS observedAddress, display_name AS displayName,
          contact_state AS contactState,
          relationship_state AS relationshipState
       FROM email_operational_contact
       WHERE organisation_id = ? AND contact_kind = ? AND entity_id = ? AND contact_id = ?`,
    )
    .bind(
      input.organisationId,
      input.target.kind,
      entityId,
      input.target.contactId,
    )
    .first<{
      readonly contactRevision: unknown;
      readonly observedAddress: unknown;
      readonly displayName: unknown;
      readonly contactState: unknown;
      readonly relationshipState: unknown;
    }>();
  if (existing !== null) {
    if (
      existing.contactRevision === input.target.contactRevision &&
      existing.observedAddress === normalizedAddress &&
      existing.displayName === input.displayName &&
      existing.contactState === input.state &&
      existing.relationshipState === input.relationshipState
    ) {
      return { ok: true, value: null };
    }
    if (
      typeof existing.contactRevision !== "number" ||
      input.target.contactRevision <= existing.contactRevision
    ) {
      return {
        ok: false,
        error: { code: "email_operational_contact_invalid" },
      };
    }
  }
  try {
    await input.db
      .prepare(
        `INSERT INTO email_operational_contact (
          organisation_id, contact_kind, entity_id, contact_id, contact_revision,
          observed_address, display_name, contact_state, relationship_state,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (organisation_id, contact_kind, entity_id, contact_id) DO UPDATE SET
          contact_revision = excluded.contact_revision,
          observed_address = excluded.observed_address,
          display_name = excluded.display_name,
          contact_state = excluded.contact_state,
          relationship_state = excluded.relationship_state,
          updated_at = excluded.updated_at`,
      )
      .bind(
        input.organisationId,
        input.target.kind,
        entityId,
        input.target.contactId,
        input.target.contactRevision,
        normalizedAddress,
        input.displayName,
        input.state,
        input.relationshipState,
        input.now,
      )
      .run();
    return { ok: true, value: null };
  } catch {
    return {
      ok: false,
      error: { code: "email_operational_directory_write_failed" },
    };
  }
}

export async function registerSupplierOperationalEmailContact(
  input: SupplierEmailContactRegistration,
): Promise<Result<null, EmailOperationalDirectoryError>> {
  return registerOperationalEmailContact({
    db: input.db,
    organisationId: input.organisationId,
    target: {
      kind: "supplier_contact",
      supplierId: input.supplierId,
      contactId: "primary_email",
      contactRevision: input.contactRevision,
    },
    address: input.address,
    displayName: input.displayName,
    state: "active",
    relationshipState: "active",
    now: input.now,
  });
}

export async function resolveOperationalEmailContact(
  input: Readonly<{
    readonly db: Pick<OrganisationDatabase, "prepare">;
    readonly organisationId: OrganisationId;
    readonly target: OperationalEmailTarget;
  }>,
): Promise<Result<OperationalEmailContact, EmailOperationalDirectoryError>> {
  if (!isTarget(input.target)) {
    return { ok: false, error: { code: "email_operational_contact_invalid" } };
  }
  const entityId =
    input.target.kind === "customer_contact"
      ? input.target.customerId
      : input.target.supplierId;
  const row = await input.db
    .prepare(
      `SELECT organisation_id AS organisationId, contact_kind AS contactKind,
          entity_id AS entityId, contact_id AS contactId,
          contact_revision AS contactRevision, observed_address AS observedAddress,
          display_name AS displayName, contact_state AS contactState,
          relationship_state AS relationshipState, updated_at AS updatedAt
       FROM email_operational_contact
       WHERE organisation_id = ? AND contact_kind = ? AND entity_id = ? AND contact_id = ?`,
    )
    .bind(
      input.organisationId,
      input.target.kind,
      entityId,
      input.target.contactId,
    )
    .first<{
      readonly organisationId: unknown;
      readonly contactKind: unknown;
      readonly entityId: unknown;
      readonly contactId: unknown;
      readonly contactRevision: unknown;
      readonly observedAddress: unknown;
      readonly displayName: unknown;
      readonly contactState: unknown;
      readonly relationshipState: unknown;
      readonly updatedAt: unknown;
    }>();
  if (row === null) {
    return {
      ok: false,
      error: { code: "email_operational_contact_not_found" },
    };
  }
  if (row.contactState === "suppressed") {
    return {
      ok: false,
      error: { code: "email_operational_contact_suppressed" },
    };
  }
  if (row.relationshipState !== "active") {
    return { ok: false, error: { code: "email_operational_contact_inactive" } };
  }
  const parsedOrganisation =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : null;
  const observedAddress =
    typeof row.observedAddress === "string" &&
    isEmailAddress(row.observedAddress)
      ? normalizeEmailAddress(row.observedAddress)
      : null;
  const displayName =
    row.displayName === null || typeof row.displayName === "string"
      ? row.displayName
      : undefined;
  const contactRevision =
    typeof row.contactRevision === "number" &&
    Number.isSafeInteger(row.contactRevision)
      ? row.contactRevision
      : null;
  const updatedAt =
    typeof row.updatedAt === "number" && Number.isSafeInteger(row.updatedAt)
      ? row.updatedAt
      : null;
  if (
    parsedOrganisation === null ||
    !parsedOrganisation.ok ||
    parsedOrganisation.value !== input.organisationId ||
    row.contactKind !== input.target.kind ||
    row.entityId !== entityId ||
    row.contactId !== input.target.contactId ||
    contactRevision !== input.target.contactRevision ||
    observedAddress === null ||
    displayName === undefined ||
    updatedAt === null
  ) {
    return { ok: false, error: { code: "email_operational_contact_invalid" } };
  }
  return {
    ok: true,
    value: {
      organisationId: parsedOrganisation.value,
      target: input.target,
      address: observedAddress,
      displayName,
      state: "active",
      relationshipState: "active",
      updatedAt,
    },
  };
}

type OperationalProposalProjectionRow = Readonly<{
  readonly proposalId: unknown;
  readonly organisationId: unknown;
  readonly integrationAccountId: unknown;
  readonly caseId: unknown;
  readonly targetJson: unknown;
  readonly currentVersion: unknown;
  readonly targetDigest: unknown;
  readonly subjectDigest: unknown;
  readonly bodyDigest: unknown;
  readonly snapshotDigest: unknown;
  readonly lifecycleKind: unknown;
  readonly providerMessageId: unknown;
  readonly providerThreadId: unknown;
  readonly indeterminateRfcMessageId: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}>;

function parseOperationalProposalProjectionRow(
  row: OperationalProposalProjectionRow | null,
): EmailOperationalProposalProjection | null {
  if (row === null) return null;
  const organisationId =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : null;
  const integrationAccountId =
    typeof row.integrationAccountId === "string"
      ? parseIntegrationAccountId(row.integrationAccountId)
      : null;
  const target =
    typeof row.targetJson === "string" ? parseJsonTarget(row.targetJson) : null;
  if (
    !organisationId?.ok ||
    !integrationAccountId?.ok ||
    target === null ||
    typeof row.proposalId !== "string" ||
    typeof row.caseId !== "string" ||
    typeof row.currentVersion !== "number" ||
    !Number.isSafeInteger(row.currentVersion) ||
    row.currentVersion <= 0 ||
    !isSha256Hex(row.targetDigest) ||
    !isSha256Hex(row.subjectDigest) ||
    !isSha256Hex(row.bodyDigest) ||
    !isSha256Hex(row.snapshotDigest) ||
    !isOperationalProposalProjectionLifecycle(row.lifecycleKind) ||
    (row.providerMessageId !== null &&
      typeof row.providerMessageId !== "string") ||
    (row.providerThreadId !== null &&
      typeof row.providerThreadId !== "string") ||
    (row.indeterminateRfcMessageId !== null &&
      typeof row.indeterminateRfcMessageId !== "string") ||
    typeof row.createdAt !== "number" ||
    !Number.isSafeInteger(row.createdAt) ||
    typeof row.updatedAt !== "number" ||
    !Number.isSafeInteger(row.updatedAt) ||
    row.updatedAt < row.createdAt
  ) {
    return null;
  }
  return {
    proposalId: row.proposalId,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    caseId: row.caseId,
    target,
    currentVersion: row.currentVersion,
    targetDigest: row.targetDigest,
    subjectDigest: row.subjectDigest,
    bodyDigest: row.bodyDigest,
    snapshotDigest: row.snapshotDigest,
    lifecycleKind: row.lifecycleKind,
    providerMessageId: row.providerMessageId,
    providerThreadId: row.providerThreadId,
    indeterminateRfcMessageId: row.indeterminateRfcMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonTarget(value: string): EmailProposalTarget | null {
  try {
    return parseEmailProposalTarget(JSON.parse(value));
  } catch {
    return null;
  }
}

function isOperationalProposalProjectionLifecycle(
  value: unknown,
): value is EmailOperationalProposalProjectionLifecycle {
  return (
    value === "awaiting_approval" ||
    value === "sent" ||
    value === "send_indeterminate" ||
    value === "rejected" ||
    value === "expired" ||
    value === "superseded" ||
    value === "revoked" ||
    value === "operator_attested_present" ||
    value === "operator_attested_absent"
  );
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export function parseOperationalEmailTarget(
  value: unknown,
): OperationalEmailTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const target = new Map(Object.entries(value));
  if (target.has("selfTestId") || target.has("address")) return null;
  const contactId = target.get("contactId");
  const contactRevision = target.get("contactRevision");
  if (
    typeof contactId !== "string" ||
    contactId.length === 0 ||
    typeof contactRevision !== "number" ||
    !Number.isSafeInteger(contactRevision) ||
    contactRevision <= 0
  ) {
    return null;
  }
  const kind = target.get("kind");
  const customerId = target.get("customerId");
  if (
    kind === "customer_contact" &&
    typeof customerId === "string" &&
    customerId.length > 0
  ) {
    return {
      kind: "customer_contact",
      customerId,
      contactId,
      contactRevision,
    };
  }
  const supplierId = target.get("supplierId");
  if (
    kind === "supplier_contact" &&
    typeof supplierId === "string" &&
    supplierId.length > 0
  ) {
    return {
      kind: "supplier_contact",
      supplierId,
      contactId,
      contactRevision,
    };
  }
  return null;
}

export function parseEmailProposalTarget(
  value: unknown,
): EmailProposalTarget | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const fields = new Map(Object.entries(value));
    if (fields.get("kind") === "self_test") {
      const selfTestId = fields.get("selfTestId");
      return fields.size === 2 &&
        typeof selfTestId === "string" &&
        selfTestId.length > 0
        ? { kind: "self_test", selfTestId }
        : null;
    }
  }
  return parseOperationalEmailTarget(value);
}

function isTarget(value: unknown): value is OperationalEmailTarget {
  return parseOperationalEmailTarget(value) !== null;
}

function isEmailAddress(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 320 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value)
  );
}

function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}
