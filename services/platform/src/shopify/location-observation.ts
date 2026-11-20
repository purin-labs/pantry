import type {
  LocationKind,
  ShopifyResourceEnvelopeV202607,
} from "@purin-labs/commerce-contracts";

import {
  normalizeShopifyCommerceResourceDelivery,
} from "./delivery-normalizers";
import {
  parseUserId,
  parseIntegrationAccountId,
  parseOrganisationId,
  type UserId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import type {
  CommerceSystemError,
  CommerceSystemProviderAuthority,
} from "../data/organisation-commerce-system";
import {
  commerceDeliveryIntake,
  type AppliedCommerceDeliveryResult,
  type CommerceProjectionError,
  type CommerceSystemStorageAuthority,
  type CommerceWasmError,
} from "../commerce/contract/delivery-intake";
import type { VariantBy } from "@purin-labs/type-utils";
import { exhaustiveList, isRecord } from "@purin-labs/std";

const SHOPIFY_LOCATION_CLASSIFICATION_KINDS = exhaustiveList<LocationKind>()([
  "store",
  "warehouse",
  "fulfillment_center",
  "pickup_point",
]);

type ShopifyLocationClassificationKind =
  (typeof SHOPIFY_LOCATION_CLASSIFICATION_KINDS)[number];

type ShopifyLocationObservationProjectionAuthority =
  | Readonly<{ kind: "unselected" }>
  | Readonly<{
      kind: "selected";
      commerceSystem: Readonly<{ kind: "shopify"; revision: number }>;
    }>;

type ShopifyLocationObservationClassification =
  | {
      readonly state: "pending";
      readonly reason: "provider_location_kind_unmapped";
    }
  | {
      readonly state: "assigned";
      readonly kind: ShopifyLocationClassificationKind;
      readonly classifiedByUserId: UserId;
      readonly mappingRevision: number;
      readonly classifiedAt: number;
    };

export type ShopifyLocationObservationInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerLocationId: string;
  readonly providerLocationGid: string;
  readonly sourceRevision: number;
  readonly eventId: string;
  readonly name: string;
  readonly active: boolean;
  readonly updatedAt: string;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly classification: VariantBy<
    ShopifyLocationObservationClassification,
    "state",
    "pending"
  >;
  readonly acceptedAt: number;
};

export type ShopifyLocationObservation = Omit<
  ShopifyLocationObservationInput,
  "classification"
> & {
  readonly classification: ShopifyLocationObservationClassification;
};

export type AssignShopifyLocationClassificationInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerLocationId: string;
  readonly expectedSourceRevision: number;
  readonly kind: ShopifyLocationClassificationKind;
  readonly classifiedByUserId: UserId;
  readonly mappingRevision: number;
  readonly classifiedAt: number;
};

export type ShopifyLocationClassificationAssignmentResult = {
  readonly disposition: "assigned" | "already_assigned";
  readonly observation: ShopifyLocationObservation;
  readonly projection: AppliedCommerceDeliveryResult;
};

type ShopifyLocationObservationDisposition =
  "applied" | "duplicate" | "out_of_order";

export type ShopifyLocationObservationResult = {
  readonly disposition: ShopifyLocationObservationDisposition;
  readonly observation: ShopifyLocationObservation;
};

export type ShopifyLocationObservationError =
  | {
      readonly code: "shopify_location_observation_invalid";
      readonly field: string;
    }
  | {
      readonly code: "shopify_location_observation_conflict";
      readonly sourceRevision: number;
    }
  | { readonly code: "shopify_location_observation_missing" }
  | {
      readonly code: "shopify_location_source_revision_mismatch";
      readonly expectedSourceRevision: number;
      readonly actualSourceRevision: number;
    }
  | {
      readonly code: "shopify_location_classification_conflict";
      readonly mappingRevision: number;
    }
  | { readonly code: "shopify_location_observation_corrupt" };

export type ShopifyLocationClassificationAssignmentError =
  ShopifyLocationObservationError | CommerceWasmError | CommerceProjectionError;

export type ShopifyLocationObservationAcceptanceError =
  ShopifyLocationObservationError | CommerceWasmError | CommerceProjectionError;

type ShopifyLocationObservationRow = Record<string, SqlStorageValue> & {
  readonly organisation_id: string;
  readonly integration_account_id: string;
  readonly provider_location_id: string;
  readonly provider_location_gid: string;
  readonly source_revision: number;
  readonly event_id: string;
  readonly name: string;
  readonly active: number;
  readonly updated_at: string;
  readonly classification_state: string;
  readonly classification_kind: string | null;
  readonly classified_by_user_id: string | null;
  readonly mapping_revision: number | null;
  readonly classified_at: number | null;
  readonly occurred_at: string;
  readonly observed_at: string;
  readonly accepted_at: number;
};

export function createShopifyLocationObservationSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS shopify_location_observation (
      organisation_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      provider_location_id TEXT NOT NULL,
      provider_location_gid TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      updated_at TEXT NOT NULL,
      classification_state TEXT NOT NULL CHECK (classification_state IN ('pending', 'assigned')),
      classification_kind TEXT,
      classified_by_user_id TEXT,
      mapping_revision INTEGER CHECK (mapping_revision IS NULL OR mapping_revision >= 1),
      classified_at INTEGER CHECK (classified_at IS NULL OR classified_at >= 0),
      occurred_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
      PRIMARY KEY (organisation_id, integration_account_id, provider_location_id),
      CHECK (
        (classification_state = 'pending' AND classification_kind IS NULL
          AND classified_by_user_id IS NULL AND mapping_revision IS NULL
          AND classified_at IS NULL)
        OR
        (classification_state = 'assigned' AND classification_kind IS NOT NULL
          AND classified_by_user_id IS NOT NULL AND mapping_revision IS NOT NULL
          AND classified_at IS NOT NULL)
      )
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS shopify_location_observation_revision
       ON shopify_location_observation (organisation_id, source_revision)`,
  );
}

export function parseShopifyLocationObservationEnvelope(
  raw: unknown,
  acceptedAt: number,
): Result<ShopifyLocationObservationInput, ShopifyLocationObservationError> {
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
    return invalid("acceptedAt");
  }
  if (!isRecord(raw)) {
    return invalid("envelope");
  }
  if (raw.apiVersion !== "2026-07") {
    return invalid("apiVersion");
  }
  const context = raw.context;
  if (!isRecord(context)) {
    return invalid("context");
  }
  const resource = raw.resource;
  if (
    !isRecord(resource) ||
    resource.kind !== "location" ||
    !isRecord(resource.resource)
  ) {
    return invalid("resource");
  }
  const location = resource.resource;
  const organisationId = parseStringId(context.organisationId, parseOrganisationId, "organisationId");
  if (!organisationId.ok) return organisationId;
  const integrationAccountId = parseStringId(
    context.integrationAccountId,
    parseIntegrationAccountId,
    "integrationAccountId",
  );
  if (!integrationAccountId.ok) return integrationAccountId;
  const sourceRevision = context.revision;
  if (
    typeof sourceRevision !== "number" ||
    !Number.isSafeInteger(sourceRevision) ||
    sourceRevision < 1
  ) {
    return invalid("context.revision");
  }
  const eventId = requiredText(context.eventId, "context.eventId");
  if (!eventId.ok) return eventId;
  const name = requiredText(location.name, "resource.resource.name");
  if (!name.ok) return name;
  const providerIdentity = parseProviderLocationGid(location.id);
  if (!providerIdentity.ok) return providerIdentity;
  if (typeof location.active !== "boolean") {
    return invalid("resource.resource.active");
  }
  const updatedAt = requiredTimestamp(
    location.updatedAt,
    "resource.resource.updatedAt",
  );
  if (!updatedAt.ok) return updatedAt;
  const occurredAt = requiredTimestamp(
    context.occurredAt,
    "context.occurredAt",
  );
  if (!occurredAt.ok) return occurredAt;
  const observedAt = requiredTimestamp(
    context.observedAt,
    "context.observedAt",
  );
  if (!observedAt.ok) return observedAt;
  const classification = parseClassification(location.classification);
  if (!classification.ok) return classification;
  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      providerLocationId: providerIdentity.value.providerLocationId,
      providerLocationGid: providerIdentity.value.providerLocationGid,
      sourceRevision,
      eventId: eventId.value,
      name: name.value,
      active: location.active,
      updatedAt: updatedAt.value,
      occurredAt: occurredAt.value,
      observedAt: observedAt.value,
      classification: classification.value,
      acceptedAt,
    },
  };
}

export function acceptShopifyLocationObservation(
  sql: SqlStorage,
  input: ShopifyLocationObservationInput,
  authority: ShopifyLocationObservationProjectionAuthority,
): Result<
  ShopifyLocationObservationResult,
  ShopifyLocationObservationAcceptanceError
> {
  const validated = validateObservationInput(input);
  if (!validated.ok) return validated;
  const existing = readObservationRow(sql, input);
  if (existing === undefined) {
    insertObservation(sql, input);
    return { ok: true, value: { disposition: "applied", observation: input } };
  }
  const parsed = parseObservationRow(existing);
  if (!parsed.ok) return parsed;
  if (input.sourceRevision < parsed.value.sourceRevision) {
    return {
      ok: true,
      value: { disposition: "out_of_order", observation: parsed.value },
    };
  }
  if (input.sourceRevision === parsed.value.sourceRevision) {
    if (!sameObservationFacts(parsed.value, input)) {
      return {
        ok: false,
        error: {
          code: "shopify_location_observation_conflict",
          sourceRevision: input.sourceRevision,
        },
      };
    }
    return {
      ok: true,
      value: { disposition: "duplicate", observation: parsed.value },
    };
  }
  const next: ShopifyLocationObservation = {
    ...input,
    classification:
      parsed.value.classification.state === "assigned"
        ? parsed.value.classification
        : input.classification,
  };
  if (
    next.classification.state === "assigned" &&
    authority.kind === "selected"
  ) {
    const projection = projectAssignedShopifyLocationObservation(
      sql,
      next,
      input.acceptedAt,
      authority.commerceSystem,
    );
    if (!projection.ok) return projection;
  }
  updateObservation(sql, next);
  return { ok: true, value: { disposition: "applied", observation: next } };
}

export function readShopifyLocationObservation(
  sql: SqlStorage,
  input: Pick<
    ShopifyLocationObservationInput,
    "organisationId" | "integrationAccountId" | "providerLocationId"
  >,
): Result<ShopifyLocationObservation | null, ShopifyLocationObservationError> {
  const row = sql
    .exec<ShopifyLocationObservationRow>(
      `SELECT organisation_id, integration_account_id, provider_location_id, provider_location_gid,
            source_revision, event_id, name, active, updated_at, classification_state,
            classification_kind, classified_by_user_id, mapping_revision,
            classified_at, occurred_at, observed_at, accepted_at
       FROM shopify_location_observation
      WHERE organisation_id = ? AND integration_account_id = ? AND provider_location_id = ?
      LIMIT 1`,
      input.organisationId,
      input.integrationAccountId,
      input.providerLocationId,
    )
    .toArray()[0];
  if (row === undefined) return { ok: true, value: null };
  return parseObservationRow(row);
}

/**
 * The authority of an observed location: the selected shop when it is this
 * integration account, or none. An unselected shop keeps its observation.
 */
export function shopifyLocationProjectionAuthority(
  selected: Result<CommerceSystemProviderAuthority, CommerceSystemError>,
  integrationAccountId: IntegrationAccountId,
): ShopifyLocationObservationProjectionAuthority {
  return selected.ok &&
    selected.value.provider === "shopify" &&
    selected.value.integrationAccountId === integrationAccountId
    ? {
        kind: "selected",
        commerceSystem: {
          kind: "shopify",
          revision: selected.value.commerceSystem.revision,
        },
      }
    : { kind: "unselected" };
}

/** The selected shop that a classification of a location changes. */
export function shopifyLocationClassificationAuthority(
  selected: Result<CommerceSystemProviderAuthority, CommerceSystemError>,
  integrationAccountId: IntegrationAccountId,
): Result<
  CommerceSystemStorageAuthority,
  Readonly<{ code: "commerce_system_authority_mismatch" }>
> {
  return selected.ok &&
    selected.value.provider === "shopify" &&
    selected.value.integrationAccountId === integrationAccountId
    ? {
        ok: true,
        value: {
          kind: "shopify",
          revision: selected.value.commerceSystem.revision,
        },
      }
    : { ok: false, error: { code: "commerce_system_authority_mismatch" } };
}

export function assignShopifyLocationClassification(
  sql: SqlStorage,
  input: AssignShopifyLocationClassificationInput,
  commerceSystem: CommerceSystemStorageAuthority,
): Result<
  ShopifyLocationClassificationAssignmentResult,
  ShopifyLocationClassificationAssignmentError
> {
  const validated = validateClassificationAssignmentInput(input);
  if (!validated.ok) return validated;
  const current = readShopifyLocationObservation(sql, input);
  if (!current.ok) return current;
  if (current.value === null) {
    return {
      ok: false,
      error: { code: "shopify_location_observation_missing" },
    };
  }
  if (current.value.sourceRevision !== input.expectedSourceRevision) {
    return {
      ok: false,
      error: {
        code: "shopify_location_source_revision_mismatch",
        expectedSourceRevision: input.expectedSourceRevision,
        actualSourceRevision: current.value.sourceRevision,
      },
    };
  }
  if (input.classifiedAt < current.value.acceptedAt) {
    return invalid("classifiedAt");
  }

  const disposition = classificationAssignmentDisposition(current.value, input);
  if (!disposition.ok) return disposition;
  const observation: ShopifyLocationObservation = {
    ...current.value,
    classification: {
      state: "assigned",
      kind: input.kind,
      classifiedByUserId: input.classifiedByUserId,
      mappingRevision: input.mappingRevision,
      classifiedAt: input.classifiedAt,
    },
  };
  const projection = projectAssignedShopifyLocationObservation(
    sql,
    observation,
    input.classifiedAt,
    commerceSystem,
  );
  if (!projection.ok) return projection;
  updateObservation(sql, observation);
  return {
    ok: true,
    value: {
      disposition: disposition.value,
      observation,
      projection: projection.value,
    },
  };
}

function projectAssignedShopifyLocationObservation(
  sql: SqlStorage,
  observation: ShopifyLocationObservation,
  processedAt: number,
  commerceSystem: CommerceSystemStorageAuthority,
): Result<
  AppliedCommerceDeliveryResult,
  CommerceWasmError | CommerceProjectionError
> {
  const normalized = normalizeShopifyCommerceResourceDelivery(
    createAssignedLocationEnvelope(observation),
  );
  if (!normalized.ok) return normalized;
  return commerceDeliveryIntake.use().applyCommerceDelivery(
    sql,
    {
      organisationId: observation.organisationId,
      integrationAccountId: observation.integrationAccountId,
      delivery: normalized.value,
      cueFacts: [],
      labRunId: null,
      processedAt,
    },
    commerceSystem,
  );
}

function validateClassificationAssignmentInput(
  input: AssignShopifyLocationClassificationInput,
): Result<null, ShopifyLocationObservationError> {
  if (!parseOrganisationId(input.organisationId).ok) return invalid("organisationId");
  if (!parseIntegrationAccountId(input.integrationAccountId).ok) {
    return invalid("integrationAccountId");
  }
  if (!isShopifyLocationId(input.providerLocationId))
    return invalid("providerLocationId");
  if (
    !Number.isSafeInteger(input.expectedSourceRevision) ||
    input.expectedSourceRevision < 1
  ) {
    return invalid("expectedSourceRevision");
  }
  if (!isLocationKind(input.kind)) return invalid("kind");
  if (!parseUserId(input.classifiedByUserId).ok) {
    return invalid("classifiedByUserId");
  }
  if (
    !Number.isSafeInteger(input.mappingRevision) ||
    input.mappingRevision < 1
  ) {
    return invalid("mappingRevision");
  }
  if (!Number.isSafeInteger(input.classifiedAt) || input.classifiedAt < 0) {
    return invalid("classifiedAt");
  }
  return { ok: true, value: null };
}

function classificationAssignmentDisposition(
  observation: ShopifyLocationObservation,
  input: AssignShopifyLocationClassificationInput,
): Result<"assigned" | "already_assigned", ShopifyLocationObservationError> {
  if (observation.classification.state === "pending") {
    return { ok: true, value: "assigned" };
  }
  if (
    observation.classification.kind === input.kind &&
    observation.classification.classifiedByUserId ===
      input.classifiedByUserId &&
    observation.classification.mappingRevision === input.mappingRevision &&
    observation.classification.classifiedAt === input.classifiedAt
  ) {
    return { ok: true, value: "already_assigned" };
  }
  return {
    ok: false,
    error: {
      code: "shopify_location_classification_conflict",
      mappingRevision: observation.classification.mappingRevision,
    },
  };
}

function createAssignedLocationEnvelope(
  observation: ShopifyLocationObservation,
): ShopifyResourceEnvelopeV202607 {
  if (observation.classification.state !== "assigned") {
    throw new Error("assigned Shopify location classification required");
  }
  return {
    apiVersion: "2026-07",
    context: {
      organisationId: observation.organisationId,
      integrationAccountId: observation.integrationAccountId,
      revision: observation.sourceRevision,
      occurredAt: observation.occurredAt,
      observedAt: observation.observedAt,
      eventId: shopifyLocationClassificationEventId(observation),
      customerReference: observation.providerLocationGid,
    },
    resource: {
      kind: "location",
      resource: {
        id: observation.providerLocationGid,
        name: observation.name,
        classification: {
          state: "assigned",
          kind: observation.classification.kind,
        },
        active: observation.active,
        updatedAt: observation.updatedAt,
      },
    },
  };
}

function shopifyLocationClassificationEventId(
  observation: ShopifyLocationObservation,
): string {
  if (observation.classification.state !== "assigned") {
    throw new Error("assigned Shopify location classification required");
  }
  return [
    "shopify-location-classification",
    observation.integrationAccountId,
    observation.providerLocationId,
    observation.sourceRevision,
    observation.classification.mappingRevision,
  ].join(":");
}

function validateObservationInput(
  input: ShopifyLocationObservationInput,
): Result<null, ShopifyLocationObservationError> {
  if (typeof input.organisationId !== "string") return invalid("organisationId");
  if (!parseOrganisationId(input.organisationId).ok) return invalid("organisationId");
  if (typeof input.integrationAccountId !== "string")
    return invalid("integrationAccountId");
  if (!parseIntegrationAccountId(input.integrationAccountId).ok) {
    return invalid("integrationAccountId");
  }
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) {
    return invalid("sourceRevision");
  }
  if (!Number.isSafeInteger(input.acceptedAt) || input.acceptedAt < 0) {
    return invalid("acceptedAt");
  }
  if (!isShopifyLocationId(input.providerLocationId)) {
    return invalid("providerLocationId");
  }
  if (
    !isShopifyLocationGid(input.providerLocationGid, input.providerLocationId)
  ) {
    return invalid("providerLocationGid");
  }
  if (typeof input.eventId !== "string" || input.eventId.length === 0)
    return invalid("eventId");
  if (typeof input.name !== "string" || input.name.length === 0)
    return invalid("name");
  if (typeof input.updatedAt !== "string" || !isTimestamp(input.updatedAt))
    return invalid("updatedAt");
  if (typeof input.occurredAt !== "string" || !isTimestamp(input.occurredAt))
    return invalid("occurredAt");
  if (typeof input.observedAt !== "string" || !isTimestamp(input.observedAt))
    return invalid("observedAt");
  if (
    !isRecord(input.classification) ||
    input.classification.state !== "pending"
  ) {
    return invalid("classification");
  }
  if (input.classification.reason !== "provider_location_kind_unmapped") {
    return invalid("classification.reason");
  }
  return { ok: true, value: null };
}

function readObservationRow(
  sql: SqlStorage,
  input: Pick<
    ShopifyLocationObservationInput,
    "organisationId" | "integrationAccountId" | "providerLocationId"
  >,
): ShopifyLocationObservationRow | undefined {
  return sql
    .exec<ShopifyLocationObservationRow>(
      `SELECT organisation_id, integration_account_id, provider_location_id, provider_location_gid,
            source_revision, event_id, name, active, updated_at, classification_state,
            classification_kind, classified_by_user_id, mapping_revision,
            classified_at, occurred_at, observed_at, accepted_at
       FROM shopify_location_observation
      WHERE organisation_id = ? AND integration_account_id = ? AND provider_location_id = ?
      LIMIT 1`,
      input.organisationId,
      input.integrationAccountId,
      input.providerLocationId,
    )
    .toArray()[0];
}

function insertObservation(
  sql: SqlStorage,
  input: ShopifyLocationObservation,
): void {
  sql.exec(
    `INSERT INTO shopify_location_observation (
       organisation_id, integration_account_id, provider_location_id, provider_location_gid, source_revision,
       event_id, name, active, updated_at, classification_state, classification_kind,
       classified_by_user_id, mapping_revision, classified_at,
       occurred_at, observed_at, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.organisationId,
    input.integrationAccountId,
    input.providerLocationId,
    input.providerLocationGid,
    input.sourceRevision,
    input.eventId,
    input.name,
    input.active ? 1 : 0,
    input.updatedAt,
    input.classification.state,
    input.classification.state === "assigned"
      ? input.classification.kind
      : null,
    input.classification.state === "assigned"
      ? input.classification.classifiedByUserId
      : null,
    input.classification.state === "assigned"
      ? input.classification.mappingRevision
      : null,
    input.classification.state === "assigned"
      ? input.classification.classifiedAt
      : null,
    input.occurredAt,
    input.observedAt,
    input.acceptedAt,
  );
}

function updateObservation(
  sql: SqlStorage,
  input: ShopifyLocationObservation,
): void {
  sql.exec(
    `UPDATE shopify_location_observation
        SET provider_location_gid = ?, source_revision = ?, event_id = ?, name = ?, active = ?, updated_at = ?,
            classification_state = ?, classification_kind = ?, classified_by_user_id = ?,
            mapping_revision = ?, classified_at = ?, occurred_at = ?, observed_at = ?, accepted_at = ?
      WHERE organisation_id = ? AND integration_account_id = ? AND provider_location_id = ?`,
    input.providerLocationGid,
    input.sourceRevision,
    input.eventId,
    input.name,
    input.active ? 1 : 0,
    input.updatedAt,
    input.classification.state,
    input.classification.state === "assigned"
      ? input.classification.kind
      : null,
    input.classification.state === "assigned"
      ? input.classification.classifiedByUserId
      : null,
    input.classification.state === "assigned"
      ? input.classification.mappingRevision
      : null,
    input.classification.state === "assigned"
      ? input.classification.classifiedAt
      : null,
    input.occurredAt,
    input.observedAt,
    input.acceptedAt,
    input.organisationId,
    input.integrationAccountId,
    input.providerLocationId,
  );
}

function parseObservationRow(
  row: ShopifyLocationObservationRow,
): Result<ShopifyLocationObservation, ShopifyLocationObservationError> {
  if (
    row.organisation_id.length === 0 ||
    row.integration_account_id.length === 0 ||
    !isShopifyLocationId(row.provider_location_id) ||
    !isShopifyLocationGid(
      row.provider_location_gid,
      row.provider_location_id,
    ) ||
    !Number.isSafeInteger(row.source_revision) ||
    row.source_revision < 1 ||
    row.event_id.length === 0 ||
    row.name.length === 0 ||
    (row.active !== 0 && row.active !== 1) ||
    !isTimestamp(row.updated_at) ||
    !Number.isSafeInteger(row.accepted_at) ||
    row.accepted_at < 0 ||
    !isTimestamp(row.occurred_at) ||
    !isTimestamp(row.observed_at)
  ) {
    return {
      ok: false,
      error: { code: "shopify_location_observation_corrupt" },
    };
  }
  const organisationId = parseOrganisationId(row.organisation_id);
  const integrationAccountId = parseIntegrationAccountId(
    row.integration_account_id,
  );
  if (!organisationId.ok || !integrationAccountId.ok) {
    return {
      ok: false,
      error: { code: "shopify_location_observation_corrupt" },
    };
  }
  const classification = parseStoredClassification({
    state: row.classification_state,
    kind: row.classification_kind,
    classifiedByUserId: row.classified_by_user_id,
    mappingRevision: row.mapping_revision,
    classifiedAt: row.classified_at,
  });
  if (!classification.ok) return classification;
  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      providerLocationId: row.provider_location_id,
      providerLocationGid: row.provider_location_gid,
      sourceRevision: row.source_revision,
      eventId: row.event_id,
      name: row.name,
      active: row.active === 1,
      updatedAt: row.updated_at,
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      classification: classification.value,
      acceptedAt: row.accepted_at,
    },
  };
}

function sameObservationFacts(
  left: ShopifyLocationObservation,
  right: ShopifyLocationObservationInput,
): boolean {
  return (
    left.organisationId === right.organisationId &&
    left.integrationAccountId === right.integrationAccountId &&
    left.providerLocationId === right.providerLocationId &&
    left.providerLocationGid === right.providerLocationGid &&
    left.sourceRevision === right.sourceRevision &&
    left.name === right.name &&
    left.active === right.active &&
    left.updatedAt === right.updatedAt
  );
}

function parseClassification(
  raw: unknown,
): Result<
  ShopifyLocationObservationInput["classification"],
  ShopifyLocationObservationError
> {
  if (!isRecord(raw) || typeof raw.state !== "string") {
    return invalid("resource.resource.classification");
  }
  if (raw.state === "pending") {
    return {
      ok: true,
      value: { state: "pending", reason: "provider_location_kind_unmapped" },
    };
  }
  return invalid("resource.resource.classification");
}

function parseStoredClassification(input: {
  readonly state: string;
  readonly kind: string | null;
  readonly classifiedByUserId: string | null;
  readonly mappingRevision: number | null;
  readonly classifiedAt: number | null;
}): Result<
  ShopifyLocationObservationClassification,
  ShopifyLocationObservationError
> {
  if (
    input.state === "pending" &&
    input.kind === null &&
    input.classifiedByUserId === null &&
    input.mappingRevision === null &&
    input.classifiedAt === null
  ) {
    return {
      ok: true,
      value: { state: "pending", reason: "provider_location_kind_unmapped" },
    };
  }
  if (
    input.state === "assigned" &&
    input.kind !== null &&
    isLocationKind(input.kind) &&
    input.classifiedByUserId !== null &&
    Number.isSafeInteger(input.mappingRevision) &&
    input.mappingRevision !== null &&
    input.mappingRevision >= 1 &&
    Number.isSafeInteger(input.classifiedAt) &&
    input.classifiedAt !== null &&
    input.classifiedAt >= 0
  ) {
    const classifiedByUserId = parseUserId(
      input.classifiedByUserId,
    );
    if (!classifiedByUserId.ok) {
      return {
        ok: false,
        error: { code: "shopify_location_observation_corrupt" },
      };
    }
    return {
      ok: true,
      value: {
        state: "assigned",
        kind: input.kind,
        classifiedByUserId: classifiedByUserId.value,
        mappingRevision: input.mappingRevision,
        classifiedAt: input.classifiedAt,
      },
    };
  }
  return { ok: false, error: { code: "shopify_location_observation_corrupt" } };
}

function parseStringId<T>(
  raw: unknown,
  parser: (value: string) => Result<T, unknown>,
  field: string,
): Result<T, ShopifyLocationObservationError> {
  if (typeof raw !== "string") return invalid(field);
  const parsed = parser(raw);
  return parsed.ok ? parsed : invalid(field);
}

function requiredText(
  raw: unknown,
  field: string,
): Result<string, ShopifyLocationObservationError> {
  return typeof raw === "string" && raw.trim().length > 0
    ? { ok: true, value: raw }
    : invalid(field);
}

function requiredTimestamp(
  raw: unknown,
  field: string,
): Result<string, ShopifyLocationObservationError> {
  return typeof raw === "string" && isTimestamp(raw)
    ? { ok: true, value: raw }
    : invalid(field);
}

function isTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function isLocationKind(
  value: string,
): value is ShopifyLocationClassificationKind {
  return (SHOPIFY_LOCATION_CLASSIFICATION_KINDS as readonly string[]).includes(
    value,
  );
}

function parseProviderLocationGid(raw: unknown): Result<
  {
    readonly providerLocationId: string;
    readonly providerLocationGid: string;
  },
  ShopifyLocationObservationError
> {
  if (typeof raw !== "string") return invalid("resource.resource.id");
  const match = /^gid:\/\/shopify\/Location\/([1-9][0-9]*)$/u.exec(raw);
  const providerLocationId = match?.[1];
  return providerLocationId === undefined
    ? invalid("resource.resource.id")
    : {
        ok: true,
        value: { providerLocationId, providerLocationGid: raw },
      };
}

function isShopifyLocationGid(value: string, numericId: string): boolean {
  return (
    isShopifyLocationId(numericId) &&
    value === `gid://shopify/Location/${numericId}`
  );
}

function isShopifyLocationId(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value);
}

function invalid(
  field: string,
): Result<never, ShopifyLocationObservationError> {
  return {
    ok: false,
    error: { code: "shopify_location_observation_invalid", field },
  };
}
