import { pantryCommerceAccess } from "./app-access";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type {
  CommerceCursor,
  CommerceEntity,
  CommerceGraphQuery,
} from "@purin-labs/contracts";
import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";

import { assertCommerceGraphQueryWithLexicon } from "./commerce-wasm";
import { resolveCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import type { Env } from "../env";
import { newRequestId, type OrganisationId } from "../ids";
import type { Result } from "../result";
import { commerceCanonicalResourceId } from "./provider";
import { buildSavedSelectorCommerceReadAuthority } from "./entity-plane/authority";
import { CommerceGraphReader } from "./entity-plane/graph-reader";
import { CommerceEngineSource } from "./entity-plane/commerce-source";
import { isRecord, sha256Hex } from "@purin-labs/std";
import type {
  CommerceExceptionInbox,
  MissingTrackingException,
  TrackingBatchPreview,
  TrackingBatchPreviewItem,
} from "@purin-labs/control-api";

const INBOX_PAGE_LIMIT = 100;
const INBOX_RESULT_LIMIT = 500;

type TrackingBatchPreviewRequest = Readonly<{
  exceptionIds: readonly string[];
}>;

type TrackingBatchPreviewError = Readonly<{
  code: "tracking_batch_invalid" | "tracking_batch_unavailable";
}>;

export function parseTrackingBatchPreviewRequest(
  value: unknown,
): Result<TrackingBatchPreviewRequest, TrackingBatchPreviewError> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.exceptionIds) ||
    value.exceptionIds.length === 0 ||
    value.exceptionIds.length > 50 ||
    !value.exceptionIds.every(isExceptionId)
  ) {
    return { ok: false, error: { code: "tracking_batch_invalid" } };
  }
  const exceptionIds = value.exceptionIds as string[];
  if (new Set(exceptionIds).size !== exceptionIds.length) {
    return { ok: false, error: { code: "tracking_batch_invalid" } };
  }
  return { ok: true, value: { exceptionIds } };
}

export async function readCommerceExceptionInbox(
  env: Env,
  organisationId: OrganisationId,
): Promise<CommerceExceptionInbox> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok)
    return { kind: "unavailable", reason: "commerce_system_unavailable" };
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: execution.value.database,
    organisationId,
  });
  if (!authority.ok)
    return { kind: "unavailable", reason: "commerce_system_unavailable" };
  if (
    authority.value.provider !== "underclerk" ||
    authority.value.commerceSystem.kind !== "satyr_commerce"
  ) {
    return { kind: "unavailable", reason: "resolution_unsupported" };
  }
  const binding = await resolveCommerceMerchantBinding({
    db: execution.value.database,
    organisationId,
    integrationAccountId: authority.value.integrationAccountId,
  });
  if (
    !binding.ok ||
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return { kind: "unavailable", reason: "entity_plane_unavailable" };
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
      ),
    });
  } catch {
    return { kind: "unavailable", reason: "entity_plane_unavailable" };
  }
  const commerceEngine = new CommerceEngineSource({
    organisationId,
    merchantId: binding.value.merchantId,
    integrationAccountId: binding.value.integrationAccountId,
    client,
  });
  const reader = new CommerceGraphReader({
    organisationId,
    merchantId: binding.value.merchantId,
    commerceSystem: authority.value.commerceSystem,
    underclerk: commerceEngine,
  });
  try {
    const observedAt = new Date().toISOString();
    const fulfillments = await readSystemEntities({
      reader,
      organisationId,
      merchantId: binding.value.merchantId,
      typeId: "fulfillment",
      observedAt,
    });
    const shipments = await readSystemEntities({
      reader,
      organisationId,
      merchantId: binding.value.merchantId,
      typeId: "shipment",
      observedAt,
    });
    if (!fulfillments.ok || !shipments.ok) {
      return { kind: "unavailable", reason: "entity_plane_unavailable" };
    }
    if (
      fulfillments.value.merchantRevision !== shipments.value.merchantRevision
    ) {
      return { kind: "unavailable", reason: "entity_plane_unavailable" };
    }
    return {
      kind: "ready",
      observedAt,
      items: deriveMissingTrackingExceptions({
        merchantId: binding.value.merchantId,
        merchantRevision: fulfillments.value.merchantRevision,
        fulfillments: fulfillments.value.entities,
        shipments: shipments.value.entities,
      }),
    };
  } catch {
    return { kind: "unavailable", reason: "entity_plane_unavailable" };
  }
}

export async function previewTrackingBatch(
  inbox: CommerceExceptionInbox,
  request: TrackingBatchPreviewRequest,
  now: number,
): Promise<Result<TrackingBatchPreview, TrackingBatchPreviewError>> {
  if (inbox.kind !== "ready") {
    return { ok: false, error: { code: "tracking_batch_unavailable" } };
  }
  const byId = new Map<string, MissingTrackingException>();
  for (const item of inbox.items) byId.set(item.exceptionId, item);
  const frozenTargets: Array<
    Readonly<{
      exceptionId: string;
      target: MissingTrackingException["target"] | null;
    }>
  > = [];
  for (const exceptionId of request.exceptionIds) {
    const item = byId.get(exceptionId);
    frozenTargets.push(
      item === undefined
        ? { exceptionId, target: null }
        : { exceptionId, target: item.target },
    );
  }
  const digest = await sha256Hex(JSON.stringify(frozenTargets));
  const batchId = `tracking_batch_${digest}`;
  const items: TrackingBatchPreviewItem[] = [];
  for (const frozen of frozenTargets) {
    if (frozen.target === null) {
      items.push({
        exceptionId: frozen.exceptionId,
        validation: { kind: "invalid", reason: "closed_or_changed" },
        action: null,
      });
    } else {
      items.push({
        exceptionId: frozen.exceptionId,
        validation: { kind: "valid" },
        action: { kind: "attach_tracking", batchId, ...frozen.target },
      });
    }
  }
  return {
    ok: true,
    value: {
      kind: "tracking_batch_preview",
      batchId,
      frozenAt: new Date(now).toISOString(),
      items,
    },
  };
}

type SystemEntityRead = Readonly<{
  merchantRevision: number;
  entities: readonly CommerceEntity[];
}>;

async function readSystemEntities(
  input: Readonly<{
    reader: CommerceGraphReader;
    organisationId: OrganisationId;
    merchantId: string;
    typeId: "fulfillment" | "shipment";
    observedAt: string;
  }>,
): Promise<Result<SystemEntityRead, Readonly<{ code: "read_failed" }>>> {
  const entities: CommerceEntity[] = [];
  let merchantRevision = 0;
  let cursor: CommerceCursor | null = null;
  do {
    const query = entityPageQuery(input.typeId, cursor);
    const authority = buildSavedSelectorCommerceReadAuthority({
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      principalId: "operations_workbench",
      sensitivityCeiling: "internal",
      expiresAt: new Date(Date.parse(input.observedAt) + 60_000).toISOString(),
      commandId: newRequestId(),
      selectorId: `operations_${input.typeId}_${entities.length}`,
      selectorRevision: 1,
      query,
    });
    if (!authority.ok) return { ok: false, error: { code: "read_failed" } };
    const page = await input.reader.query({
      query,
      authority: authority.value,
      now: input.observedAt,
    });
    if (!page.ok) return { ok: false, error: { code: "read_failed" } };
    entities.push(...page.value.entities);
    merchantRevision = Math.max(
      merchantRevision,
      Number(page.value.merchantRevision),
    );
    cursor = page.value.nextCursor;
  } while (cursor !== null && entities.length < INBOX_RESULT_LIMIT);
  if (cursor !== null) return { ok: false, error: { code: "read_failed" } };
  return { ok: true, value: { merchantRevision, entities } };
}

function entityPageQuery(
  typeId: "fulfillment" | "shipment",
  cursor: CommerceCursor | null,
): CommerceGraphQuery {
  const value: unknown = {
    kind: "entity_type_page",
    entityTypeId: { origin: "system", typeId },
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: INBOX_PAGE_LIMIT, cursor },
    traversal: { maxDepth: 0, resultLimit: INBOX_PAGE_LIMIT },
  };
  assertCommerceGraphQueryWithLexicon(value);
  return value;
}

export function deriveMissingTrackingExceptions(
  input: Readonly<{
    merchantId: string;
    merchantRevision: number;
    fulfillments: readonly CommerceEntity[];
    shipments: readonly CommerceEntity[];
  }>,
): readonly MissingTrackingException[] {
  const fulfillmentById = new Map<string, CommerceEntity>();
  for (const entity of input.fulfillments) {
    if (isCurrentSystemFulfillment(entity)) {
      fulfillmentById.set(String(entity.reference.entityId), entity);
    }
  }
  const items = new Map<string, MissingTrackingException>();
  for (const shipment of input.shipments) {
    if (
      !isCurrentSystemShipment(shipment) ||
      statusAttribute(shipment, "lifecycle") !== "label_purchased"
    )
      continue;
    const fulfillmentId = textAttribute(shipment, "fulfillment_id");
    const orderId = textAttribute(shipment, "order_id");
    const trackingNumber = textAttribute(shipment, "tracking_number");
    if (fulfillmentId === null || orderId === null || trackingNumber === null)
      continue;
    const fulfillment = fulfillmentById.get(fulfillmentId);
    if (
      fulfillment === undefined ||
      statusAttribute(fulfillment, "lifecycle") !== "requested" ||
      textAttribute(fulfillment, "order_id") !== orderId
    )
      continue;
    const dueAt = timestampAttribute(fulfillment, "expected_by");
    if (dueAt === null) continue;
    const canonicalOrderId = commerceCanonicalResourceId(
      input.merchantId,
      orderId,
    );
    const canonicalFulfillmentId = commerceCanonicalResourceId(
      input.merchantId,
      fulfillmentId,
    );
    const canonicalShipmentId = commerceCanonicalResourceId(
      input.merchantId,
      String(shipment.reference.entityId),
    );
    const exceptionId = `missing_tracking:${encodeURIComponent(canonicalFulfillmentId)}:${encodeURIComponent(canonicalShipmentId)}`;
    items.set(exceptionId, {
      kind: "missing_tracking",
      exceptionId,
      reason:
        "This fulfillment has a shipping label and is waiting for its tracking reference to be attached.",
      owner: { kind: "unassigned" },
      dueAt,
      recommendedAction: { kind: "attach_tracking", label: "Attach tracking" },
      resolution: {
        kind: "fulfillment_lifecycle",
        expectedState: "handed_to_carrier",
      },
      target: {
        merchantRevision: input.merchantRevision,
        orderId: canonicalOrderId,
        fulfillmentId: canonicalFulfillmentId,
        fulfillmentRevision: Number(fulfillment.revision),
        shipmentId: canonicalShipmentId,
        shipmentRevision: Number(shipment.revision),
        trackingNumber,
      },
      freshness: "current",
    });
  }
  return [...items.values()].sort(compareExceptions);
}

function compareExceptions(
  left: MissingTrackingException,
  right: MissingTrackingException,
): number {
  const due = left.dueAt.localeCompare(right.dueAt);
  return due === 0 ? left.exceptionId.localeCompare(right.exceptionId) : due;
}

function isCurrentSystemFulfillment(entity: CommerceEntity): boolean {
  return (
    entity.reference.origin === "system" &&
    entity.reference.typeId === "fulfillment" &&
    entity.provenance !== undefined &&
    entity.freshness !== undefined &&
    entity.provenance.source === "underclerk" &&
    entity.freshness.state === "current"
  );
}

function isCurrentSystemShipment(entity: CommerceEntity): boolean {
  return (
    entity.reference.origin === "system" &&
    entity.reference.typeId === "shipment" &&
    entity.provenance !== undefined &&
    entity.freshness !== undefined &&
    entity.provenance.source === "underclerk" &&
    entity.freshness.state === "current"
  );
}

function textAttribute(
  entity: CommerceEntity,
  attributeId: string,
): string | null {
  const value = entity.attributes.find(
    hasAttributeId.bind(null, attributeId),
  )?.value;
  return value?.kind === "short_text" ? value.value : null;
}

function timestampAttribute(
  entity: CommerceEntity,
  attributeId: string,
): string | null {
  const value = entity.attributes.find(
    hasAttributeId.bind(null, attributeId),
  )?.value;
  return value?.kind === "timestamp" ? String(value.value) : null;
}

function statusAttribute(
  entity: CommerceEntity,
  attributeId: string,
): string | null {
  const value = entity.attributes.find(
    hasAttributeId.bind(null, attributeId),
  )?.value;
  return value?.kind === "status" ? String(value.value) : null;
}

function hasAttributeId(
  attributeId: string,
  assignment: CommerceEntity["attributes"][number],
): boolean {
  return assignment.attributeId === attributeId;
}

function isExceptionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^missing_tracking:[^:\s]+:[^\s]+$/u.test(value) &&
    value.length <= 768
  );
}
