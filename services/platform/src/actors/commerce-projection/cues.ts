import {
  parseCommerceCueEvent,
  type CommerceCueEvent,
} from "../../cues/engine";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../ids";
import type { Result } from "../../result";
import { materializeCommerceRelationText } from "../commerce-query-schema";
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";
import type { CommerceObservationDisposition } from "@purin-labs/commerce-control-api";
import type {
  ApplyCommerceDeliveryInput,
  CommerceCueFactForProjection,
  CommerceLowStockCueFact,
  CommerceProjectionError,
  CommerceProjectionKind,
  CommerceSystemStorageAuthority,
  CueRow,
  InspectedCommerceDelete,
  InspectedCommerceDelivery,
  InspectedCommerceObservation,
  PendingCommerceCue,
  ProjectionIdentity,
  ProjectionRow,
  UpsertProjectionIdentity,
} from "../commerce-projection";
import {
  isCueState,
  isNullableNonNegativeInteger,
  projectionBody,
} from "./records";
import {
  projectionSelectSql,
  readProjection,
  storedInventoryQuantity,
  type InventoryQuantity,
} from "./validation";

export function upsertProjection(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  parsed: {
    readonly projectionJson: string;
    readonly identity: UpsertProjectionIdentity;
  },
): void {
  const body = projectionBody(parsed.projectionJson);
  if (body === null) {
    throw new Error("commerce_projection_relation_text_source_invalid");
  }
  const displayName = relationDisplayName(body, parsed.identity.canonicalId);
  const relationText = materializeCommerceRelationText(
    displayName,
    displayName,
  );
  if (!relationText.ok) {
    throw new Error(relationText.error.code);
  }
  sql.exec(
    `INSERT INTO commerce_projection (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (organisation_id, projection_kind, canonical_id) DO UPDATE SET
       integration_account_id = excluded.integration_account_id,
       revision = excluded.revision,
       lifecycle = excluded.lifecycle,
       projection_json = excluded.projection_json,
       updated_at = excluded.updated_at,
       validated_at = excluded.validated_at,
       lab_run_id = excluded.lab_run_id`,
    input.organisationId,
    parsed.identity.kind,
    parsed.identity.canonicalId,
    input.integrationAccountId,
    parsed.identity.revision,
    parsed.identity.lifecycle,
    parsed.projectionJson,
    input.processedAt,
    input.processedAt,
    input.labRunId,
  );
  sql.exec(
    `INSERT INTO commerce_projection_relation_text (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       display_name_folded, search_text_folded
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (organisation_id, projection_kind, canonical_id) DO UPDATE SET
       integration_account_id = excluded.integration_account_id,
       display_name_folded = excluded.display_name_folded,
       search_text_folded = excluded.search_text_folded`,
    input.organisationId,
    parsed.identity.kind,
    parsed.identity.canonicalId,
    input.integrationAccountId,
    relationText.value.displayNameFolded,
    relationText.value.searchTextFolded,
  );
}

function relationDisplayName(
  projection: Record<string, unknown>,
  canonicalId: string,
): string {
  const title = projection.title;
  if (typeof title === "string" && title.length > 0) return title;
  const name = projection.name;
  if (typeof name === "string" && name.length > 0) return name;
  return canonicalId;
}

export function deleteProjection(
  sql: SqlStorage,
  organisationId: OrganisationId,
  identity: ProjectionIdentity,
): void {
  sql.exec(
    `DELETE FROM commerce_projection
     WHERE organisation_id = ? AND projection_kind = ? AND canonical_id = ?`,
    organisationId,
    identity.kind,
    identity.canonicalId,
  );
  sql.exec(
    `DELETE FROM commerce_projection_relation_text
     WHERE organisation_id = ? AND projection_kind = ? AND canonical_id = ?`,
    organisationId,
    identity.kind,
    identity.canonicalId,
  );
}

export function deleteProjectionTombstone(
  sql: SqlStorage,
  organisationId: OrganisationId,
  identity: ProjectionIdentity,
): void {
  sql.exec(
    `DELETE FROM commerce_projection_tombstone
     WHERE organisation_id = ? AND projection_kind = ? AND canonical_id = ?`,
    organisationId,
    identity.kind,
    identity.canonicalId,
  );
}

export function upsertProjectionTombstone(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  parsed: InspectedCommerceDelete,
): void {
  sql.exec(
    `INSERT INTO commerce_projection_tombstone (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       revision, provenance_json, updated_at, lab_run_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (organisation_id, projection_kind, canonical_id) DO UPDATE SET
       integration_account_id = excluded.integration_account_id,
       revision = excluded.revision,
       provenance_json = excluded.provenance_json,
       updated_at = excluded.updated_at,
       lab_run_id = excluded.lab_run_id`,
    input.organisationId,
    parsed.identity.kind,
    parsed.identity.canonicalId,
    input.integrationAccountId,
    parsed.identity.revision,
    parsed.provenanceJson,
    input.processedAt,
    input.labRunId,
  );
}

export function isAppliedObservationOutcome(
  outcome: Readonly<{ disposition: CommerceObservationDisposition }>,
): boolean {
  return outcome.disposition === "applied";
}

export function advanceCommerceProjectionWatermark(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
): void {
  sql.exec(
    `INSERT INTO commerce_projection_watermark (
       organisation_id, integration_account_id, accepted_projection_sequence, updated_at
     ) VALUES (?, ?, 1, ?)
     ON CONFLICT (organisation_id, integration_account_id) DO UPDATE SET
       accepted_projection_sequence = accepted_projection_sequence + 1,
       updated_at = excluded.updated_at`,
    input.organisationId,
    input.integrationAccountId,
    input.processedAt,
  );
}

export function insertDeliveryReceipt(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  parsed: InspectedCommerceDelivery,
  commerceSystem: CommerceSystemStorageAuthority,
): void {
  sql.exec(
    `INSERT INTO commerce_delivery_receipt (
       organisation_id, provider_delivery_id, integration_account_id, delivery_json,
       processed_at, last_seen_at, delivery_count, lab_run_id,
       commerce_system_kind, commerce_system_revision
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    input.organisationId,
    parsed.providerDeliveryId,
    input.integrationAccountId,
    parsed.deliveryJson,
    input.processedAt,
    input.processedAt,
    input.labRunId,
    commerceSystem.kind,
    commerceSystem.revision,
  );
}

export function insertObservationReceipt(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  providerDeliveryId: string,
  parsed: InspectedCommerceObservation,
  disposition: CommerceObservationDisposition,
  commerceSystem: CommerceSystemStorageAuthority,
): void {
  sql.exec(
    `INSERT INTO commerce_event_receipt (
       organisation_id, event_id, integration_account_id, projection_kind,
       canonical_id, revision, disposition, event_json, occurred_at,
       processed_at, last_seen_at, delivery_count, lab_run_id,
       provider_delivery_id, observation_index,
       commerce_system_kind, commerce_system_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    input.organisationId,
    parsed.observationId,
    input.integrationAccountId,
    parsed.identity.kind,
    parsed.identity.canonicalId,
    parsed.identity.revision,
    disposition,
    parsed.observationJson,
    parsed.identity.occurredAt,
    input.processedAt,
    input.processedAt,
    input.labRunId,
    providerDeliveryId,
    input.delivery.observations.findIndex(
      (observation) => observation.observationId === parsed.observationId,
    ),
    commerceSystem.kind,
    commerceSystem.revision,
  );
}

export function insertCueFacts(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  providerDeliveryId: string,
  identity: ProjectionIdentity,
  facts: readonly CommerceCueFactForProjection[],
): readonly PendingCommerceCue[] {
  const cues: PendingCommerceCue[] = [];
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    if (fact === undefined) {
      throw new Error("commerce_cue_fact_index_invalid");
    }
    const event = commerceCueEvent(
      input,
      providerDeliveryId,
      identity,
      fact,
      index,
    );
    const nativeId = event.nativeId;
    sql.exec(
      `INSERT OR IGNORE INTO commerce_cue_outbox (
         organisation_id, native_id, event_id, integration_account_id,
         event_type, fact_json, event_json, state, created_at,
         enqueued_at, lab_run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)`,
      input.organisationId,
      nativeId,
      providerDeliveryId,
      input.integrationAccountId,
      event.eventType,
      JSON.stringify(fact),
      JSON.stringify(event),
      input.processedAt,
      input.labRunId,
    );
    cues.push({
      organisationId: input.organisationId,
      nativeId,
      eventId: providerDeliveryId,
      integrationAccountId: input.integrationAccountId,
      event,
      state: "pending",
      createdAt: input.processedAt,
      enqueuedAt: null,
      labRunId: input.labRunId,
    });
  }
  return cues;
}

export function deriveLowStockCueFacts(
  sql: SqlStorage,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  outcomes: readonly {
    readonly parsed: InspectedCommerceObservation;
    readonly disposition: CommerceObservationDisposition;
  }[],
): readonly CommerceLowStockCueFact[] {
  const movements: AppliedDecreaseMovement[] = [];
  for (const outcome of outcomes) {
    if (
      outcome.disposition !== "applied" ||
      outcome.parsed.kind !== "upsert" ||
      outcome.parsed.identity.kind !== "inventory_movement"
    )
      continue;
    const movement = projectionBody(outcome.parsed.projectionJson);
    if (
      movement === null ||
      !isRecord(movement.change) ||
      movement.change.kind !== "decrease"
    )
      continue;
    const quantity = storedInventoryQuantity(movement.change.quantity);
    if (
      quantity === null ||
      typeof movement.inventoryItemId !== "string" ||
      typeof movement.locationId !== "string"
    )
      continue;
    movements.push({
      canonicalId: outcome.parsed.identity.canonicalId,
      inventoryItemId: movement.inventoryItemId,
      locationId: movement.locationId,
      quantity,
    });
  }
  const facts: CommerceLowStockCueFact[] = [];
  for (
    let movementIndex = 0;
    movementIndex < movements.length;
    movementIndex += 1
  ) {
    const movement = movements[movementIndex];
    if (movement === undefined) continue;
    const position = readInventoryPositionForItemLocation(
      sql,
      organisationId,
      integrationAccountId,
      movement.inventoryItemId,
      movement.locationId,
    );
    if (position === null) continue;
    const available = readPositionAvailable(position);
    if (available === null || available.unit !== movement.quantity.unit)
      continue;

    const resultingAvailable = reconstructMovementResultingAvailable(
      available,
      movements,
      movementIndex,
    );
    if (resultingAvailable === null) continue;

    const policies = readStockPoliciesForItemLocation(
      sql,
      organisationId,
      integrationAccountId,
      movement.inventoryItemId,
      movement.locationId,
    );
    for (const policy of policies) {
      const replenishment = isRecord(policy.replenishment)
        ? policy.replenishment
        : null;
      if (
        replenishment === null ||
        replenishment.kind !== "threshold" ||
        policy.lifecycle !== "active"
      )
        continue;
      const reorderPoint = storedInventoryQuantity(replenishment.reorderPoint);
      if (
        reorderPoint === null ||
        reorderPoint.unit !== resultingAvailable.unit
      )
        continue;
      const previousAvailable = addInventoryQuantities(
        resultingAvailable,
        movement.quantity,
      );
      if (
        previousAvailable === null ||
        !isGreaterInventoryQuantity(previousAvailable, reorderPoint) ||
        !isAtOrBelowInventoryQuantity(resultingAvailable, reorderPoint)
      )
        continue;
      if (
        hasLowStockCueWithoutRecovery(
          sql,
          organisationId,
          policy,
          movement.inventoryItemId,
          movement.locationId,
        )
      )
        continue;
      const item = readProjectionBody(
        sql,
        organisationId,
        "inventory_item",
        movement.inventoryItemId,
      );
      const merchantCode = item?.merchantCode;
      const itemName = item?.name;
      if (typeof merchantCode !== "string" || typeof itemName !== "string")
        continue;
      facts.push({
        kind: "inventory_low_stock",
        stockPolicyId: policy.stockPolicyId,
        stockPolicyRevision: policy.revision,
        crossingMovementId: movement.canonicalId,
        inventoryPositionId: position.canonicalId,
        inventoryItemId: movement.inventoryItemId,
        merchantCode,
        itemName,
        available: resultingAvailable,
        reorderPoint,
        locationId: movement.locationId,
      });
    }
  }
  return facts;
}

type AppliedDecreaseMovement = Readonly<{
  canonicalId: string;
  inventoryItemId: string;
  locationId: string;
  quantity: InventoryQuantity;
}>;

function reconstructMovementResultingAvailable(
  finalAvailable: InventoryQuantity,
  movements: readonly AppliedDecreaseMovement[],
  movementIndex: number,
): InventoryQuantity | null {
  const movement = movements[movementIndex];
  if (movement === undefined) return null;
  let resulting = finalAvailable;
  for (let index = movements.length - 1; index > movementIndex; index -= 1) {
    const laterMovement = movements[index];
    if (
      laterMovement === undefined ||
      laterMovement.inventoryItemId !== movement.inventoryItemId ||
      laterMovement.locationId !== movement.locationId
    )
      continue;
    const reconstructed = addInventoryQuantities(
      resulting,
      laterMovement.quantity,
    );
    if (reconstructed === null) return null;
    resulting = reconstructed;
  }
  return resulting;
}

type InventoryPositionRecord = Readonly<{
  canonicalId: string;
  body: Record<string, unknown>;
}>;

type StockPolicyRecord = Readonly<{
  stockPolicyId: string;
  revision: number;
  inventoryItemId: string;
  locationId: string;
  replenishment: unknown;
  lifecycle: string;
}>;

function readPositionAvailable(
  position: InventoryPositionRecord,
): InventoryQuantity | null {
  const balance = isRecord(position.body.balance)
    ? position.body.balance
    : null;
  if (balance === null) return null;
  return storedInventoryQuantity(balance.available);
}

function readInventoryPositionForItemLocation(
  sql: SqlStorage,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  inventoryItemId: string,
  locationId: string,
): InventoryPositionRecord | null {
  const row = sql
    .exec<ProjectionRow>(
      `${projectionSelectSql()}
     WHERE organisation_id = ? AND integration_account_id = ?
       AND projection_kind = 'inventory_position'
       AND json_extract(projection_json, '$.projection.inventoryItemId') = ?
       AND json_extract(projection_json, '$.projection.locationId') = ?
     ORDER BY revision DESC
     LIMIT 1`,
      organisationId,
      integrationAccountId,
      inventoryItemId,
      locationId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const body = projectionBody(row.projectionJson);
  return body === null ? null : { canonicalId: row.canonicalId, body };
}

function readStockPoliciesForItemLocation(
  sql: SqlStorage,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  inventoryItemId: string,
  locationId: string,
): readonly StockPolicyRecord[] {
  const rows = sql
    .exec<ProjectionRow>(
      `${projectionSelectSql()}
     WHERE organisation_id = ? AND integration_account_id = ?
       AND projection_kind = 'stock_policy'
       AND json_extract(projection_json, '$.projection.inventoryItemId') = ?
       AND json_extract(projection_json, '$.projection.locationId') = ?
     ORDER BY revision DESC`,
      organisationId,
      integrationAccountId,
      inventoryItemId,
      locationId,
    )
    .toArray();
  const policies: StockPolicyRecord[] = [];
  for (const row of rows) {
    const body = projectionBody(row.projectionJson);
    if (
      body === null ||
      typeof body.stockPolicyId !== "string" ||
      typeof body.inventoryItemId !== "string" ||
      typeof body.locationId !== "string" ||
      !isPositiveInteger(body.revision) ||
      typeof body.lifecycle !== "string"
    )
      continue;
    policies.push({
      stockPolicyId: body.stockPolicyId,
      revision: body.revision,
      inventoryItemId: body.inventoryItemId,
      locationId: body.locationId,
      replenishment: body.replenishment,
      lifecycle: body.lifecycle,
    });
  }
  return policies;
}

function hasLowStockCueWithoutRecovery(
  sql: SqlStorage,
  organisationId: OrganisationId,
  policy: StockPolicyRecord,
  inventoryItemId: string,
  locationId: string,
): boolean {
  const cue = sql
    .exec<
      Record<string, SqlStorageValue> & {
        readonly createdAt: number;
      }
    >(
      `SELECT created_at AS createdAt
       FROM commerce_cue_outbox
      WHERE organisation_id = ?
        AND event_type = 'inventory_low_stock'
        AND json_extract(fact_json, '$.stockPolicyId') = ?
        AND json_extract(fact_json, '$.stockPolicyRevision') = ?
      ORDER BY created_at DESC, native_id DESC
      LIMIT 1`,
      organisationId,
      policy.stockPolicyId,
      policy.revision,
    )
    .toArray()[0];
  if (cue === undefined || !isNonNegativeInteger(cue.createdAt)) return false;

  const recovery = sql
    .exec<
      Record<string, SqlStorageValue> & {
        readonly present: number;
      }
    >(
      `SELECT 1 AS present
       FROM commerce_event_receipt
      WHERE organisation_id = ?
        AND projection_kind = 'inventory_movement'
        AND disposition = 'applied'
        AND processed_at > ?
        AND json_extract(event_json, '$.projection.projection.inventoryItemId') = ?
        AND json_extract(event_json, '$.projection.projection.locationId') = ?
        AND json_extract(event_json, '$.projection.projection.change.kind') = 'increase'
      LIMIT 1`,
      organisationId,
      cue.createdAt,
      inventoryItemId,
      locationId,
    )
    .toArray()[0];
  return recovery === undefined;
}

function addInventoryQuantities(
  left: InventoryQuantity,
  right: InventoryQuantity,
): InventoryQuantity | null {
  if (left.unit !== right.unit) return null;
  const scale = Math.max(left.scale, right.scale);
  const multiplierLeft = 10n ** BigInt(scale - left.scale);
  const multiplierRight = 10n ** BigInt(scale - right.scale);
  const amount =
    BigInt(left.amount) * multiplierLeft +
    BigInt(right.amount) * multiplierRight;
  const numericAmount = Number(amount);
  return Number.isSafeInteger(numericAmount)
    ? { amount: numericAmount, scale, unit: left.unit }
    : null;
}

function compareInventoryQuantities(
  left: InventoryQuantity,
  right: InventoryQuantity,
): number | null {
  if (left.unit !== right.unit) return null;
  const scale = Math.max(left.scale, right.scale);
  const leftAmount = BigInt(left.amount) * 10n ** BigInt(scale - left.scale);
  const rightAmount = BigInt(right.amount) * 10n ** BigInt(scale - right.scale);
  return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
}

function isGreaterInventoryQuantity(
  left: InventoryQuantity,
  right: InventoryQuantity,
): boolean {
  return compareInventoryQuantities(left, right) === 1;
}

function isAtOrBelowInventoryQuantity(
  left: InventoryQuantity,
  right: InventoryQuantity,
): boolean {
  const comparison = compareInventoryQuantities(left, right);
  return comparison !== null && comparison <= 0;
}

function readProjectionBody(
  sql: SqlStorage,
  organisationId: OrganisationId,
  kind: CommerceProjectionKind,
  canonicalId: string,
): Record<string, unknown> | null {
  const row = readProjection(sql, organisationId, kind, canonicalId);
  return row === null ? null : projectionBody(row.projectionJson);
}

function commerceCueEvent(
  input: ApplyCommerceDeliveryInput,
  providerDeliveryId: string,
  identity: ProjectionIdentity,
  fact: CommerceCueFactForProjection,
  index: number,
): CommerceCueEvent {
  const nativeId =
    fact.kind === "inventory_low_stock"
      ? `commerce:inventory-low-stock:${fact.stockPolicyId}:${fact.stockPolicyRevision}:${fact.crossingMovementId}`
      : `commerce:${providerDeliveryId}:${fact.kind}:${index + 1}`;
  const common = {
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    source: "commerce" as const,
    nativeId,
    at: Date.parse(identity.occurredAt),
  };

  switch (fact.kind) {
    case "payment_failed":
      return {
        ...common,
        eventType: fact.kind,
        payload: {
          orderId: fact.orderId,
          paymentId: fact.paymentId,
          amountMinor: fact.amountMinor,
          currency: fact.currency,
          reason: fact.reason,
        },
      };
    case "inventory_shortage":
      return {
        ...common,
        eventType: fact.kind,
        payload: {
          orderId: fact.orderId,
          sku: fact.sku,
          requested: fact.requested,
          available: fact.available,
          locationId: fact.locationId,
        },
      };
    case "inventory_low_stock":
      return {
        ...common,
        eventType: fact.kind,
        payload: {
          stockPolicyId: fact.stockPolicyId,
          stockPolicyRevision: fact.stockPolicyRevision,
          crossingMovementId: fact.crossingMovementId,
          inventoryPositionId: fact.inventoryPositionId,
          inventoryItemId: fact.inventoryItemId,
          merchantCode: fact.merchantCode,
          itemName: fact.itemName,
          available: fact.available,
          reorderPoint: fact.reorderPoint,
          locationId: fact.locationId,
        },
      };
    case "order_unshipped":
      return {
        ...common,
        eventType: fact.kind,
        payload: {
          orderId: fact.orderId,
          fulfillmentId: fact.fulfillmentId,
          expectedBy: Date.parse(fact.expectedBy),
        },
      };
    case "tracking_stalled":
      return {
        ...common,
        eventType: fact.kind,
        payload: {
          orderId: fact.orderId,
          shipmentId: fact.shipmentId,
          trackingNumber: fact.trackingNumber,
          lastEventAt: Date.parse(fact.lastEventAt),
        },
      };
    case "delivery_exception":
      return {
        ...common,
        eventType: fact.kind,
        payload: {
          orderId: fact.orderId,
          shipmentId: fact.shipmentId,
          trackingNumber: fact.trackingNumber,
          status: fact.status,
          reason: fact.reason,
        },
      };
    case "cancellation_refund_proposed":
      return {
        ...common,
        eventType: fact.kind,
        payload: {
          orderId: fact.orderId,
          paymentId: fact.paymentId,
          amountMinor: fact.amountMinor,
          currency: fact.currency,
          reason: fact.reason,
        },
      };
  }
}

export function readCuesForEvent(
  sql: SqlStorage,
  organisationId: OrganisationId,
  eventId: string,
): readonly PendingCommerceCue[] {
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
       FROM commerce_cue_outbox
       WHERE organisation_id = ? AND event_id = ?
       ORDER BY native_id`,
      organisationId,
      eventId,
    )
    .toArray();
  const parsed = parseCueRows(organisationId, rows);
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

export function parseCueRows(
  organisationId: OrganisationId,
  rows: readonly CueRow[],
): Result<readonly PendingCommerceCue[], CommerceProjectionError> {
  const cues: PendingCommerceCue[] = [];
  for (const row of rows) {
    if (
      typeof row.nativeId !== "string" ||
      typeof row.eventId !== "string" ||
      typeof row.integrationAccountId !== "string" ||
      typeof row.eventType !== "string" ||
      typeof row.eventJson !== "string" ||
      typeof row.state !== "string" ||
      (row.labRunId !== null && typeof row.labRunId !== "string")
    ) {
      return { ok: false, error: { code: "commerce_projection_corrupt" } };
    }
    const integrationAccountId = parseIntegrationAccountId(
      row.integrationAccountId,
    );
    const event = parseCommerceCueEvent(parseJsonOrNull(row.eventJson));
    if (
      !integrationAccountId.ok ||
      integrationAccountId.value !== row.integrationAccountId ||
      !event.ok ||
      event.value.organisationId !== organisationId ||
      event.value.integrationAccountId !== integrationAccountId.value ||
      event.value.nativeId !== row.nativeId ||
      event.value.eventType !== row.eventType ||
      !isCueState(row.state) ||
      !isNonNegativeInteger(row.createdAt) ||
      !isNullableNonNegativeInteger(row.enqueuedAt)
    ) {
      return { ok: false, error: { code: "commerce_projection_corrupt" } };
    }
    cues.push({
      organisationId,
      nativeId: row.nativeId,
      eventId: row.eventId,
      integrationAccountId: integrationAccountId.value,
      event: event.value,
      state: row.state,
      createdAt: row.createdAt,
      enqueuedAt: row.enqueuedAt,
      labRunId: row.labRunId,
    });
  }
  return { ok: true, value: cues };
}
