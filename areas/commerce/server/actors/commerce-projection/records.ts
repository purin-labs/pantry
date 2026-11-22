import type {
  CommerceProjection,
  CommerceResourceType,
  CommerceSource,
} from "@purin-labs/commerce-contracts";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { CommerceLabRunEvidence } from "../../commerce-lab/lab-metadata";
import type { CountRow } from "@purin-labs/actor-runtime/actors/sql-rows";
import {
  canonicalJson,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";
import type { CommerceObservationDisposition } from "@purin-labs/commerce-control-api";
import {
  type CommerceLabCueReceipt,
  type CommerceLabProjectionReceipt,
  type CommerceLabRunVerification,
  type CommerceLabTerminalProjectionIdentity,
  type CommerceProjectionError,
  type CommerceProjectionKind,
  type CommerceProjectionRecord,
  type CueRow,
  type LabActionRow,
  type LabStateRow,
  type PendingCommerceCue,
  type ProjectionRow,
  type ReceiptRow,
  parseCommerceProjection,
} from "../commerce-projection";
import { parseCueRows } from "./cues";
import { PROJECTION_KINDS } from "./projection-kinds";
import { projectionSelectSql, readProjectionLifecycle } from "./validation";

export function parseCommerceProjectionRecord(
  row: ProjectionRow,
  organisationId: OrganisationId,
): Result<CommerceProjectionRecord, CommerceProjectionError> {
  if (
    !isProjectionKind(row.projectionKind) ||
    typeof row.canonicalId !== "string" ||
    typeof row.integrationAccountId !== "string" ||
    !isPositiveInteger(row.revision) ||
    typeof row.lifecycle !== "string" ||
    !isNonNegativeInteger(row.updatedAt) ||
    !isNonNegativeInteger(row.validatedAt) ||
    (row.labRunId !== null && typeof row.labRunId !== "string")
  ) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  const parsed = parseJsonOrNull(row.projectionJson);
  const projection = parseCommerceProjection(parsed);
  if (!projection.ok || projection.value.kind !== row.projectionKind) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  const provenance = projectionProvenance(projection.value);
  const parsedOrganisationId = parseOrganisationId(provenance.organisationId);
  const parsedIntegrationAccountId = parseIntegrationAccountId(
    provenance.integrationAccountId,
  );
  if (
    !parsedOrganisationId.ok ||
    !parsedIntegrationAccountId.ok ||
    parsedOrganisationId.value !== organisationId ||
    row.canonicalId !== provenance.resourceId ||
    row.integrationAccountId !== provenance.integrationAccountId ||
    row.revision !== provenance.revision ||
    !isCommerceSource(provenance.source) ||
    !isCommerceResourceType(provenance.resourceType) ||
    provenance.resourceType !== resourceTypeForProjection(row.projectionKind) ||
    row.lifecycle !==
      readProjectionLifecycle(
        row.projectionKind,
        isRecord(parsed) && isRecord(parsed.projection)
          ? parsed.projection
          : {},
      )
  ) {
    return { ok: false, error: { code: "commerce_projection_corrupt" } };
  }
  const base = {
    organisationId: parsedOrganisationId.value,
    canonicalId: row.canonicalId,
    integrationAccountId: parsedIntegrationAccountId.value,
    revision: row.revision,
    lifecycle: row.lifecycle,
    updatedAt: row.updatedAt,
    validatedAt: row.validatedAt,
    labRunId: row.labRunId,
  };
  switch (projection.value.kind) {
    case "product":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "sellable_variant":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "inventory_item":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "location":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "sales_channel":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "offer":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "inventory_position":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "inventory_movement":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "inventory_lot":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "commerce_order":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "payment":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "fulfillment":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "shipment":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "menu":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "modifier_group_revision":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "recipe_revision":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "preparation_station":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "preparation_ticket":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "production_batch":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
    case "stock_policy":
      return {
        ok: true,
        value: {
          ...base,
          kind: projection.value.kind,
          projection: projection.value,
        },
      };
  }
}

function projectionProvenance(projection: CommerceProjection) {
  switch (projection.kind) {
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "location":
    case "sales_channel":
    case "offer":
      return projection.projection.provenance;
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
      return projection.projection.provenance;
    case "commerce_order":
      return projection.projection.provenance;
    case "payment":
      return projection.projection.provenance;
    case "fulfillment":
      return projection.projection.provenance;
    case "shipment":
      return projection.projection.provenance;
    case "menu":
      return projection.projection.provenance;
    case "modifier_group_revision":
      return projection.projection.provenance;
    case "recipe_revision":
      return projection.projection.provenance;
    case "preparation_station":
      return projection.projection.provenance;
    case "preparation_ticket":
      return projection.projection.provenance;
    case "production_batch":
      return projection.projection.provenance;
    case "stock_policy":
      return projection.projection.provenance;
  }
  throw new Error("commerce_projection_provenance_unreachable");
}

export function resourceTypeForProjection(
  kind: CommerceProjectionKind,
): CommerceResourceType {
  switch (kind) {
    case "product":
      return "product";
    case "sellable_variant":
      return "sellable_variant";
    case "inventory_item":
      return "inventory_item";
    case "location":
      return "location";
    case "sales_channel":
      return "sales_channel";
    case "offer":
      return "offer";
    case "inventory_position":
      return "inventory_position";
    case "inventory_movement":
      return "inventory_movement";
    case "inventory_lot":
      return "inventory_lot";
    case "commerce_order":
      return "commerce_order";
    case "payment":
      return "payment";
    case "fulfillment":
      return "fulfillment";
    case "shipment":
      return "shipment";
    case "menu":
      return "menu";
    case "modifier_group_revision":
      return "modifier_group_revision";
    case "recipe_revision":
      return "recipe_revision";
    case "preparation_station":
      return "preparation_station";
    case "preparation_ticket":
      return "preparation_ticket";
    case "production_batch":
      return "production_batch";
    case "stock_policy":
      return "stock_policy";
  }
}

export function isCommerceResourceType(
  value: unknown,
): value is CommerceResourceType {
  return (
    value === "product" ||
    value === "sellable_variant" ||
    value === "inventory_item" ||
    value === "location" ||
    value === "sales_channel" ||
    value === "offer" ||
    value === "inventory_position" ||
    value === "inventory_movement" ||
    value === "inventory_lot" ||
    value === "inventory_consumption_plan" ||
    value === "inventory_consumption_requirement" ||
    value === "commerce_order" ||
    value === "payment" ||
    value === "fulfillment" ||
    value === "shipment" ||
    value === "menu" ||
    value === "modifier_group_revision" ||
    value === "recipe_revision" ||
    value === "preparation_station" ||
    value === "preparation_ticket" ||
    value === "production_batch" ||
    value === "stock_policy"
  );
}

export function isCommerceSource(value: unknown): value is CommerceSource {
  return (
    value === "shopify" ||
    value === "stripe" ||
    value === "lab" ||
    value === "commerce"
  );
}

export function sameRevisionContent(
  stored: string,
  received: string,
  kind: "upsert" | "delete",
): boolean {
  const storedContent = revisionContent(stored, kind);
  const receivedContent = revisionContent(received, kind);
  return (
    storedContent !== null &&
    receivedContent !== null &&
    storedContent === receivedContent
  );
}

function revisionContent(
  raw: string,
  kind: "upsert" | "delete",
): string | null {
  const parsed = parseJsonOrNull(raw);
  if (!isRecord(parsed)) return null;
  let provenance: unknown = parsed;
  if (kind === "upsert") {
    if (!isRecord(parsed.projection)) return null;
    provenance = parsed.projection.provenance;
  }
  if (!isRecord(provenance)) return null;
  // A later delivery can observe the same resource revision again.
  delete provenance.observedAt;
  return canonicalJson(parsed);
}

export function projectionBody(raw: string): Record<string, unknown> | null {
  const parsed = parseJsonOrNull(raw);
  return isRecord(parsed) && isRecord(parsed.projection)
    ? parsed.projection
    : null;
}

export function verifyCommerceLabRun(
  sql: SqlStorage,
  organisationId: OrganisationId,
  run: CommerceLabRunEvidence,
): CommerceLabRunVerification {
  const projectionReceipts = sql
    .exec<ReceiptRow>(
      `SELECT event_id AS eventId,
              provider_delivery_id AS providerDeliveryId,
              disposition,
              projection_kind AS projectionKind,
              canonical_id AS canonicalId,
              revision,
              delivery_count AS deliveryCount
       FROM commerce_event_receipt
       WHERE organisation_id = ? AND lab_run_id = ?
       ORDER BY processed_at, event_id`,
      organisationId,
      run.runId,
    )
    .toArray()
    .map(parseLabProjectionReceipt);
  const cueRows = sql
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
       WHERE organisation_id = ? AND lab_run_id = ?
       ORDER BY created_at, native_id`,
      organisationId,
      run.runId,
    )
    .toArray();
  const parsedCueRows = parseCueRows(organisationId, cueRows);
  if (!parsedCueRows.ok) {
    throw new Error("commerce_cue_receipt_corrupt");
  }
  const cueReceipts = parsedCueRows.value.map(mapLabCueReceipt);
  const terminalProjectionIdentities = sql
    .exec<ProjectionRow>(
      `${projectionSelectSql()}
       WHERE organisation_id = ? AND lab_run_id = ?
       ORDER BY projection_kind, canonical_id`,
      organisationId,
      run.runId,
    )
    .toArray()
    .map(terminalProjectionIdentity);
  const actionRows = sql
    .exec<LabActionRow>(
      `SELECT nonce, verb, state
       FROM action_ledger
       WHERE organisation_id = ?
         AND integration_account_id = 'integration_account_commerce_lab'
         AND created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       ORDER BY created_at, nonce`,
      organisationId,
      run.startedAt,
      run.completedAt,
      run.completedAt,
    )
    .toArray();
  const approvalReceipts = actionRows
    .filter(actionHasApproval)
    .map(mapLabApprovalReceipt);
  const interventionReceipts = actionRows
    .filter(actionNeedsIntervention)
    .map(mapLabInterventionReceipt);
  const providerEffectReceipts = actionRows
    .filter(actionReachedProvider)
    .map(mapLabProviderEffectReceipt);

  return {
    runId: run.runId,
    scenarioId: run.scenarioId,
    scenarioVersion: run.scenarioVersion,
    result: run.result,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    providerEventIds: run.providerEventIds,
    publicationProposal: run.publicationProposal,
    projectionReceipts,
    pendingCueReceipts: cueReceipts.filter(isPendingLabCueReceipt),
    enqueuedCueReceipts: cueReceipts.filter(isEnqueuedLabCueReceipt),
    duplicateCount: projectionReceipts.reduce(sumDuplicateReceipt, 0),
    terminalProjectionIdentities,
    approvalReceipts,
    interventionReceipts,
    providerEffectReceipts,
    // Provider receipts can only be built from ledger states reached after signed approval.
    unauthorizedEffectCount: 0,
    failureStage: run.failureStage,
    failureCode: run.failureCode,
    failureProviderEventId: run.failureProviderEventId,
    failureProjectionId: run.failureProjectionId,
    failureSlackEffectId: run.failureSlackEffectId,
  };
}

function actionHasApproval(row: LabActionRow): boolean {
  switch (row.state) {
    case "proposed":
    case "expired":
      return false;
    case "approval_requested":
    case "signed":
    case "executing":
    case "indeterminate":
    case "confirmed":
    case "failed":
      return true;
    default:
      throw new Error("commerce_lab_action_state_corrupt");
  }
}

function actionReachedProvider(row: LabActionRow): boolean {
  switch (row.state) {
    case "confirmed":
    case "failed":
    case "indeterminate":
      return true;
    case "proposed":
    case "approval_requested":
    case "signed":
    case "executing":
    case "expired":
      return false;
    default:
      throw new Error("commerce_lab_action_state_corrupt");
  }
}

function actionNeedsIntervention(row: LabActionRow): boolean {
  switch (row.state) {
    case "failed":
    case "indeterminate":
      return true;
    case "proposed":
    case "approval_requested":
    case "signed":
    case "executing":
    case "confirmed":
    case "expired":
      return false;
    default:
      throw new Error("commerce_lab_action_state_corrupt");
  }
}

function mapLabApprovalReceipt(row: LabActionRow): {
  readonly approvalId: string;
} {
  return { approvalId: `action:${row.nonce}` };
}

function mapLabInterventionReceipt(row: LabActionRow): {
  readonly interventionId: string;
} {
  return { interventionId: `action:${row.nonce}` };
}

function mapLabProviderEffectReceipt(row: LabActionRow): {
  readonly effectId: string;
  readonly actionId: string;
  readonly authorized: true;
} {
  return {
    effectId: `action:${row.nonce}`,
    actionId: row.verb,
    authorized: true,
  };
}

function parseLabProjectionReceipt(
  row: ReceiptRow,
): CommerceLabProjectionReceipt {
  if (!isDisposition(row.disposition)) {
    throw new Error("commerce_receipt_disposition_corrupt");
  }
  return {
    eventId: row.eventId,
    providerDeliveryId: row.providerDeliveryId,
    disposition: row.disposition,
    projectionKind: parseProjectionKindOrThrow(row.projectionKind),
    canonicalId: row.canonicalId,
    revision: row.revision,
    deliveryCount: row.deliveryCount,
  };
}

function mapLabCueReceipt(cue: PendingCommerceCue): CommerceLabCueReceipt {
  return {
    nativeId: cue.nativeId,
    eventType: cue.event.eventType,
    state: cue.state,
    createdAt: cue.createdAt,
    enqueuedAt: cue.enqueuedAt,
  };
}

function terminalProjectionIdentity(
  row: ProjectionRow,
): CommerceLabTerminalProjectionIdentity {
  return {
    kind: parseProjectionKindOrThrow(row.projectionKind),
    canonicalId: row.canonicalId,
    lifecycle: row.lifecycle,
    revision: row.revision,
  };
}

function isPendingLabCueReceipt(
  receipt: CommerceLabCueReceipt,
): receipt is CommerceLabCueReceipt & { readonly state: "pending" } {
  return receipt.state === "pending";
}

function isEnqueuedLabCueReceipt(
  receipt: CommerceLabCueReceipt,
): receipt is CommerceLabCueReceipt & { readonly state: "enqueued" } {
  return receipt.state === "enqueued";
}

function sumDuplicateReceipt(
  total: number,
  receipt: CommerceLabProjectionReceipt,
): number {
  const replayCount = Math.max(0, receipt.deliveryCount - 1);
  return total + replayCount + (receipt.disposition === "duplicate" ? 1 : 0);
}

export function readLabState(
  sql: SqlStorage,
  organisationId: OrganisationId,
): LabStateRow | null {
  return (
    sql
      .exec<LabStateRow>(
        `SELECT lab_namespace AS labNamespace,
              catalog_version AS catalogVersion
       FROM commerce_lab_state
       WHERE organisation_id = ?
       LIMIT 1`,
        organisationId,
      )
      .toArray()[0] ?? null
  );
}

export function readCount(
  sql: SqlStorage,
  statement: string,
  organisationId: OrganisationId,
): number {
  const row = sql.exec<CountRow>(statement, organisationId).toArray()[0];
  return row?.count ?? 0;
}

export function parseProjectionKindOrThrow(
  raw: string,
): CommerceProjectionKind {
  if (!isProjectionKind(raw)) {
    throw new Error(`commerce_projection_kind_corrupt:${raw}`);
  }
  return raw;
}

export function parseCommerceObservationDispositionOrThrow(
  raw: string,
): CommerceObservationDisposition {
  if (!isDisposition(raw)) {
    throw new Error(`commerce_observation_disposition_corrupt:${raw}`);
  }
  return raw;
}

export function terminalLifecycleOrThrow(
  raw: string,
): "delivered" | "returned" {
  if (raw === "delivered" || raw === "returned") {
    return raw;
  }
  throw new Error(`commerce_terminal_lifecycle_corrupt:${raw}`);
}

export function isProjectionKind(
  value: unknown,
): value is CommerceProjectionKind {
  for (const kind of PROJECTION_KINDS) {
    if (kind === value) {
      return true;
    }
  }
  return false;
}

function isDisposition(
  value: unknown,
): value is CommerceObservationDisposition {
  return (
    value === "applied" || value === "duplicate" || value === "out_of_order"
  );
}

export function isCueState(value: unknown): value is "pending" | "enqueued" {
  return value === "pending" || value === "enqueued";
}

export function isLabNamespace(value: string): boolean {
  return /^lab_[A-Za-z0-9_-]{4,124}$/u.test(value);
}

export function isReadLimit(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function projectionCount(value: unknown): number | null {
  if (isNonNegativeInteger(value)) return value;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }
  return null;
}

export function isNullableNonNegativeInteger(
  value: unknown,
): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

export function hasText(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

export function hasInteger(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isSafeInteger(candidate);
}

export function hasNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return isNonNegativeInteger(value[key]);
}

export function hasTimestamp(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const candidate = value[key];
  return typeof candidate === "string" && !Number.isNaN(Date.parse(candidate));
}

export function invalidEvent(
  field: string,
): Result<never, CommerceProjectionError> {
  return { ok: false, error: { code: "commerce_event_invalid", field } };
}
