import type { OrganisationDatabase } from "../database-handles";

import { parseOrganisationId, type OrganisationId } from "../ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import {
  digestCanonical,
  serializeCanonical,
} from "../policy/information-flow/digest";
import type { Result } from "../result";
import {
  parseCustomConnectorDefinition,
  type CustomConnectorDefinitionError,
  type JsonObject,
  type ParsedCustomConnectorDefinition,
} from "./definition";
import {
  newCustomConnectorId,
  parseCustomConnectorAuthoringDigest,
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
  type CustomConnectorAuthoringDigest,
  type CustomConnectorDefinitionDigest,
  type CustomConnectorId,
  type CustomConnectorRevision,
} from "./identity";
import { CUSTOM_CONNECTOR_LIMITS } from "./limits";

const CUSTOM_CONNECTOR_VALIDATOR_VERSION = "definition-v1";

type CustomConnectorDraftDocument = {
  readonly value: JsonObject;
  readonly canonicalJson: string;
  readonly digest: CustomConnectorAuthoringDigest;
};

export type CustomConnectorApprovalReview = {
  readonly origin: string;
  readonly effects: readonly {
    readonly operationId: string;
    readonly effect:
      "read" | "external_record_create" | "external_record_update";
  }[];
};

type CustomConnectorRevisionBase = {
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly authoringDocument: JsonObject;
  readonly authoringDigest: CustomConnectorAuthoringDigest;
  readonly createdByUserId: UserId;
  readonly createdAt: number;
};

export type CustomConnectorRevisionRecord =
  | (CustomConnectorRevisionBase & {
      readonly reviewState: "draft";
      readonly validationFailure: CustomConnectorDefinitionError | null;
      readonly lastValidationAttemptedAt: number | null;
      readonly definition?: never;
      readonly definitionDigest?: never;
      readonly validatedAt?: never;
      readonly approval?: never;
      readonly rejection?: never;
      readonly retirement?: never;
    })
  | (CustomConnectorRevisionBase & {
      readonly reviewState: "validated";
      readonly definition: ParsedCustomConnectorDefinition["definition"];
      readonly definitionDigest: CustomConnectorDefinitionDigest;
      readonly validatedAt: number;
      readonly validationFailure?: never;
      readonly lastValidationAttemptedAt?: never;
      readonly approval?: never;
      readonly rejection?: never;
      readonly retirement?: never;
    })
  | (CustomConnectorRevisionBase & {
      readonly reviewState: "approved";
      readonly definition: ParsedCustomConnectorDefinition["definition"];
      readonly definitionDigest: CustomConnectorDefinitionDigest;
      readonly validatedAt: number;
      readonly approval: CustomConnectorApprovalReview & {
        readonly approvedByUserId: UserId;
        readonly approvedAt: number;
      };
      readonly validationFailure?: never;
      readonly lastValidationAttemptedAt?: never;
      readonly rejection?: never;
      readonly retirement?: never;
    })
  | (CustomConnectorRevisionBase & {
      readonly reviewState: "rejected";
      readonly definition: ParsedCustomConnectorDefinition["definition"];
      readonly definitionDigest: CustomConnectorDefinitionDigest;
      readonly validatedAt: number;
      readonly rejection: {
        readonly rejectedByUserId: UserId;
        readonly rejectedAt: number;
        readonly reason: string;
      };
      readonly validationFailure?: never;
      readonly lastValidationAttemptedAt?: never;
      readonly approval?: never;
      readonly retirement?: never;
    })
  | (CustomConnectorRevisionBase & {
      readonly reviewState: "retired";
      readonly definition: ParsedCustomConnectorDefinition["definition"];
      readonly definitionDigest: CustomConnectorDefinitionDigest;
      readonly validatedAt: number;
      readonly approval: CustomConnectorApprovalReview & {
        readonly approvedByUserId: UserId;
        readonly approvedAt: number;
      };
      readonly retirement: {
        readonly retiredByUserId: UserId;
        readonly retiredAt: number;
      };
      readonly validationFailure?: never;
      readonly lastValidationAttemptedAt?: never;
      readonly rejection?: never;
    });

export type CustomConnectorRevisionError =
  | { readonly code: "custom_connector_not_found" }
  | { readonly code: "custom_connector_revision_not_found" }
  | { readonly code: "custom_connector_revision_conflict" }
  | {
      readonly code: "custom_connector_validation_failed";
      readonly error: CustomConnectorDefinitionError;
    }
  | {
      readonly code: "custom_connector_approval_review_mismatch";
      readonly field: "origin" | "effects";
    }
  | {
      readonly code: "custom_connector_persistence_corrupt";
      readonly field: string;
    };

type RevisionRow = {
  organisationId: unknown;
  connectorId: unknown;
  revision: unknown;
  authoringDocument: unknown;
  authoringDigest: unknown;
  canonicalDefinition: unknown;
  definitionDigest: unknown;
  reviewState: unknown;
  validatorVersion: unknown;
  validatedAt: unknown;
  lastValidationError: unknown;
  lastValidationAttemptedAt: unknown;
  approvedByUserId: unknown;
  approvedAt: unknown;
  approvedOrigin: unknown;
  approvedEffectsJson: unknown;
  rejectedByUserId: unknown;
  rejectedAt: unknown;
  rejectionReason: unknown;
  retiredByUserId: unknown;
  retiredAt: unknown;
  createdByUserId: unknown;
  createdAt: unknown;
};

const REVISION_SELECT = `SELECT
  organisation_id AS organisationId,
  connector_id AS connectorId,
  revision,
  authoring_document AS authoringDocument,
  authoring_digest AS authoringDigest,
  canonical_definition AS canonicalDefinition,
  definition_digest AS definitionDigest,
  review_state AS reviewState,
  validator_version AS validatorVersion,
  validated_at AS validatedAt,
  last_validation_error AS lastValidationError,
  last_validation_attempted_at AS lastValidationAttemptedAt,
  approved_by_user_id AS approvedByUserId,
  approved_at AS approvedAt,
  approved_origin AS approvedOrigin,
  approved_effects_json AS approvedEffectsJson,
  rejected_by_user_id AS rejectedByUserId,
  rejected_at AS rejectedAt,
  rejection_reason AS rejectionReason,
  retired_by_user_id AS retiredByUserId,
  retired_at AS retiredAt,
  created_by_user_id AS createdByUserId,
  created_at AS createdAt
FROM custom_connector_revision`;

export async function prepareCustomConnectorDraftDocument(
  raw: unknown,
): Promise<
  Result<
    CustomConnectorDraftDocument,
    { readonly code: "custom_connector_draft_invalid" }
  >
> {
  if (!isJsonObject(raw)) {
    return { ok: false, error: { code: "custom_connector_draft_invalid" } };
  }

  const canonicalJson = serializeCanonical(raw);
  if (
    new TextEncoder().encode(canonicalJson).byteLength >
    CUSTOM_CONNECTOR_LIMITS.definitionBytes
  ) {
    return { ok: false, error: { code: "custom_connector_draft_invalid" } };
  }
  const digest = parseCustomConnectorAuthoringDigest(
    await digestCanonical(raw),
  );
  if (!digest.ok) throw new Error("custom connector draft digest is invalid");
  return {
    ok: true,
    value: { value: raw, canonicalJson, digest: digest.value },
  };
}

export async function createCustomConnectorDraft(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly createdByUserId: UserId;
  readonly document: CustomConnectorDraftDocument;
  readonly now: number;
}): Promise<CustomConnectorRevisionRecord> {
  const connectorId = newCustomConnectorId();
  const revision = requireRevision(1);
  const session = input.db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `INSERT INTO custom_connector (
           connector_id, organisation_id, lifecycle, head_revision,
           created_by_user_id, created_at, updated_at
         ) VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .bind(
        connectorId,
        input.organisationId,
        revision,
        input.createdByUserId,
        input.now,
        input.now,
      ),
    insertDraftStatement(session, {
      organisationId: input.organisationId,
      connectorId,
      revision,
      createdByUserId: input.createdByUserId,
      document: input.document,
      now: input.now,
    }),
  ]);
  return requireStoredRevision(
    await resolveCustomConnectorRevision({
      db: session,
      organisationId: input.organisationId,
      connectorId,
      revision,
    }),
  );
}

export async function createCustomConnectorRevision(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly expectedHeadRevision: CustomConnectorRevision;
  readonly createdByUserId: UserId;
  readonly document: CustomConnectorDraftDocument;
  readonly now: number;
}): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const nextRevision = requireRevision(input.expectedHeadRevision + 1);
  const session = input.db.withSession("first-primary");
  const current = await session
    .prepare(
      `SELECT head_revision AS headRevision
       FROM custom_connector
       WHERE organisation_id = ? AND connector_id = ? AND lifecycle != 'removed'`,
    )
    .bind(input.organisationId, input.connectorId)
    .first<{ headRevision: unknown }>();
  if (current === null) {
    return { ok: false, error: { code: "custom_connector_not_found" } };
  }
  if (current.headRevision !== input.expectedHeadRevision) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_conflict" },
    };
  }

  try {
    const results = await session.batch([
      session
        .prepare(
          `UPDATE custom_connector
           SET head_revision = ?, updated_at = ?
           WHERE organisation_id = ? AND connector_id = ? AND head_revision = ?
             AND lifecycle != 'removed'`,
        )
        .bind(
          nextRevision,
          input.now,
          input.organisationId,
          input.connectorId,
          input.expectedHeadRevision,
        ),
      insertDraftStatement(session, {
        organisationId: input.organisationId,
        connectorId: input.connectorId,
        revision: nextRevision,
        createdByUserId: input.createdByUserId,
        document: input.document,
        now: input.now,
      }),
    ]);
    if (results[0]?.meta.changes !== 1) {
      return {
        ok: false,
        error: { code: "custom_connector_revision_conflict" },
      };
    }
  } catch {
    return {
      ok: false,
      error: { code: "custom_connector_revision_conflict" },
    };
  }

  const stored = await resolveCustomConnectorRevision({
    db: session,
    organisationId: input.organisationId,
    connectorId: input.connectorId,
    revision: nextRevision,
  });
  return stored;
}

export async function validateCustomConnectorRevision(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly authoringDigest: CustomConnectorAuthoringDigest;
  readonly now: number;
}): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const current = await resolveCustomConnectorRevision(input);
  if (!current.ok) return current;
  if (
    current.value.reviewState !== "draft" ||
    current.value.authoringDigest !== input.authoringDigest
  ) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_conflict" },
    };
  }

  const validation = await parseCustomConnectorDefinition(
    current.value.authoringDocument,
  );
  if (!validation.ok) {
    const result = await input.db
      .prepare(
        `UPDATE custom_connector_revision
         SET last_validation_error = ?, last_validation_attempted_at = ?
         WHERE organisation_id = ? AND connector_id = ? AND revision = ?
           AND review_state = 'draft' AND authoring_digest = ?`,
      )
      .bind(
        JSON.stringify(validation.error),
        input.now,
        input.organisationId,
        input.connectorId,
        input.revision,
        input.authoringDigest,
      )
      .run();
    if (result.meta.changes !== 1) {
      return {
        ok: false,
        error: { code: "custom_connector_revision_conflict" },
      };
    }
    return {
      ok: false,
      error: {
        code: "custom_connector_validation_failed",
        error: validation.error,
      },
    };
  }

  const result = await input.db
    .prepare(
      `UPDATE custom_connector_revision
       SET review_state = 'validated', canonical_definition = ?,
           definition_digest = ?, validator_version = ?, validated_at = ?,
           last_validation_error = NULL, last_validation_attempted_at = NULL
       WHERE organisation_id = ? AND connector_id = ? AND revision = ?
         AND review_state = 'draft' AND authoring_digest = ?`,
    )
    .bind(
      validation.value.canonicalJson,
      validation.value.digest,
      CUSTOM_CONNECTOR_VALIDATOR_VERSION,
      input.now,
      input.organisationId,
      input.connectorId,
      input.revision,
      input.authoringDigest,
    )
    .run();
  if (result.meta.changes !== 1) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_conflict" },
    };
  }
  return resolveCustomConnectorRevision(input);
}

export async function approveCustomConnectorRevision(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly approvedByUserId: UserId;
  readonly review: CustomConnectorApprovalReview;
  readonly now: number;
}): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const current = await resolveCustomConnectorRevision(input);
  if (
    !current.ok ||
    current.value.reviewState !== "validated" ||
    current.value.definitionDigest !== input.definitionDigest
  ) {
    return current.ok
      ? { ok: false, error: { code: "custom_connector_revision_conflict" } }
      : current;
  }
  if (input.review.origin !== current.value.definition.origin) {
    return {
      ok: false,
      error: {
        code: "custom_connector_approval_review_mismatch",
        field: "origin",
      },
    };
  }
  const expectedEffects = buildApprovalEffects(current.value.definition);
  if (!sameApprovalEffects(input.review.effects, expectedEffects)) {
    return {
      ok: false,
      error: {
        code: "custom_connector_approval_review_mismatch",
        field: "effects",
      },
    };
  }

  const result = await input.db
    .prepare(
      `UPDATE custom_connector_revision
       SET review_state = 'approved', approved_by_user_id = ?,
           approved_at = ?, approved_origin = ?, approved_effects_json = ?
       WHERE organisation_id = ? AND connector_id = ? AND revision = ?
         AND review_state = 'validated' AND definition_digest = ?`,
    )
    .bind(
      input.approvedByUserId,
      input.now,
      input.review.origin,
      JSON.stringify(input.review.effects),
      input.organisationId,
      input.connectorId,
      input.revision,
      input.definitionDigest,
    )
    .run();
  if (result.meta.changes !== 1) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_conflict" },
    };
  }
  return resolveCustomConnectorRevision(input);
}

export const CUSTOM_CONNECTOR_REJECTION_REASON_MAX_LENGTH = 500;

/**
 * Closes a validated revision without approval. The revision stays immutable
 * history; a corrected definition is a new revision on the head.
 */
export async function rejectCustomConnectorRevision(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly rejectedByUserId: UserId;
  readonly reason: string;
  readonly now: number;
}): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const current = await resolveCustomConnectorRevision(input);
  if (
    !current.ok ||
    current.value.reviewState !== "validated" ||
    current.value.definitionDigest !== input.definitionDigest
  ) {
    return current.ok
      ? { ok: false, error: { code: "custom_connector_revision_conflict" } }
      : current;
  }

  const result = await input.db
    .prepare(
      `UPDATE custom_connector_revision
       SET review_state = 'rejected', rejected_by_user_id = ?,
           rejected_at = ?, rejection_reason = ?
       WHERE organisation_id = ? AND connector_id = ? AND revision = ?
         AND review_state = 'validated' AND definition_digest = ?`,
    )
    .bind(
      input.rejectedByUserId,
      input.now,
      input.reason,
      input.organisationId,
      input.connectorId,
      input.revision,
      input.definitionDigest,
    )
    .run();
  if (result.meta.changes !== 1) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_conflict" },
    };
  }
  return resolveCustomConnectorRevision(input);
}

export async function resolveCustomConnectorRevision(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
}): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const row = await input.db
    .prepare(
      `${REVISION_SELECT}
       WHERE organisation_id = ? AND connector_id = ? AND revision = ?`,
    )
    .bind(input.organisationId, input.connectorId, input.revision)
    .first<RevisionRow>();
  if (row === null) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_not_found" },
    };
  }
  return parseRevisionRow(row);
}

function insertDraftStatement(
  source: Pick<OrganisationDatabase, "prepare">,
  input: {
    readonly organisationId: OrganisationId;
    readonly connectorId: CustomConnectorId;
    readonly revision: CustomConnectorRevision;
    readonly createdByUserId: UserId;
    readonly document: CustomConnectorDraftDocument;
    readonly now: number;
  },
) {
  return source
    .prepare(
      `INSERT INTO custom_connector_revision (
         organisation_id, connector_id, revision, authoring_document,
         authoring_digest, review_state, created_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .bind(
      input.organisationId,
      input.connectorId,
      input.revision,
      input.document.canonicalJson,
      input.document.digest,
      input.createdByUserId,
      input.now,
    );
}

async function parseRevisionRow(
  row: RevisionRow,
): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const base = parseRevisionBase(row);
  if (!base.ok) return base;
  switch (row.reviewState) {
    case "draft":
      return parseDraftRevision(base.value, row);
    case "validated":
      return parseValidatedRevision(base.value, row);
    case "approved":
      return parseApprovedRevision(base.value, row);
    case "rejected":
      return parseRejectedRevision(base.value, row);
    case "retired":
      return parseRetiredRevision(base.value, row);
    default:
      return corrupt("reviewState");
  }
}

function parseRevisionBase(
  row: RevisionRow,
): Result<CustomConnectorRevisionBase, CustomConnectorRevisionError> {
  const organisationId = parseOrganisationIdValue(row.organisationId);
  if (!organisationId.ok) return organisationId;
  const connectorId = parseCustomConnectorId(row.connectorId);
  if (!connectorId.ok) return corrupt("connectorId");
  const revision = parseCustomConnectorRevision(row.revision);
  if (!revision.ok) return corrupt("revision");
  const authoringDocument = parseStoredJsonObject(row.authoringDocument);
  if (!authoringDocument.ok) return authoringDocument;
  const authoringDigest = parseCustomConnectorAuthoringDigest(
    row.authoringDigest,
  );
  if (!authoringDigest.ok) return corrupt("authoringDigest");
  const createdBy = parseUserIdValue(
    row.createdByUserId,
    "createdByUserId",
  );
  if (!createdBy.ok) return createdBy;
  const createdAt = parseTimestamp(row.createdAt, "createdAt");
  if (!createdAt.ok) return createdAt;
  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      connectorId: connectorId.value,
      revision: revision.value,
      authoringDocument: authoringDocument.value,
      authoringDigest: authoringDigest.value,
      createdByUserId: createdBy.value,
      createdAt: createdAt.value,
    },
  };
}

function parseDraftRevision(
  base: CustomConnectorRevisionBase,
  row: RevisionRow,
): Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError> {
  const failure = parseValidationFailure(row.lastValidationError);
  if (!failure.ok) return failure;
  const attemptedAt = parseNullableTimestamp(
    row.lastValidationAttemptedAt,
    "lastValidationAttemptedAt",
  );
  if (!attemptedAt.ok) return attemptedAt;
  return {
    ok: true,
    value: {
      ...base,
      reviewState: "draft",
      validationFailure: failure.value,
      lastValidationAttemptedAt: attemptedAt.value,
    },
  };
}

async function parseValidatedRevision(
  base: CustomConnectorRevisionBase,
  row: RevisionRow,
): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const definition = await parseStoredDefinition(row);
  if (!definition.ok) return definition;
  return {
    ok: true,
    value: {
      ...base,
      reviewState: "validated",
      definition: definition.value.definition,
      definitionDigest: definition.value.digest,
      validatedAt: definition.value.validatedAt,
    },
  };
}

async function parseApprovedRevision(
  base: CustomConnectorRevisionBase,
  row: RevisionRow,
): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const definition = await parseStoredDefinition(row);
  if (!definition.ok) return definition;
  const approval = parseApproval(row);
  if (!approval.ok) return approval;
  return {
    ok: true,
    value: {
      ...base,
      reviewState: "approved",
      definition: definition.value.definition,
      definitionDigest: definition.value.digest,
      validatedAt: definition.value.validatedAt,
      approval: approval.value,
    },
  };
}

async function parseRejectedRevision(
  base: CustomConnectorRevisionBase,
  row: RevisionRow,
): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const definition = await parseStoredDefinition(row);
  if (!definition.ok) return definition;
  const rejectedBy = parseUserIdValue(
    row.rejectedByUserId,
    "rejectedByUserId",
  );
  if (!rejectedBy.ok) return rejectedBy;
  const rejectedAt = parseTimestamp(row.rejectedAt, "rejectedAt");
  if (!rejectedAt.ok) return rejectedAt;
  if (typeof row.rejectionReason !== "string")
    return corrupt("rejectionReason");
  return {
    ok: true,
    value: {
      ...base,
      reviewState: "rejected",
      definition: definition.value.definition,
      definitionDigest: definition.value.digest,
      validatedAt: definition.value.validatedAt,
      rejection: {
        rejectedByUserId: rejectedBy.value,
        rejectedAt: rejectedAt.value,
        reason: row.rejectionReason,
      },
    },
  };
}

async function parseRetiredRevision(
  base: CustomConnectorRevisionBase,
  row: RevisionRow,
): Promise<
  Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>
> {
  const definition = await parseStoredDefinition(row);
  if (!definition.ok) return definition;
  const approval = parseApproval(row);
  if (!approval.ok) return approval;
  const retiredBy = parseUserIdValue(
    row.retiredByUserId,
    "retiredByUserId",
  );
  if (!retiredBy.ok) return retiredBy;
  const retiredAt = parseTimestamp(row.retiredAt, "retiredAt");
  if (!retiredAt.ok) return retiredAt;
  return {
    ok: true,
    value: {
      ...base,
      reviewState: "retired",
      definition: definition.value.definition,
      definitionDigest: definition.value.digest,
      validatedAt: definition.value.validatedAt,
      approval: approval.value,
      retirement: {
        retiredByUserId: retiredBy.value,
        retiredAt: retiredAt.value,
      },
    },
  };
}

async function parseStoredDefinition(row: RevisionRow): Promise<
  Result<
    {
      readonly definition: ParsedCustomConnectorDefinition["definition"];
      readonly digest: CustomConnectorDefinitionDigest;
      readonly validatedAt: number;
    },
    CustomConnectorRevisionError
  >
> {
  if (row.validatorVersion !== CUSTOM_CONNECTOR_VALIDATOR_VERSION) {
    return corrupt("validatorVersion");
  }
  const authoringDocument = parseStoredJsonObject(row.authoringDocument);
  if (!authoringDocument.ok) return corrupt("authoringDocument");
  const definition = await parseCustomConnectorDefinition(
    authoringDocument.value,
  );
  if (!definition.ok) return corrupt("canonicalDefinition");
  if (row.canonicalDefinition !== definition.value.canonicalJson) {
    return corrupt("canonicalDefinition");
  }
  const digest = parseCustomConnectorDefinitionDigest(row.definitionDigest);
  if (!digest.ok || digest.value !== definition.value.digest) {
    return corrupt("definitionDigest");
  }
  const validatedAt = parseTimestamp(row.validatedAt, "validatedAt");
  if (!validatedAt.ok) return validatedAt;
  return {
    ok: true,
    value: {
      definition: definition.value.definition,
      digest: digest.value,
      validatedAt: validatedAt.value,
    },
  };
}

function parseApproval(row: RevisionRow): Result<
  CustomConnectorApprovalReview & {
    readonly approvedByUserId: UserId;
    readonly approvedAt: number;
  },
  CustomConnectorRevisionError
> {
  const approvedBy = parseUserIdValue(
    row.approvedByUserId,
    "approvedByUserId",
  );
  if (!approvedBy.ok) return approvedBy;
  const approvedAt = parseTimestamp(row.approvedAt, "approvedAt");
  if (!approvedAt.ok) return approvedAt;
  if (typeof row.approvedOrigin !== "string") return corrupt("approvedOrigin");
  const effects = parseApprovalEffects(row.approvedEffectsJson);
  if (!effects.ok) return effects;
  return {
    ok: true,
    value: {
      approvedByUserId: approvedBy.value,
      approvedAt: approvedAt.value,
      origin: row.approvedOrigin,
      effects: effects.value,
    },
  };
}

function parseApprovalEffects(
  raw: unknown,
): Result<
  CustomConnectorApprovalReview["effects"],
  CustomConnectorRevisionError
> {
  if (typeof raw !== "string") return corrupt("approvedEffectsJson");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt("approvedEffectsJson");
  }
  if (!Array.isArray(parsed)) return corrupt("approvedEffectsJson");
  const effects: CustomConnectorApprovalReview["effects"][number][] = [];
  for (const item of parsed) {
    if (!isJsonObject(item)) return corrupt("approvedEffectsJson");
    if (
      typeof item.operationId !== "string" ||
      (item.effect !== "read" &&
        item.effect !== "external_record_create" &&
        item.effect !== "external_record_update")
    ) {
      return corrupt("approvedEffectsJson");
    }
    effects.push({ operationId: item.operationId, effect: item.effect });
  }
  return { ok: true, value: effects };
}

function buildApprovalEffects(
  definition: ParsedCustomConnectorDefinition["definition"],
): CustomConnectorApprovalReview["effects"] {
  const effects: CustomConnectorApprovalReview["effects"][number][] = [];
  for (const operation of definition.operations) {
    effects.push({ operationId: operation.id, effect: operation.effect.kind });
  }
  return effects;
}

function sameApprovalEffects(
  left: CustomConnectorApprovalReview["effects"],
  right: CustomConnectorApprovalReview["effects"],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]?.operationId !== right[index]?.operationId ||
      left[index]?.effect !== right[index]?.effect
    ) {
      return false;
    }
  }
  return true;
}

function parseValidationFailure(
  raw: unknown,
): Result<CustomConnectorDefinitionError | null, CustomConnectorRevisionError> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return corrupt("lastValidationError");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt("lastValidationError");
  }
  if (!isJsonObject(parsed) || typeof parsed.code !== "string") {
    return corrupt("lastValidationError");
  }
  if (parsed.code === "definition_too_large") {
    if (typeof parsed.maxBytes !== "number")
      return corrupt("lastValidationError");
    return {
      ok: true,
      value: { code: "definition_too_large", maxBytes: parsed.maxBytes },
    };
  }
  if (
    parsed.code === "definition_invalid" ||
    parsed.code === "unsupported_contract"
  ) {
    if (typeof parsed.field !== "string" || typeof parsed.reason !== "string") {
      return corrupt("lastValidationError");
    }
    return {
      ok: true,
      value: { code: parsed.code, field: parsed.field, reason: parsed.reason },
    };
  }
  return corrupt("lastValidationError");
}

function parseStoredJsonObject(
  raw: unknown,
): Result<JsonObject, CustomConnectorRevisionError> {
  if (typeof raw !== "string") return corrupt("json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt("json");
  }
  return isJsonObject(parsed) ? { ok: true, value: parsed } : corrupt("json");
}

function isJsonObject(raw: unknown): raw is JsonObject {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return false;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const value of Object.values(raw)) {
    if (!isJsonValue(value)) return false;
  }
  return true;
}

function isJsonValue(raw: unknown): boolean {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") {
    return true;
  }
  if (typeof raw === "number") return Number.isFinite(raw);
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!isJsonValue(value)) return false;
    }
    return true;
  }
  return isJsonObject(raw);
}

function parseOrganisationIdValue(
  raw: unknown,
): Result<OrganisationId, CustomConnectorRevisionError> {
  if (typeof raw !== "string") return corrupt("organisationId");
  const parsed = parseOrganisationId(raw);
  return parsed.ok ? parsed : corrupt("organisationId");
}

function parseUserIdValue(
  raw: unknown,
  field: string,
): Result<UserId, CustomConnectorRevisionError> {
  if (typeof raw !== "string") return corrupt(field);
  const parsed = parseUserId(raw);
  return parsed.ok ? parsed : corrupt(field);
}

function parseTimestamp(
  raw: unknown,
  field: string,
): Result<number, CustomConnectorRevisionError> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? { ok: true, value: raw }
    : corrupt(field);
}

function parseNullableTimestamp(
  raw: unknown,
  field: string,
): Result<number | null, CustomConnectorRevisionError> {
  return raw === null ? { ok: true, value: null } : parseTimestamp(raw, field);
}

function requireRevision(raw: number): CustomConnectorRevision {
  const parsed = parseCustomConnectorRevision(raw);
  if (!parsed.ok) throw new Error("custom connector revision is invalid");
  return parsed.value;
}

function requireStoredRevision(
  result: Result<CustomConnectorRevisionRecord, CustomConnectorRevisionError>,
): CustomConnectorRevisionRecord {
  if (!result.ok)
    throw new Error(
      `custom connector revision invariant failed: ${result.error.code}`,
    );
  return result.value;
}

function corrupt(field: string): Result<never, CustomConnectorRevisionError> {
  return {
    ok: false,
    error: { code: "custom_connector_persistence_corrupt", field },
  };
}
