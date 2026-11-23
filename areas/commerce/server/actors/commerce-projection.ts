import type { CommerceSystemKind } from "@purin-labs/contracts";
import type {
  CanonicalCommerceDelivery,
  CommerceCueFact,
  CommerceProjection,
  CommerceSource,
} from "@purin-labs/commerce-contracts";
import type { CommerceCueEvent } from "@purin-labs/agent/cues/engine";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { CommerceLabRunEvidence } from "../commerce-lab/lab-metadata";
import {
  assertRequiredColumns,
  runSchemaMigrations,
  type SchemaTransaction,
} from "@purin-labs/actor-runtime/actors/schema-migrations";
import {
  COMMERCE_PROJECTION_SCHEMA_V16,
  execSchemaStatements,
} from "./commerce-schema-baseline";
import {
  createCommerceQuerySchema,
  rebuildCommerceRelationshipRelationsForOwner,
} from "./commerce-query-schema";
import type { Variant } from "@purin-labs/type-utils";
import {
  isNonNegativeInteger,
  isPositiveInteger,
  parseJsonOrNull,
} from "@purin-labs/std";
import type { CommerceObservationDisposition } from "@purin-labs/commerce-control-api";
import {
  advanceCommerceProjectionWatermark,
  deleteProjection,
  deleteProjectionTombstone,
  deriveLowStockCueFacts,
  insertCueFacts,
  insertDeliveryReceipt,
  insertObservationReceipt,
  isAppliedObservationOutcome,
  parseCueRows,
  readCuesForEvent,
  upsertProjection,
  upsertProjectionTombstone,
} from "./commerce-projection/cues";
import {
  PositionStockTracker,
  type InventoryStockChange,
} from "./commerce-projection/stock-changes";
import {
  invalidEvent,
  isLabNamespace,
  isProjectionKind,
  isReadLimit,
  parseCommerceProjectionRecord,
  projectionCount,
  readCount,
  readLabState,
  sameRevisionContent,
  terminalLifecycleOrThrow,
  verifyCommerceLabRun,
} from "./commerce-projection/records";
import {
  inspectCanonicalDelivery,
  matchesCommerceSystemAuthority,
  parseCommerceCueFact,
  parseProjectionIdentity,
  projectionSelectSql,
  readDeliveryReceipt,
  readObservationResultsForDelivery,
  readProjection,
  readProjectionTombstone,
  validateCommerceProjectionTables,
} from "./commerce-projection/validation";

export type CommerceProjectionKind =
  | "product"
  | "sellable_variant"
  | "inventory_item"
  | "location"
  | "sales_channel"
  | "offer"
  | "inventory_position"
  | "inventory_movement"
  | "inventory_lot"
  | "commerce_order"
  | "payment"
  | "fulfillment"
  | "shipment"
  | "menu"
  | "modifier_group_revision"
  | "recipe_revision"
  | "preparation_station"
  | "preparation_ticket"
  | "production_batch"
  | "stock_policy";

export type CommerceLowStockCueFact = {
  readonly kind: "inventory_low_stock";
  readonly stockPolicyId: string;
  readonly stockPolicyRevision: number;
  readonly crossingMovementId: string;
  readonly inventoryPositionId: string;
  readonly inventoryItemId: string;
  readonly merchantCode: string;
  readonly itemName: string;
  readonly available: Readonly<{ amount: number; scale: number; unit: string }>;
  readonly reorderPoint: Readonly<{
    amount: number;
    scale: number;
    unit: string;
  }>;
  readonly locationId: string;
};

export type CommerceCueFactForProjection =
  CommerceCueFact | CommerceLowStockCueFact;

export type CommerceProjectionError =
  | { readonly code: "commerce_event_invalid"; readonly field: string }
  | { readonly code: "commerce_event_organisation_mismatch" }
  | { readonly code: "commerce_event_integration_account_mismatch" }
  | { readonly code: "commerce_delivery_conflict" }
  | {
      readonly code: "commerce_revision_conflict";
      readonly projectionKind: CommerceProjectionKind;
      readonly canonicalId: string;
      readonly currentIntegrationAccountId: string;
      readonly receivedIntegrationAccountId: string;
      readonly currentRevision: number;
      readonly receivedRevision: number;
    }
  | {
      readonly code: "commerce_terminal_state_regression";
      readonly currentLifecycle: "delivered" | "returned";
    }
  | { readonly code: "commerce_projection_corrupt" }
  | { readonly code: "commerce_read_limit_invalid" }
  | { readonly code: "commerce_read_query_invalid" }
  | { readonly code: "commerce_lab_state_missing" }
  | { readonly code: "commerce_lab_namespace_mismatch" }
  | { readonly code: "commerce_system_authority_mismatch" };

export type CommerceSystemStorageAuthority =
  | Readonly<{ kind: "lab"; revision: null }>
  | Readonly<{ kind: CommerceSystemKind; revision: number }>;

export type ApplyCommerceDeliveryInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly delivery: CanonicalCommerceDelivery;
  readonly cueFacts: readonly CommerceCueFact[];
  readonly labRunId: string | null;
  readonly processedAt: number;
};

export type PendingCommerceCue = {
  readonly organisationId: OrganisationId;
  readonly nativeId: string;
  readonly eventId: string;
  readonly integrationAccountId: IntegrationAccountId;
  readonly event: CommerceCueEvent;
  readonly state: "pending" | "enqueued";
  readonly createdAt: number;
  readonly enqueuedAt: number | null;
  readonly labRunId: string | null;
};

export type AppliedCommerceObservationResult = {
  readonly disposition: CommerceObservationDisposition;
  readonly observationId: string;
  readonly projectionKind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly revision: number;
};

export type AppliedCommerceDeliveryResult = {
  readonly disposition: "accepted" | "duplicate";
  readonly providerDeliveryId: string;
  readonly observations: readonly AppliedCommerceObservationResult[];
  readonly pendingCues: readonly PendingCommerceCue[];
};

export type ReadCurrentCommerceProjectionInput = {
  readonly organisationId: OrganisationId;
  readonly kind: CommerceProjectionKind;
  readonly canonicalId: string;
};

export type ReadExactCommerceProjectionReferenceInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly kind: CommerceProjectionKind;
  readonly canonicalId: string;
};

export type ReadCommerceProjectionHistoryInput = {
  readonly organisationId: OrganisationId;
  readonly kind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly limit: number;
};

export type CommerceProjectionHistoryEntry = {
  readonly eventId: string;
  readonly disposition: CommerceObservationDisposition;
  readonly projectionKind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly revision: number;
  readonly occurredAt: string;
  readonly processedAt: number;
  readonly lastSeenAt: number;
  readonly deliveryCount: number;
};

type CommerceProjectionRecordBase<
  TKind extends CommerceProjectionKind,
  TProjection extends CommerceProjection,
> = {
  readonly organisationId: OrganisationId;
  readonly kind: TKind;
  readonly canonicalId: string;
  readonly integrationAccountId: IntegrationAccountId;
  readonly revision: number;
  readonly lifecycle: string;
  readonly projection: TProjection;
  readonly updatedAt: number;
  readonly validatedAt: number;
  readonly labRunId: string | null;
};

export type CommerceProjectionRecord = {
  [TKind in CommerceProjectionKind]: CommerceProjectionRecordBase<
    TKind,
    Variant<CommerceProjection, TKind>
  >;
}[CommerceProjectionKind];

export type CommerceSystemValidationReceipt = {
  readonly validatedResourceCount: number;
  readonly validatedAt: number;
};

export const COMMERCE_PROJECTION_STALE_AFTER_MS = 15 * 60 * 1_000;

export type CommerceSystemSyncStatus =
  | Readonly<{
      kind: "syncing";
      acceptedResourceCount: 0;
    }>
  | Readonly<{
      kind: "ready";
      acceptedResourceCount: number;
      lastSyncedAt: number;
    }>
  | Readonly<{
      kind: "delayed";
      acceptedResourceCount: number;
      lastSyncedAt: number;
    }>;

export type ValidateCommerceSystemInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly validatedAt: number;
};

export type CommerceLabSeedInput = {
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
  readonly catalogVersion: string;
  readonly seededAt: number;
  readonly events: readonly ApplyCommerceDeliveryInput[];
};

export type CommerceLabResetInput = {
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
  readonly resetAt: number;
};

export type CommerceLabProjectionReceipt = {
  readonly eventId: string;
  readonly providerDeliveryId: string;
  readonly disposition: CommerceObservationDisposition;
  readonly projectionKind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly revision: number;
  readonly deliveryCount: number;
};

export type CommerceLabCueReceipt = {
  readonly nativeId: string;
  readonly eventType: CommerceCueEvent["eventType"];
  readonly state: "pending" | "enqueued";
  readonly createdAt: number;
  readonly enqueuedAt: number | null;
};

export type CommerceLabTerminalProjectionIdentity = {
  readonly kind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly lifecycle: string;
  readonly revision: number;
};

export type CommerceLabRunVerification = {
  readonly runId: string;
  readonly scenarioId: CommerceLabRunEvidence["scenarioId"];
  readonly scenarioVersion: CommerceLabRunEvidence["scenarioVersion"];
  readonly result: CommerceLabRunEvidence["result"];
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly providerEventIds: readonly string[];
  readonly publicationProposal: CommerceLabRunEvidence["publicationProposal"];
  readonly projectionReceipts: readonly CommerceLabProjectionReceipt[];
  readonly pendingCueReceipts: readonly CommerceLabCueReceipt[];
  readonly enqueuedCueReceipts: readonly CommerceLabCueReceipt[];
  readonly duplicateCount: number;
  readonly terminalProjectionIdentities: readonly CommerceLabTerminalProjectionIdentity[];
  readonly approvalReceipts: readonly { readonly approvalId: string }[];
  readonly interventionReceipts: readonly { readonly interventionId: string }[];
  readonly providerEffectReceipts: readonly {
    readonly effectId: string;
    readonly actionId: string;
    readonly authorized: true;
  }[];
  readonly failureStage: string | null;
  readonly failureCode: string | null;
  readonly failureProviderEventId: string | null;
  readonly failureProjectionId: string | null;
  readonly failureSlackEffectId: string | null;
};

export type CommerceLabVerification = {
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
  readonly catalogVersion: string;
  readonly projectionCount: number;
  readonly eventReceiptCount: number;
  readonly pendingCueCount: number;
  readonly enqueuedCueCount: number;
  readonly runs: readonly CommerceLabRunVerification[];
};

export type ProjectionIdentity = {
  readonly kind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly source: CommerceSource;
  readonly revision: number;
  readonly occurredAt: string;
};

export type UpsertProjectionIdentity = ProjectionIdentity & {
  readonly lifecycle: string;
};

type InspectedCommerceUpsert = {
  readonly kind: "upsert";
  readonly observationId: string;
  readonly observationJson: string;
  readonly projection: CommerceProjection;
  readonly projectionJson: string;
  readonly identity: UpsertProjectionIdentity;
};

export type InspectedCommerceDelete = {
  readonly kind: "delete";
  readonly observationId: string;
  readonly observationJson: string;
  readonly provenanceJson: string;
  readonly identity: ProjectionIdentity;
};

export type InspectedCommerceObservation =
  InspectedCommerceUpsert | InspectedCommerceDelete;

export type InspectedCommerceDelivery = {
  readonly providerDeliveryId: string;
  readonly deliveryJson: string;
  readonly observations: readonly InspectedCommerceObservation[];
};

export type LabActionRow = {
  readonly nonce: string;
  readonly verb: string;
  readonly state: string;
};

export type ProjectionRow = Record<string, SqlStorageValue> & {
  readonly projectionKind: string;
  readonly canonicalId: string;
  readonly integrationAccountId: string;
  readonly revision: number;
  readonly lifecycle: string;
  readonly projectionJson: string;
  readonly updatedAt: number;
  readonly validatedAt: number;
  readonly labRunId: string | null;
};

export type ProjectionTombstoneRow = Record<string, SqlStorageValue> & {
  readonly projectionKind: string;
  readonly canonicalId: string;
  readonly integrationAccountId: string;
  readonly revision: number;
  readonly provenanceJson: string;
  readonly updatedAt: number;
  readonly labRunId: string | null;
};

export type ReceiptRow = Record<string, SqlStorageValue> & {
  readonly eventId: string;
  readonly providerDeliveryId: string;
  readonly disposition: string;
  readonly projectionKind: string;
  readonly canonicalId: string;
  readonly revision: number;
  readonly deliveryCount: number;
  readonly commerceSystemKind: string;
  readonly commerceSystemRevision: number | null;
};

export type DeliveryReceiptRow = Record<string, SqlStorageValue> & {
  readonly providerDeliveryId: string;
  readonly deliveryJson: string;
  readonly deliveryCount: number;
  readonly commerceSystemKind: string;
  readonly commerceSystemRevision: number | null;
};

type ProjectionHistoryRow = Record<string, SqlStorageValue> & {
  readonly eventId: string;
  readonly disposition: string;
  readonly projectionKind: string;
  readonly canonicalId: string;
  readonly revision: number;
  readonly occurredAt: string;
  readonly processedAt: number;
  readonly lastSeenAt: number;
  readonly deliveryCount: number;
};

export type CueRow = Record<string, SqlStorageValue> & {
  readonly nativeId: string;
  readonly eventId: string;
  readonly integrationAccountId: string;
  readonly eventType: string;
  readonly eventJson: string;
  readonly state: string;
  readonly createdAt: number;
  readonly enqueuedAt: number | null;
  readonly labRunId: string | null;
};

export type LabStateRow = Record<string, SqlStorageValue> & {
  readonly labNamespace: string;
  readonly catalogVersion: string;
};

export type FulfillmentKind =
  "shipping" | "pickup" | "local_delivery" | "immediate_handoff" | "on_premise";

/**
 * Version 17 records each completed sync once for its integration account,
 * not on every projection row, and records each cue whose queue message is
 * done, so that recovery stops sending it. Durable Object SQLite bills every
 * written row: the earlier per-row stamp rewrote the whole catalog each
 * minute.
 */
const COMMERCE_PROJECTION_SCHEMA_V17: readonly string[] = [
  `CREATE TABLE commerce_projection_sync (
      organisation_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      validated_at INTEGER NOT NULL CHECK (validated_at >= 0),
      PRIMARY KEY (organisation_id, integration_account_id)
    )`,
  `CREATE TABLE commerce_cue_settlement (
      organisation_id TEXT NOT NULL,
      native_id TEXT NOT NULL,
      settled_at INTEGER NOT NULL CHECK (settled_at >= 0),
      PRIMARY KEY (organisation_id, native_id)
    )`,
];

const COMMERCE_SCHEMA_PLAN = {
  key: "commerce_projection",
  currentVersion: 17,
  preservedTables: [] as const,
  baseline: {
    version: 16,
    apply: (sql: SqlStorage) =>
      execSchemaStatements(sql, COMMERCE_PROJECTION_SCHEMA_V16),
    validate: validateCommerceProjectionTextFolds,
  },
  steps: [
    {
      version: 17,
      apply: (sql: SqlStorage) =>
        execSchemaStatements(sql, COMMERCE_PROJECTION_SCHEMA_V17),
      validate: (sql: SqlStorage) => {
        validateCommerceProjectionTextFolds(sql);
        assertRequiredColumns(sql, "commerce_projection_sync", [
          "organisation_id",
          "integration_account_id",
          "validated_at",
        ]);
        assertRequiredColumns(sql, "commerce_cue_settlement", [
          "organisation_id",
          "native_id",
          "settled_at",
        ]);
      },
    },
  ],
} as const;

const TERMINAL_LIFECYCLES = new Set(["delivered", "returned"]);

export function createCommerceProjectionSchema(sql: SqlStorage): void;

export function createCommerceProjectionSchema(
  sql: SqlStorage,
  transaction: SchemaTransaction,
): void;

export function createCommerceProjectionSchema(
  sql: SqlStorage,
  transaction?: SchemaTransaction,
): void {
  const execute = transaction ?? transactionFromSql(sql);
  runSchemaMigrations(sql, COMMERCE_SCHEMA_PLAN, execute);
  createCommerceQuerySchema(sql, execute);
}

function transactionFromSql(sql: SqlStorage): SchemaTransaction {
  if (
    !("transactionSync" in sql) ||
    typeof sql.transactionSync !== "function"
  ) {
    throw new Error("commerce_projection_schema_transaction_missing");
  }
  return sql.transactionSync.bind(sql);
}

export function parseCanonicalCommerceDelivery(
  raw: unknown,
): Result<CanonicalCommerceDelivery, CommerceProjectionError> {
  const parsed = inspectCanonicalDelivery(raw);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, value: raw as CanonicalCommerceDelivery };
}

export function parseCommerceProjection(
  raw: unknown,
): Result<CommerceProjection, CommerceProjectionError> {
  const identity = parseProjectionIdentity(raw);
  if (!identity.ok) {
    return identity;
  }
  return { ok: true, value: raw as CommerceProjection };
}

export function parseCommerceCueFacts(
  raw: unknown,
): Result<readonly CommerceCueFact[], CommerceProjectionError> {
  if (!Array.isArray(raw)) {
    return invalidEvent("cueFacts");
  }
  const facts: CommerceCueFact[] = [];
  for (const value of raw) {
    const fact = parseCommerceCueFact(value);
    if (!fact.ok) {
      return fact;
    }
    facts.push(fact.value);
  }
  return { ok: true, value: facts };
}

/**
 * Applies one canonical delivery. When `stockChanges` is given, each applied
 * change of an inventory position's available stock is added to it, with the
 * stock before and after the change (Plan 24: the bake stock levels).
 */
export function applyCommerceDelivery(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  commerceSystem: CommerceSystemStorageAuthority,
  stockChanges?: InventoryStockChange[],
): Result<AppliedCommerceDeliveryResult, CommerceProjectionError> {
  if (!isNonNegativeInteger(input.processedAt)) {
    return invalidEvent("processedAt");
  }

  const parsed = inspectCanonicalDelivery(input.delivery);
  if (!parsed.ok) {
    return parsed;
  }
  if (
    !matchesCommerceSystemAuthority(
      parsed.value,
      commerceSystem,
      input.integrationAccountId,
    )
  ) {
    return { ok: false, error: { code: "commerce_system_authority_mismatch" } };
  }
  for (const observation of parsed.value.observations) {
    if (observation.identity.organisationId !== input.organisationId) {
      return {
        ok: false,
        error: { code: "commerce_event_organisation_mismatch" },
      };
    }
    if (
      observation.identity.integrationAccountId !== input.integrationAccountId
    ) {
      return {
        ok: false,
        error: { code: "commerce_event_integration_account_mismatch" },
      };
    }
  }
  const firstObservation = parsed.value.observations[0];
  if (firstObservation === undefined) {
    throw new Error("validated commerce delivery lost its observations");
  }
  if (firstObservation.kind === "delete" && input.cueFacts.length > 0) {
    return invalidEvent("cueFacts.delete");
  }

  const existingDelivery = readDeliveryReceipt(
    sql,
    input.organisationId,
    parsed.value.providerDeliveryId,
  );
  if (existingDelivery !== null) {
    if (existingDelivery.deliveryJson !== parsed.value.deliveryJson) {
      return { ok: false, error: { code: "commerce_delivery_conflict" } };
    }
    sql.exec(
      `UPDATE commerce_delivery_receipt
       SET delivery_count = delivery_count + 1,
           last_seen_at = MAX(last_seen_at, ?)
       WHERE organisation_id = ? AND provider_delivery_id = ?`,
      input.processedAt,
      input.organisationId,
      parsed.value.providerDeliveryId,
    );
    return {
      ok: true,
      value: {
        disposition: "duplicate",
        providerDeliveryId: parsed.value.providerDeliveryId,
        observations: readObservationResultsForDelivery(
          sql,
          input.organisationId,
          parsed.value.providerDeliveryId,
        ),
        pendingCues: readCuesForEvent(
          sql,
          input.organisationId,
          parsed.value.providerDeliveryId,
        ),
      },
    };
  }

  const outcomes: Array<{
    readonly parsed: InspectedCommerceObservation;
    readonly disposition: CommerceObservationDisposition;
  }> = [];
  const positions = new PositionStockTracker();
  for (const observation of parsed.value.observations) {
    const current = readProjection(
      sql,
      input.organisationId,
      observation.identity.kind,
      observation.identity.canonicalId,
    );
    const tombstone = readProjectionTombstone(
      sql,
      input.organisationId,
      observation.identity.kind,
      observation.identity.canonicalId,
    );
    const currentRevision = Math.max(
      current?.revision ?? 0,
      tombstone?.revision ?? 0,
    );
    if (observation.identity.revision < currentRevision) {
      outcomes.push({ parsed: observation, disposition: "out_of_order" });
      continue;
    }
    if (observation.identity.revision === currentRevision) {
      const replayMatches =
        observation.kind === "upsert"
          ? current !== null &&
            tombstone === null &&
            sameRevisionContent(
              current.projectionJson,
              observation.projectionJson,
              "upsert",
            )
          : current === null &&
            tombstone !== null &&
            sameRevisionContent(
              tombstone.provenanceJson,
              observation.provenanceJson,
              "delete",
            );
      if (!replayMatches) {
        return {
          ok: false,
          error: {
            code: "commerce_revision_conflict",
            projectionKind: observation.identity.kind,
            canonicalId: observation.identity.canonicalId,
            currentIntegrationAccountId:
              current?.integrationAccountId ??
              tombstone?.integrationAccountId ??
              "",
            receivedIntegrationAccountId:
              observation.identity.integrationAccountId,
            currentRevision,
            receivedRevision: observation.identity.revision,
          },
        };
      }
      outcomes.push({ parsed: observation, disposition: "duplicate" });
      continue;
    }
    if (
      observation.kind === "upsert" &&
      current !== null &&
      TERMINAL_LIFECYCLES.has(current.lifecycle) &&
      current.lifecycle !== observation.identity.lifecycle
    ) {
      return {
        ok: false,
        error: {
          code: "commerce_terminal_state_regression",
          currentLifecycle: terminalLifecycleOrThrow(current.lifecycle),
        },
      };
    }
    outcomes.push({ parsed: observation, disposition: "applied" });
    const change = positions.change(current, observation);
    if (change !== null) stockChanges?.push(change);
  }

  insertDeliveryReceipt(sql, input, parsed.value, commerceSystem);
  for (const outcome of outcomes) {
    if (outcome.disposition === "applied") {
      switch (outcome.parsed.kind) {
        case "upsert":
          upsertProjection(sql, input, outcome.parsed);
          deleteProjectionTombstone(
            sql,
            input.organisationId,
            outcome.parsed.identity,
          );
          break;
        case "delete":
          deleteProjection(sql, input.organisationId, outcome.parsed.identity);
          upsertProjectionTombstone(sql, input, outcome.parsed);
          break;
      }
    }
    insertObservationReceipt(
      sql,
      input,
      parsed.value.providerDeliveryId,
      outcome.parsed,
      outcome.disposition,
      commerceSystem,
    );
  }
  if (outcomes.some(isAppliedObservationOutcome)) {
    rebuildCommerceRelationshipRelationsForOwner(
      sql,
      input.integrationAccountId,
    );
    advanceCommerceProjectionWatermark(sql, input);
  }
  const lowStockFacts = deriveLowStockCueFacts(
    sql,
    input.organisationId,
    input.integrationAccountId,
    outcomes,
  );
  const cues =
    firstObservation.kind === "upsert"
      ? insertCueFacts(
          sql,
          input,
          parsed.value.providerDeliveryId,
          firstObservation.identity,
          [...input.cueFacts, ...lowStockFacts],
        )
      : [];

  return {
    ok: true,
    value: {
      disposition: "accepted",
      providerDeliveryId: parsed.value.providerDeliveryId,
      observations: outcomes.map(({ parsed: observation, disposition }) => ({
        disposition,
        observationId: observation.observationId,
        projectionKind: observation.identity.kind,
        canonicalId: observation.identity.canonicalId,
        revision: observation.identity.revision,
      })),
      pendingCues: cues,
    },
  };
}

export function readAcceptedCommerceProjectionSequence(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  }>,
): Result<number, CommerceProjectionError> {
  const row = sql
    .exec<Readonly<{ acceptedProjectionSequence: SqlStorageValue }>>(
      `SELECT accepted_projection_sequence AS acceptedProjectionSequence
       FROM commerce_projection_watermark
      WHERE organisation_id = ? AND integration_account_id = ?
      LIMIT 1`,
      input.organisationId,
      input.integrationAccountId,
    )
    .toArray()[0];
  if (row === undefined) return { ok: true, value: 0 };
  if (!isNonNegativeInteger(row.acceptedProjectionSequence)) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  return { ok: true, value: row.acceptedProjectionSequence };
}

export function readRecoverableCommerceCues(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly limit: number;
    readonly retryBefore: number;
  },
): Result<readonly PendingCommerceCue[], CommerceProjectionError> {
  if (
    !isReadLimit(input.limit, 100) ||
    !isNonNegativeInteger(input.retryBefore)
  ) {
    return { ok: false, error: { code: "commerce_read_limit_invalid" } };
  }
  const rows = sql
    .exec<CueRow>(
      `SELECT native_id AS nativeId,
              event_id AS eventId,
              integration_account_id AS integrationAccountId,
              event_type AS eventType,
              event_json AS eventJson,
              state,
              created_at AS createdAt,
              enqueued_at AS enqueuedAt,
              lab_run_id AS labRunId
       FROM commerce_cue_outbox o
       WHERE organisation_id = ?
         AND (state = 'pending' OR (state = 'enqueued' AND enqueued_at <= ?))
         AND NOT EXISTS (
           SELECT 1 FROM commerce_cue_settlement s
           WHERE s.organisation_id = o.organisation_id
             AND s.native_id = o.native_id
         )
       ORDER BY created_at, native_id
       LIMIT ?`,
      input.organisationId,
      input.retryBefore,
      input.limit,
    )
    .toArray();

  return parseCueRows(input.organisationId, rows);
}

export function readCurrentCommerceProjection(
  sql: SqlStorage,
  input: ReadCurrentCommerceProjectionInput,
): Result<CommerceProjection | null, CommerceProjectionError> {
  if (input.canonicalId.length === 0 || input.canonicalId.length > 256) {
    return { ok: false, error: { code: "commerce_read_query_invalid" } };
  }
  const row = readProjection(
    sql,
    input.organisationId,
    input.kind,
    input.canonicalId,
  );
  if (row === null) {
    return { ok: true, value: null };
  }
  const raw = parseJsonOrNull(row.projectionJson);
  const identity = parseProjectionIdentity(raw);
  if (!identity.ok) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  if (
    identity.value.organisationId !== input.organisationId ||
    identity.value.kind !== input.kind ||
    identity.value.canonicalId !== input.canonicalId
  ) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  return { ok: true, value: raw as CommerceProjection };
}

export function readExactCommerceProjectionReference(
  sql: SqlStorage,
  input: ReadExactCommerceProjectionReferenceInput,
): Result<CommerceProjectionRecord | null, CommerceProjectionError> {
  if (
    !isProjectionKind(input.kind) ||
    input.canonicalId.length === 0 ||
    input.canonicalId.length > 256
  ) {
    return { ok: false, error: { code: "commerce_read_query_invalid" } };
  }
  const row = sql
    .exec<ProjectionRow>(
      `${projectionSelectSql()}
     WHERE organisation_id = ?
       AND integration_account_id = ?
       AND projection_kind = ?
       AND canonical_id = ?
     LIMIT 1`,
      input.organisationId,
      input.integrationAccountId,
      input.kind,
      input.canonicalId,
    )
    .toArray()[0];
  if (row === undefined) return { ok: true, value: null };
  const record = parseCommerceProjectionRecord(row, input.organisationId);
  if (
    !record.ok ||
    record.value.integrationAccountId !== input.integrationAccountId ||
    record.value.kind !== input.kind ||
    record.value.canonicalId !== input.canonicalId
  ) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  return record;
}

export function readCommerceProjectionHistory(
  sql: SqlStorage,
  input: ReadCommerceProjectionHistoryInput,
): Result<readonly CommerceProjectionHistoryEntry[], CommerceProjectionError> {
  if (!isProjectionKind(input.kind) || !isReadLimit(input.limit, 50)) {
    return { ok: false, error: { code: "commerce_read_limit_invalid" } };
  }
  if (input.canonicalId.length === 0 || input.canonicalId.length > 256) {
    return { ok: false, error: { code: "commerce_read_query_invalid" } };
  }
  const rows = sql
    .exec<ProjectionHistoryRow>(
      `SELECT event_id AS eventId,
            disposition,
            projection_kind AS projectionKind,
            canonical_id AS canonicalId,
            revision,
            occurred_at AS occurredAt,
            processed_at AS processedAt,
            last_seen_at AS lastSeenAt,
            delivery_count AS deliveryCount
       FROM commerce_event_receipt
      WHERE organisation_id = ? AND projection_kind = ? AND canonical_id = ?
      ORDER BY revision DESC, processed_at DESC, event_id DESC
      LIMIT ?`,
      input.organisationId,
      input.kind,
      input.canonicalId,
      input.limit,
    )
    .toArray();
  const entries: CommerceProjectionHistoryEntry[] = [];
  for (const row of rows) {
    if (!isProjectionHistoryRow(row, input)) {
      return { ok: false, error: { code: "commerce_projection_corrupt" } };
    }
    entries.push({
      eventId: row.eventId,
      disposition: row.disposition,
      projectionKind: row.projectionKind,
      canonicalId: row.canonicalId,
      revision: row.revision,
      occurredAt: row.occurredAt,
      processedAt: row.processedAt,
      lastSeenAt: row.lastSeenAt,
      deliveryCount: row.deliveryCount,
    });
  }
  return { ok: true, value: entries };
}

function isProjectionHistoryRow(
  row: ProjectionHistoryRow,
  input: ReadCommerceProjectionHistoryInput,
): row is ProjectionHistoryRow & {
  readonly disposition: CommerceObservationDisposition;
  readonly projectionKind: CommerceProjectionKind;
} {
  return (
    row.eventId.length > 0 &&
    (row.disposition === "applied" ||
      row.disposition === "duplicate" ||
      row.disposition === "out_of_order") &&
    row.projectionKind === input.kind &&
    row.canonicalId === input.canonicalId &&
    isPositiveInteger(row.revision) &&
    typeof row.occurredAt === "string" &&
    !Number.isNaN(Date.parse(row.occurredAt)) &&
    isNonNegativeInteger(row.processedAt) &&
    row.lastSeenAt >= row.processedAt &&
    isNonNegativeInteger(row.deliveryCount) &&
    row.deliveryCount >= 1
  );
}

export function readCommerceSystemSyncStatus(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    now: number;
  }>,
): Result<CommerceSystemSyncStatus, CommerceProjectionError> {
  if (!isNonNegativeInteger(input.now)) {
    return invalidEvent("now");
  }
  const row = sql
    .exec<{
      readonly acceptedResourceCount: SqlStorageValue;
      readonly lastSyncedAt: SqlStorageValue;
    }>(
      `SELECT COUNT(*) AS acceptedResourceCount,
            MAX(MAX(validated_at), COALESCE((
              SELECT validated_at FROM commerce_projection_sync
              WHERE organisation_id = ? AND integration_account_id = ?
            ), 0)) AS lastSyncedAt
     FROM commerce_projection
     WHERE organisation_id = ? AND integration_account_id = ?`,
      input.organisationId,
      input.integrationAccountId,
      input.organisationId,
      input.integrationAccountId,
    )
    .toArray()[0];
  const acceptedResourceCount = projectionCount(row?.acceptedResourceCount);
  if (acceptedResourceCount === null) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  if (acceptedResourceCount === 0) {
    return { ok: true, value: { kind: "syncing", acceptedResourceCount: 0 } };
  }
  if (!isNonNegativeInteger(row?.lastSyncedAt)) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  const kind =
    input.now - row.lastSyncedAt > COMMERCE_PROJECTION_STALE_AFTER_MS
      ? "delayed"
      : "ready";
  return {
    ok: true,
    value: {
      kind,
      acceptedResourceCount,
      lastSyncedAt: row.lastSyncedAt,
    },
  };
}

export function validateCommerceSystemProjections(
  sql: SqlStorage,
  input: ValidateCommerceSystemInput,
): Result<CommerceSystemValidationReceipt, CommerceProjectionError> {
  if (!isNonNegativeInteger(input.validatedAt)) {
    return invalidEvent("validatedAt");
  }
  const row = sql
    .exec<
      Record<string, SqlStorageValue> & { readonly count: SqlStorageValue }
    >(
      `SELECT COUNT(*) AS count
     FROM commerce_projection
     WHERE organisation_id = ? AND integration_account_id = ?`,
      input.organisationId,
      input.integrationAccountId,
    )
    .toArray()[0];
  const validatedResourceCount = projectionCount(row?.count);
  if (validatedResourceCount === null) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  // One row for the account: a record's validation time is the later of its
  // own write and this sync (`projectionSelectSql`).
  sql.exec(
    `INSERT INTO commerce_projection_sync (
       organisation_id, integration_account_id, validated_at
     ) VALUES (?, ?, ?)
     ON CONFLICT (organisation_id, integration_account_id) DO UPDATE SET
       validated_at = MAX(validated_at, excluded.validated_at)`,
    input.organisationId,
    input.integrationAccountId,
    input.validatedAt,
  );
  return {
    ok: true,
    value: { validatedResourceCount, validatedAt: input.validatedAt },
  };
}

/**
 * Records that the queue is done with these cues: delivered, ignored or
 * refused for good. Recovery then stops sending them.
 */
export function settleCommerceCues(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly nativeIds: readonly string[];
    readonly settledAt: number;
  },
): Result<null, CommerceProjectionError> {
  if (!isNonNegativeInteger(input.settledAt)) {
    return invalidEvent("settledAt");
  }
  for (const nativeId of input.nativeIds) {
    if (nativeId.length === 0) {
      return invalidEvent("nativeIds");
    }
    sql.exec(
      `INSERT OR IGNORE INTO commerce_cue_settlement (
         organisation_id, native_id, settled_at
       ) VALUES (?, ?, ?)`,
      input.organisationId,
      nativeId,
      input.settledAt,
    );
  }
  return { ok: true, value: null };
}

export function markCommerceCuesEnqueued(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly nativeIds: readonly string[];
    readonly enqueuedAt: number;
  },
): Result<null, CommerceProjectionError> {
  if (!isNonNegativeInteger(input.enqueuedAt)) {
    return invalidEvent("enqueuedAt");
  }
  for (const nativeId of input.nativeIds) {
    if (nativeId.length === 0) {
      return invalidEvent("nativeIds");
    }
    sql.exec(
      `UPDATE commerce_cue_outbox
       SET state = 'enqueued', enqueued_at = ?
       WHERE organisation_id = ? AND native_id = ?`,
      input.enqueuedAt,
      input.organisationId,
      nativeId,
    );
  }
  return { ok: true, value: null };
}

export function seedCommerceLab(
  sql: SqlStorage,
  input: CommerceLabSeedInput,
): Result<readonly AppliedCommerceDeliveryResult[], CommerceProjectionError> {
  if (
    !isLabNamespace(input.labNamespace) ||
    !isNonNegativeInteger(input.seededAt)
  ) {
    return { ok: false, error: { code: "commerce_lab_namespace_mismatch" } };
  }
  for (const event of input.events) {
    if (event.organisationId !== input.organisationId) {
      return {
        ok: false,
        error: { code: "commerce_event_organisation_mismatch" },
      };
    }
  }

  sql.exec(
    `INSERT INTO commerce_lab_state (
       organisation_id, lab_namespace, catalog_version, seeded_at, reset_at
     ) VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (organisation_id) DO UPDATE SET
       lab_namespace = excluded.lab_namespace,
       catalog_version = excluded.catalog_version,
       seeded_at = excluded.seeded_at,
       reset_at = NULL`,
    input.organisationId,
    input.labNamespace,
    input.catalogVersion,
    input.seededAt,
  );

  const results: AppliedCommerceDeliveryResult[] = [];
  for (const event of input.events) {
    const applied = applyCommerceDelivery(sql, event, {
      kind: "lab",
      revision: null,
    });
    if (!applied.ok) {
      return applied;
    }
    results.push(applied.value);
  }
  return { ok: true, value: results };
}

export function resetCommerceLab(
  sql: SqlStorage,
  input: CommerceLabResetInput,
): Result<null, CommerceProjectionError> {
  const state = readLabState(sql, input.organisationId);
  if (state === null) {
    return { ok: false, error: { code: "commerce_lab_state_missing" } };
  }
  if (state.labNamespace !== input.labNamespace) {
    return { ok: false, error: { code: "commerce_lab_namespace_mismatch" } };
  }

  sql.exec(
    `DELETE FROM cue_delivery
     WHERE organisation_id = ? AND source = 'commerce'
       AND native_id LIKE 'commerce:commerce_lab_run_%'`,
    input.organisationId,
  );
  sql.exec(
    `DELETE FROM commerce_cue_outbox
     WHERE organisation_id = ? AND lab_run_id IS NOT NULL`,
    input.organisationId,
  );
  sql.exec(
    `DELETE FROM commerce_cue_settlement
     WHERE organisation_id = ? AND native_id NOT IN (
       SELECT native_id FROM commerce_cue_outbox WHERE organisation_id = ?
     )`,
    input.organisationId,
    input.organisationId,
  );
  sql.exec(
    `DELETE FROM commerce_delivery_receipt
     WHERE organisation_id = ? AND lab_run_id IS NOT NULL`,
    input.organisationId,
  );
  sql.exec(
    `DELETE FROM commerce_event_receipt
     WHERE organisation_id = ? AND lab_run_id IS NOT NULL`,
    input.organisationId,
  );
  sql.exec(
    `DELETE FROM commerce_projection
     WHERE organisation_id = ? AND lab_run_id IS NOT NULL`,
    input.organisationId,
  );
  sql.exec(
    `DELETE FROM commerce_projection_relation_text
     WHERE organisation_id = ?
       AND NOT EXISTS (
         SELECT 1
           FROM commerce_projection AS projection
          WHERE projection.organisation_id = commerce_projection_relation_text.organisation_id
            AND projection.projection_kind = commerce_projection_relation_text.projection_kind
            AND projection.canonical_id = commerce_projection_relation_text.canonical_id
       )`,
    input.organisationId,
  );
  sql.exec(
    `DELETE FROM commerce_projection_tombstone
     WHERE organisation_id = ? AND lab_run_id IS NOT NULL`,
    input.organisationId,
  );
  sql.exec(
    `UPDATE commerce_lab_state
     SET reset_at = ?
     WHERE organisation_id = ? AND lab_namespace = ?`,
    input.resetAt,
    input.organisationId,
    input.labNamespace,
  );
  return { ok: true, value: null };
}

export function verifyCommerceLab(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly labNamespace: string;
    readonly runs: readonly CommerceLabRunEvidence[];
  },
): Result<CommerceLabVerification, CommerceProjectionError> {
  const state = readLabState(sql, input.organisationId);
  if (state === null) {
    return { ok: false, error: { code: "commerce_lab_state_missing" } };
  }
  if (state.labNamespace !== input.labNamespace) {
    return { ok: false, error: { code: "commerce_lab_namespace_mismatch" } };
  }

  const runs: CommerceLabRunVerification[] = [];
  for (const run of input.runs) {
    if (
      run.organisationId !== input.organisationId ||
      run.labNamespace !== input.labNamespace
    ) {
      return { ok: false, error: { code: "commerce_lab_namespace_mismatch" } };
    }
    runs.push(verifyCommerceLabRun(sql, input.organisationId, run));
  }

  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      labNamespace: input.labNamespace,
      catalogVersion: state.catalogVersion,
      projectionCount: readCount(
        sql,
        "SELECT COUNT(*) AS count FROM commerce_projection WHERE organisation_id = ?",
        input.organisationId,
      ),
      eventReceiptCount: readCount(
        sql,
        "SELECT COUNT(*) AS count FROM commerce_event_receipt WHERE organisation_id = ?",
        input.organisationId,
      ),
      pendingCueCount: readCount(
        sql,
        `SELECT COUNT(*) AS count
         FROM commerce_cue_outbox
         WHERE organisation_id = ? AND state = 'pending'`,
        input.organisationId,
      ),
      enqueuedCueCount: readCount(
        sql,
        `SELECT COUNT(*) AS count
         FROM commerce_cue_outbox
         WHERE organisation_id = ? AND state = 'enqueued'`,
        input.organisationId,
      ),
      runs,
    },
  };
}

function validateCommerceProjectionTextFolds(sql: SqlStorage): void {
  validateCommerceProjectionTables(sql);
  assertRequiredColumns(sql, "commerce_projection", [
    "organisation_id",
    "projection_kind",
    "canonical_id",
  ]);
  const missing = sql
    .exec<Readonly<{ readonly count: number }>>(
      `SELECT COUNT(*) AS count
       FROM commerce_projection AS projection
       LEFT JOIN commerce_projection_relation_text AS relation_text
         ON relation_text.organisation_id = projection.organisation_id
        AND relation_text.projection_kind = projection.projection_kind
        AND relation_text.canonical_id = projection.canonical_id
      WHERE relation_text.organisation_id IS NULL`,
    )
    .toArray()[0]?.count;
  if (missing !== 0)
    throw new Error("commerce_projection_relation_text_missing");
  const orphaned = sql
    .exec<Readonly<{ readonly count: number }>>(
      `SELECT COUNT(*) AS count
       FROM commerce_projection_relation_text AS relation_text
       LEFT JOIN commerce_projection AS projection
        ON projection.organisation_id = relation_text.organisation_id
        AND projection.projection_kind = relation_text.projection_kind
        AND projection.canonical_id = relation_text.canonical_id
      WHERE projection.organisation_id IS NULL
         OR projection.integration_account_id <> relation_text.integration_account_id`,
    )
    .toArray()[0]?.count;
  if (orphaned !== 0)
    throw new Error("commerce_projection_relation_text_orphaned");
}

export function isFulfillmentKind(value: unknown): value is FulfillmentKind {
  return (
    value === "shipping" ||
    value === "pickup" ||
    value === "local_delivery" ||
    value === "immediate_handoff" ||
    value === "on_premise"
  );
}
