import type { OrganisationDatabase } from "../database-handles";
import type {
  AccessGrant,
  AccessGrantLifecycle,
  AccessGrantTarget,
  FileResourceAccessGrantTarget,
  GrantProvenance,
  GrantSubject,
} from "../authorization/access-grants/types";
import { parseFileResourceScope } from "../authorization/access-grants/capability-key";
import {
  commerceGrantTargets,
  type CommerceGrantTargetParse,
} from "../authorization/access-grants/commerce-grant-targets";

import {
  prepareNewFileGrantSync,
  prepareRevokedFileGrantRows,
  supersedeUnadmittedFileProjectionsStatement,
} from "../context/files/persistence";
import {
  parseIntegrationAccountId,
  parsePersonId,
  parseOrganisationId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import {
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
} from "../custom-connectors/identity";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
} from "@purin-labs/std";

type AccessGrantRow = Readonly<{
  grantId: unknown;
  organisationId: unknown;
  subjectJson: unknown;
  targetJson: unknown;
  provenanceJson: unknown;
  lifecycle: unknown;
  revision: unknown;
  reason: unknown;
  changedAt: unknown;
}>;

type AccessGrantParseError =
  | { readonly code: "invalid_grant_row"; readonly field: string }
  | { readonly code: "invalid_grant_subject"; readonly field: string }
  | { readonly code: "invalid_grant_target"; readonly field: string }
  | { readonly code: "invalid_grant_provenance"; readonly field: string }
  | { readonly code: "invalid_grant_lifecycle"; readonly field: string };

type AccessGrantDataError =
  | AccessGrantParseError
  | { readonly code: "access_grant_not_found" }
  | {
      readonly code: "access_grant_revision_conflict";
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly code: "access_grant_invalid_transition";
      readonly lifecycle: AccessGrantLifecycle["kind"];
    }
  | { readonly code: "access_grant_store_failed"; readonly detail: string };

export type CreateAccessGrantInput = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  grantId: AccessGrant["grantId"];
  subject: GrantSubject;
  target: AccessGrantTarget;
  provenance: GrantProvenance;
  now: number;
}>;

type ChangeAccessGrantInput = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  grantId: AccessGrant["grantId"];
  expectedRevision: number;
  reason: string;
  now: number;
}>;

type ReadAccessGrantInput = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  grantId: AccessGrant["grantId"];
}>;

type ListAccessGrantsInput = Readonly<{
  db: Pick<OrganisationDatabase, "prepare">;
  organisationId: OrganisationId;
  lifecycle?: AccessGrantLifecycle["kind"];
}>;

export function parseAccessGrantRow(
  expectedOrganisationId: OrganisationId,
  row: AccessGrantRow,
): Result<AccessGrant, AccessGrantParseError> {
  const grantId = readNonEmptyString(row.grantId);
  if (grantId === null) {
    return invalidRow("grantId");
  }

  const organisationIdRaw = readNonEmptyString(row.organisationId);
  if (organisationIdRaw === null) {
    return invalidRow("organisationId");
  }
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok || organisationId.value !== expectedOrganisationId) {
    return invalidRow("organisationId");
  }

  const subject = parseAccessGrantSubject(row.subjectJson);
  if (!subject.ok) {
    return subject;
  }

  const target = parseAccessGrantTarget(row.targetJson);
  if (!target.ok) {
    return target;
  }

  const lifecycle = parseLifecycle(
    row.lifecycle,
    row.revision,
    row.reason,
    row.changedAt,
  );
  if (!lifecycle.ok) {
    return lifecycle;
  }
  const provenance = parseGrantProvenance(row.provenanceJson);
  if (!provenance.ok) return provenance;

  return {
    ok: true,
    value: {
      grantId,
      organisationId: organisationId.value,
      subject: subject.value,
      target: target.value,
      provenance: provenance.value,
      lifecycle: lifecycle.value,
    },
  };
}

export async function createAccessGrant(
  input: CreateAccessGrantInput,
): Promise<Result<AccessGrant, AccessGrantDataError>> {
  if (!isNonNegativeInteger(input.now)) {
    return {
      ok: false,
      error: { code: "access_grant_store_failed", detail: "now is invalid" },
    };
  }

  try {
    const create = input.db
      .prepare(
        `INSERT INTO access_grant (
         organisation_id, grant_id, subject_json, target_json, lifecycle,
         revision, reason, provenance_json, changed_at
       ) VALUES (?, ?, ?, ?, 'active', 1, NULL, ?, ?)`,
      )
      .bind(
        input.organisationId,
        input.grantId,
        JSON.stringify(input.subject),
        JSON.stringify(input.target),
        JSON.stringify(input.provenance),
        input.now,
      );
    if (input.target.kind === "file_resource") {
      const validAccount = await fileGrantAccountIsActive({
        db: input.db,
        organisationId: input.organisationId,
        target: input.target,
      });
      if (!validAccount) {
        return {
          ok: false,
          error: {
            code: "access_grant_store_failed",
            detail: "file resource account is inactive",
          },
        };
      }
      await input.db.batch([
        create,
        prepareNewFileGrantSync(input.db, {
          organisationId: input.organisationId,
          grantId: input.grantId,
          integrationAccountId: input.target.integrationAccountId,
          now: input.now,
        }),
      ]);
    } else {
      await create.run();
    }
  } catch (error) {
    return storeFailure(error);
  }

  return readAccessGrant({
    db: input.db,
    organisationId: input.organisationId,
    grantId: input.grantId,
  });
}

async function fileGrantAccountIsActive(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly target: FileResourceAccessGrantTarget;
  }>,
): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT provider, lifecycle FROM integration_account
      WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(input.organisationId, input.target.integrationAccountId)
    .first<{
      readonly provider: unknown;
      readonly lifecycle: unknown;
    }>();
  if (row?.lifecycle !== "active") return false;
  switch (input.target.scope.kind) {
    case "dropbox_folder":
    case "dropbox_file":
      return row.provider === "dropbox";
    case "gdrive_file":
      return row.provider === "google_drive";
  }
}

export async function revokeAccessGrant(
  input: ChangeAccessGrantInput,
): Promise<Result<AccessGrant, AccessGrantDataError>> {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    return {
      ok: false,
      error: {
        code: "access_grant_revision_conflict",
        expected: input.expectedRevision,
        actual: 0,
      },
    };
  }
  if (!isNonNegativeInteger(input.now)) {
    return {
      ok: false,
      error: { code: "access_grant_store_failed", detail: "now is invalid" },
    };
  }
  if (input.reason.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "access_grant_store_failed",
        detail: "reason is required",
      },
    };
  }

  const existing = await readAccessGrant({
    db: input.db,
    organisationId: input.organisationId,
    grantId: input.grantId,
  });
  if (!existing.ok) {
    return existing;
  }
  if (existing.value.lifecycle.revision !== input.expectedRevision) {
    return {
      ok: false,
      error: {
        code: "access_grant_revision_conflict",
        expected: input.expectedRevision,
        actual: existing.value.lifecycle.revision,
      },
    };
  }
  if (existing.value.lifecycle.kind === "revoked") {
    return {
      ok: false,
      error: {
        code: "access_grant_invalid_transition",
        lifecycle: existing.value.lifecycle.kind,
      },
    };
  }

  try {
    const revoke = input.db
      .prepare(
        `UPDATE access_grant
          SET lifecycle = 'revoked',
              revision = revision + 1,
              reason = ?,
              changed_at = ?
        WHERE organisation_id = ?
          AND grant_id = ?
          AND revision = ?
          AND lifecycle = 'active'`,
      )
      .bind(
        input.reason.trim(),
        input.now,
        input.organisationId,
        input.grantId,
        input.expectedRevision,
      );
    if (existing.value.target.kind === "file_resource") {
      const integrationAccountId = parseIntegrationAccountId(
        existing.value.target.integrationAccountId,
      );
      if (!integrationAccountId.ok) {
        return {
          ok: false,
          error: {
            code: "access_grant_store_failed",
            detail: "file integration account is invalid",
          },
        };
      }
      await input.db.batch([
        ...prepareRevokedFileGrantRows(input.db, {
          organisationId: input.organisationId,
          grantId: input.grantId,
        }),
        supersedeUnadmittedFileProjectionsStatement({
          db: input.db,
          organisationId: input.organisationId,
          integrationAccountId: integrationAccountId.value,
          reason: "grant_revoked",
          now: input.now,
        }),
        revoke,
      ]);
    } else {
      await revoke.run();
    }
  } catch (error) {
    return storeFailure(error);
  }

  const changed = await readAccessGrant({
    db: input.db,
    organisationId: input.organisationId,
    grantId: input.grantId,
  });
  if (!changed.ok) {
    return changed;
  }
  if (changed.value.lifecycle.revision === input.expectedRevision) {
    return {
      ok: false,
      error: {
        code: "access_grant_revision_conflict",
        expected: input.expectedRevision,
        actual: changed.value.lifecycle.revision,
      },
    };
  }
  return changed;
}

export async function readAccessGrant(
  input: ReadAccessGrantInput,
): Promise<Result<AccessGrant, AccessGrantDataError>> {
  try {
    const row = await input.db
      .prepare(
        `SELECT grant_id AS grantId,
                organisation_id AS organisationId,
                subject_json AS subjectJson,
                target_json AS targetJson,
                provenance_json AS provenanceJson,
                lifecycle,
                revision,
                reason,
                changed_at AS changedAt
           FROM access_grant
          WHERE organisation_id = ? AND grant_id = ?`,
      )
      .bind(input.organisationId, input.grantId)
      .first<AccessGrantRow>();

    if (row === null) {
      return { ok: false, error: { code: "access_grant_not_found" } };
    }

    return parseAccessGrantRow(input.organisationId, row);
  } catch (error) {
    return storeFailure(error);
  }
}

export async function listAccessGrants(
  input: ListAccessGrantsInput,
): Promise<Result<readonly AccessGrant[], AccessGrantDataError>> {
  try {
    const statement =
      input.lifecycle === undefined
        ? input.db
            .prepare(
              `SELECT grant_id AS grantId,
                organisation_id AS organisationId,
                subject_json AS subjectJson,
                target_json AS targetJson,
                provenance_json AS provenanceJson,
                lifecycle,
                revision,
                reason,
                changed_at AS changedAt
           FROM access_grant
          WHERE organisation_id = ?
          ORDER BY grant_id`,
            )
            .bind(input.organisationId)
        : input.db
            .prepare(
              `SELECT grant_id AS grantId,
                organisation_id AS organisationId,
                subject_json AS subjectJson,
                target_json AS targetJson,
                provenance_json AS provenanceJson,
                lifecycle,
                revision,
                reason,
                changed_at AS changedAt
           FROM access_grant
          WHERE organisation_id = ? AND lifecycle = ?
          ORDER BY grant_id`,
            )
            .bind(input.organisationId, input.lifecycle);
    const rows = await statement.all<AccessGrantRow>();
    const grants: AccessGrant[] = [];
    for (const row of rows.results ?? []) {
      const parsed = parseAccessGrantRow(input.organisationId, row);
      if (!parsed.ok) {
        return parsed;
      }
      grants.push(parsed.value);
    }
    return { ok: true, value: grants };
  } catch (error) {
    return storeFailure(error);
  }
}

function parseAccessGrantSubject(
  raw: unknown,
): Result<GrantSubject, AccessGrantParseError> {
  const value = typeof raw === "string" ? parseJsonRecord(raw) : asRecord(raw);
  if (value === null) {
    return invalidSubject("subjectJson");
  }
  const kind = readString(value.kind);
  if (kind === "organisation_role") {
    const role = readNonEmptyString(value.role);
    return role === null || !hasExactKeys(value, ["kind", "role"])
      ? invalidSubject("subject.role")
      : { ok: true, value: { kind: "organisation_role", role } };
  }
  if (kind === "person") {
    const personId = readNonEmptyString(value.personId);
    if (personId === null || !hasExactKeys(value, ["kind", "personId"])) {
      return invalidSubject("subject.personId");
    }
    const parsedPersonId = parsePersonId(personId);
    return parsedPersonId.ok
      ? { ok: true, value: { kind: "person", personId: parsedPersonId.value } }
      : invalidSubject("subject.personId");
  }
  if (kind === "conversation") {
    const integrationAccountId = readNonEmptyString(value.integrationAccountId);
    const conversationId = readNonEmptyString(value.conversationId);
    if (
      !hasExactKeys(value, [
        "kind",
        "integrationAccountId",
        "conversationId",
      ]) ||
      integrationAccountId === null
    )
      return invalidSubject("subject.integrationAccountId");
    if (conversationId === null)
      return invalidSubject("subject.conversationId");
    const parsedAccountId = parseIntegrationAccountId(integrationAccountId);
    return parsedAccountId.ok
      ? {
          ok: true,
          value: {
            kind: "conversation",
            integrationAccountId: parsedAccountId.value,
            conversationId,
          },
        }
      : invalidSubject("subject.integrationAccountId");
  }
  if (kind === "workflow") {
    const workflowId = readNonEmptyString(value.workflowId);
    const workflowRevision = positiveIntegerOrNull(value.workflowRevision);
    return !hasExactKeys(value, [
      "kind",
      "workflowKind",
      "workflowId",
      "workflowRevision",
    ])
      ? invalidSubject("subject.kind")
      : workflowId === null
        ? invalidSubject("subject.workflowId")
        : workflowRevision === null
          ? invalidSubject("subject.workflowRevision")
          : value.workflowKind === "cue_subscription"
            ? {
                ok: true,
                value: {
                  kind: "workflow",
                  workflowKind: "cue_subscription",
                  workflowId,
                  workflowRevision,
                },
              }
            : invalidSubject("subject.workflowKind");
  }
  if (kind === "agent_mailbox") {
    if (
      !hasExactKeys(value, [
        "kind",
        "integrationAccountId",
        "mailboxBindingId",
        "bindingRevision",
      ])
    ) {
      return invalidSubject("subject.kind");
    }
    const integrationAccountId = readNonEmptyString(value.integrationAccountId);
    const mailboxBindingId = readNonEmptyString(value.mailboxBindingId);
    const bindingRevision = positiveIntegerOrNull(value.bindingRevision);
    if (integrationAccountId === null)
      return invalidSubject("subject.integrationAccountId");
    if (mailboxBindingId === null)
      return invalidSubject("subject.mailboxBindingId");
    if (bindingRevision === null)
      return invalidSubject("subject.bindingRevision");
    const parsedAccountId = parseIntegrationAccountId(integrationAccountId);
    return parsedAccountId.ok
      ? {
          ok: true,
          value: {
            kind: "agent_mailbox",
            integrationAccountId: parsedAccountId.value,
            mailboxBindingId,
            bindingRevision,
          },
        }
      : invalidSubject("subject.integrationAccountId");
  }
  if (kind === "whatsapp_support") {
    if (
      !hasExactKeys(value, [
        "kind",
        "integrationAccountId",
        "supportBindingId",
        "bindingRevision",
      ])
    ) {
      return invalidSubject("subject.kind");
    }
    const integrationAccountId = readNonEmptyString(value.integrationAccountId);
    const supportBindingId = readNonEmptyString(value.supportBindingId);
    const bindingRevision = positiveIntegerOrNull(value.bindingRevision);
    if (integrationAccountId === null)
      return invalidSubject("subject.integrationAccountId");
    if (supportBindingId === null)
      return invalidSubject("subject.supportBindingId");
    if (bindingRevision === null)
      return invalidSubject("subject.bindingRevision");
    const parsedAccountId = parseIntegrationAccountId(integrationAccountId);
    return parsedAccountId.ok
      ? {
          ok: true,
          value: {
            kind: "whatsapp_support",
            integrationAccountId: parsedAccountId.value,
            supportBindingId,
            bindingRevision,
          },
        }
      : invalidSubject("subject.integrationAccountId");
  }
  return invalidSubject("subject.kind");
}

export function parseAccessGrantTarget(
  raw: unknown,
): Result<AccessGrantTarget, AccessGrantParseError> {
  const value = typeof raw === "string" ? parseJsonRecord(raw) : asRecord(raw);
  if (value === null) {
    return invalidTarget("targetJson");
  }
  const kind = readString(value.kind);
  const capabilityId = readNonEmptyString(value.capabilityId);
  const capabilityVersion = positiveIntegerOrNull(value.capabilityVersion);
  if (capabilityId === null) {
    return invalidTarget("target.capabilityId");
  }
  if (capabilityVersion === null) {
    return invalidTarget("target.capabilityVersion");
  }
  if (kind === "platform_capability") {
    if (!hasExactKeys(value, ["kind", "capabilityId", "capabilityVersion"])) {
      return invalidTarget("target.kind");
    }
    return { ok: true, value: { kind, capabilityId, capabilityVersion } };
  }
  if (kind === "provider_resource") {
    if (
      !hasExactKeys(value, [
        "kind",
        "capabilityId",
        "capabilityVersion",
        "integrationAccountId",
        "resourceScope",
      ])
    )
      return invalidTarget("target.kind");
    const integrationAccountId = readNonEmptyString(value.integrationAccountId);
    const resourceScope = readNonEmptyString(value.resourceScope);
    if (integrationAccountId === null)
      return invalidTarget("target.integrationAccountId");
    if (resourceScope === null) return invalidTarget("target.resourceScope");
    const parsedAccountId = parseIntegrationAccountId(integrationAccountId);
    return parsedAccountId.ok
      ? {
          ok: true,
          value: {
            kind,
            capabilityId,
            capabilityVersion,
            integrationAccountId: parsedAccountId.value,
            resourceScope,
          },
        }
      : invalidTarget("target.integrationAccountId");
  }
  if (kind === "file_resource") {
    if (
      !hasExactKeys(value, [
        "kind",
        "capabilityId",
        "capabilityVersion",
        "integrationAccountId",
        "scope",
      ])
    )
      return invalidTarget("target.kind");
    const integrationAccountId = readNonEmptyString(value.integrationAccountId);
    const scope = parseFileResourceScope(value.scope);
    if (integrationAccountId === null)
      return invalidTarget("target.integrationAccountId");
    if (scope === null) return invalidTarget("target.scope");
    const parsedAccountId = parseIntegrationAccountId(integrationAccountId);
    return parsedAccountId.ok && capabilityId === "file.read"
      ? {
          ok: true,
          value: {
            kind,
            capabilityId,
            capabilityVersion,
            integrationAccountId: parsedAccountId.value,
            scope,
          },
        }
      : invalidTarget(
          parsedAccountId.ok
            ? "target.capabilityId"
            : "target.integrationAccountId",
        );
  }
  if (kind === "custom_connector_operation") {
    if (
      !hasExactKeys(value, [
        "kind",
        "capabilityId",
        "capabilityVersion",
        "integrationAccountId",
        "connectorId",
        "definitionRevision",
        "definitionDigest",
        "operationId",
      ])
    ) {
      return invalidTarget("target.kind");
    }
    const integrationAccountId = readNonEmptyString(value.integrationAccountId);
    const connectorId = parseCustomConnectorId(value.connectorId);
    const definitionRevision = parseCustomConnectorRevision(
      value.definitionRevision,
    );
    const definitionDigest = parseCustomConnectorDefinitionDigest(
      value.definitionDigest,
    );
    const operationId = readNonEmptyString(value.operationId);
    if (integrationAccountId === null) {
      return invalidTarget("target.integrationAccountId");
    }
    const parsedAccountId = parseIntegrationAccountId(integrationAccountId);
    if (!parsedAccountId.ok) {
      return invalidTarget("target.integrationAccountId");
    }
    if (!connectorId.ok) return invalidTarget("target.connectorId");
    if (!definitionRevision.ok) {
      return invalidTarget("target.definitionRevision");
    }
    if (!definitionDigest.ok) {
      return invalidTarget("target.definitionDigest");
    }
    if (operationId === null || !/^[a-z][a-z0-9_]{0,47}$/u.test(operationId)) {
      return invalidTarget("target.operationId");
    }
    if (
      (capabilityId !== "custom_connector.read" &&
        capabilityId !== "custom_connector.write") ||
      capabilityVersion !== 1
    ) {
      return invalidTarget("target.capabilityId");
    }
    return {
      ok: true,
      value: {
        kind,
        capabilityId,
        capabilityVersion,
        integrationAccountId: parsedAccountId.value,
        connectorId: connectorId.value,
        definitionRevision: definitionRevision.value,
        definitionDigest: definitionDigest.value,
        operationId,
      },
    };
  }
  if (kind === "commerce_read") {
    if (
      !hasExactKeys(value, [
        "kind",
        "capabilityId",
        "capabilityVersion",
        "scope",
      ])
    ) {
      return invalidTarget("target.kind");
    }
    const scope = commerceTarget(
      commerceGrantTargets.use().parseReadScope(value.scope),
    );
    return scope.ok
      ? {
          ok: true,
          value: { kind, capabilityId, capabilityVersion, scope: scope.value },
        }
      : scope;
  }
  if (kind === "commerce_command") {
    if (
      !hasExactKeys(value, [
        "kind",
        "capabilityId",
        "capabilityVersion",
        "scope",
        "target",
      ])
    ) {
      return invalidTarget("target.kind");
    }
    const parts = commerceGrantTargets.use();
    const scope = commerceTarget(parts.parseCommandScope(value.scope));
    if (!scope.ok) return scope;
    const target = commerceTarget(parts.parseCommandTarget(value.target));
    return target.ok
      ? {
          ok: true,
          value: {
            kind,
            capabilityId,
            capabilityVersion,
            scope: scope.value,
            target: target.value,
          },
        }
      : target;
  }
  return invalidTarget("target.kind");
}

/** A commerce part of a grant target, as a target error of this parser. */
function commerceTarget<T>(
  parsed: CommerceGrantTargetParse<T>,
): Result<T, AccessGrantParseError> {
  return parsed.ok ? parsed : invalidTarget(parsed.error.field);
}

function parseLifecycle(
  rawLifecycle: unknown,
  rawRevision: unknown,
  rawReason: unknown,
  rawChangedAt: unknown,
): Result<AccessGrantLifecycle, AccessGrantParseError> {
  const kind = readString(rawLifecycle);
  const revision = positiveIntegerOrNull(rawRevision);
  const changedAt = nonNegativeIntegerOrNull(rawChangedAt);
  if (kind === null || revision === null || changedAt === null) {
    return invalidLifecycle("lifecycle");
  }
  if (kind === "active") {
    return rawReason === null
      ? { ok: true, value: { kind, revision, activatedAt: changedAt } }
      : invalidLifecycle("lifecycle.reason");
  }
  const reason = readNonEmptyString(rawReason);
  if (reason === null) {
    return invalidLifecycle("lifecycle.reason");
  }
  if (kind === "revoked") {
    return {
      ok: true,
      value: { kind, revision, revokedAt: changedAt, reason },
    };
  }
  return invalidLifecycle("lifecycle.kind");
}

function parseGrantProvenance(
  raw: unknown,
): Result<GrantProvenance, AccessGrantParseError> {
  const value = parseJsonRecord(raw);
  if (value === null) return invalidProvenance("provenanceJson");
  const kind = readString(value.kind);
  if (
    kind === "operator" &&
    hasExactKeys(value, ["kind", "userId", "mutationReceiptId"])
  ) {
    const userId = readNonEmptyString(value.userId);
    const mutationReceiptId = readNonEmptyString(value.mutationReceiptId);
    return userId !== null && mutationReceiptId !== null
      ? { ok: true, value: { kind, userId, mutationReceiptId } }
      : invalidProvenance("provenance.operator");
  }
  if (
    kind === "baseline" &&
    hasExactKeys(value, [
      "kind",
      "profile",
      "profileVersion",
      "materializationReceiptId",
    ])
  ) {
    const profile = readNonEmptyString(value.profile);
    const profileVersion = positiveIntegerOrNull(value.profileVersion);
    const materializationReceiptId = readNonEmptyString(
      value.materializationReceiptId,
    );
    return profile !== null &&
      profileVersion !== null &&
      materializationReceiptId !== null
      ? {
          ok: true,
          value: { kind, profile, profileVersion, materializationReceiptId },
        }
      : invalidProvenance("provenance.baseline");
  }
  if (
    kind === "integration_setup" &&
    hasExactKeys(value, [
      "kind",
      "integrationAccountId",
      "setupRevision",
      "materializationReceiptId",
    ])
  ) {
    const integrationAccountId = readNonEmptyString(value.integrationAccountId);
    const setupRevision = positiveIntegerOrNull(value.setupRevision);
    const materializationReceiptId = readNonEmptyString(
      value.materializationReceiptId,
    );
    return integrationAccountId !== null &&
      setupRevision !== null &&
      materializationReceiptId !== null
      ? {
          ok: true,
          value: {
            kind,
            integrationAccountId,
            setupRevision,
            materializationReceiptId,
          },
        }
      : invalidProvenance("provenance.integrationSetup");
  }
  if (
    kind === "cutover" &&
    hasExactKeys(value, ["kind", "migrationId", "originalChangedAt"])
  ) {
    const migrationId = readNonEmptyString(value.migrationId);
    const originalChangedAt = nonNegativeIntegerOrNull(value.originalChangedAt);
    return migrationId !== null && originalChangedAt !== null
      ? { ok: true, value: { kind, migrationId, originalChangedAt } }
      : invalidProvenance("provenance.cutover");
  }
  return invalidProvenance("provenance.kind");
}

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  const result = readString(value);
  return result === null || result.trim().length === 0 ? null : result;
}

function invalidRow(field: string): Result<never, AccessGrantParseError> {
  return { ok: false, error: { code: "invalid_grant_row", field } };
}

function invalidSubject(field: string): Result<never, AccessGrantParseError> {
  return { ok: false, error: { code: "invalid_grant_subject", field } };
}

function invalidTarget(field: string): Result<never, AccessGrantParseError> {
  return { ok: false, error: { code: "invalid_grant_target", field } };
}

function invalidProvenance(
  field: string,
): Result<never, AccessGrantParseError> {
  return { ok: false, error: { code: "invalid_grant_provenance", field } };
}

function invalidLifecycle(field: string): Result<never, AccessGrantParseError> {
  return { ok: false, error: { code: "invalid_grant_lifecycle", field } };
}

function storeFailure(error: unknown): Result<never, AccessGrantDataError> {
  return {
    ok: false,
    error: {
      code: "access_grant_store_failed",
      detail:
        error instanceof Error
          ? error.message
          : "access grant persistence failed",
    },
  };
}

/** A condition that a grant insert checks, and its values. */
type GrantGuard = Readonly<{ condition: string; bindings: readonly unknown[] }>;

/** The values of an active grant at its first revision, as stored JSON. */
type FirstGrantRevision = Readonly<{
  organisationId: string;
  grantId: string;
  subjectJson: string;
  targetJson: string;
  provenanceJson: string;
  changedAt: number;
}>;

/** Adds an active grant at its first revision while the guard holds. */
export function prepareGuardedFirstGrant(
  db: Pick<OrganisationDatabase, "prepare">,
  input: FirstGrantRevision & Readonly<{ guard: GrantGuard }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO access_grant (
       organisation_id, grant_id, subject_json, target_json, lifecycle,
       revision, reason, provenance_json, changed_at
     ) SELECT ?, ?, ?, ?, 'active', 1, NULL, ?, ? WHERE ${input.guard.condition}`,
    )
    .bind(
      input.organisationId,
      input.grantId,
      input.subjectJson,
      input.targetJson,
      input.provenanceJson,
      input.changedAt,
      ...input.guard.bindings,
    );
}

/**
 * Adds the context grant of a WhatsApp support binding while the placement
 * is active and the binding is at `bindingRevision`. A grant that exists
 * stays. With `precedingWrite`, it also needs a change by the statement
 * before it.
 */
export function prepareSupportBindingContextGrant(
  db: Pick<OrganisationDatabase, "prepare">,
  input: FirstGrantRevision &
    Readonly<{
      placement: Readonly<{
        placementEpoch: number;
        placementCellId: string;
        fenceToken: string;
      }>;
      integrationAccountId: string;
      supportBindingId: string;
      bindingRevision: number;
      precedingWrite: "" | " AND changes() = 1";
    }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO access_grant (
       organisation_id, grant_id, subject_json, target_json, lifecycle,
       revision, reason, provenance_json, changed_at
     ) SELECT ?, ?, ?, ?, 'active', 1, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM organisation_placement
       WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')
       AND EXISTS (SELECT 1 FROM whatsapp_support_binding WHERE organisation_id = ? AND integration_account_id = ?
         AND support_binding_id = ? AND current_revision = ?)${input.precedingWrite}
     ON CONFLICT (organisation_id, grant_id) DO NOTHING`,
    )
    .bind(
      input.organisationId,
      input.grantId,
      input.subjectJson,
      input.targetJson,
      input.provenanceJson,
      input.changedAt,
      input.organisationId,
      input.placement.placementEpoch,
      input.placement.placementCellId,
      input.placement.fenceToken,
      input.organisationId,
      input.integrationAccountId,
      input.supportBindingId,
      input.bindingRevision,
    );
}
