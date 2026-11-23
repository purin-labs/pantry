import type {
  AttributeDefinitionRevision,
  AttributeDefinitionId,
  AttributeOptionId,
  AttributeValue,
  AttributeValueAssignment,
  CommerceEntityRevision,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceCursor,
  CommerceFreshness,
  CommerceQueryPlan,
  CommerceGraphQueryPlanRequest,
  CommerceQueryPlanErrorCapability,
  CommerceAggregationResult,
  CommerceProjection,
  CommerceOrderingValue,
  CommerceRelationship,
  ExternalResourceReference,
  RelationshipDefinitionRevision,
  RelationshipId,
  RelationshipRevision,
  SourceProvenance,
  SystemCommerceEntity,
  SystemCommerceEntityKind,
  SystemCommerceEntityRef,
  SystemCommerceRelationship,
  SystemSchemaRevision,
  SystemRelationshipDefinitionKind,
} from "@purin-labs/commerce-contracts";
import {
  parseAttributeDefinitionRevision,
  parseAttributeDefinitionId,
  parseAttributeOptionId,
  parseCommerceEntityRevision,
  parseCommerceRelationship,
  parseCommerceSnapshotRevision,
  parseRelationshipDefinitionRevision,
  parseRelationshipId,
  parseRelationshipRevision,
  parseSystemEntityRef,
  parseSystemSchemaRevision,
} from "@purin-labs/commerce-client";
import type { CommerceQueryPlanReadError } from "../actors/organisation/commerce-types";
import type { OrganisationStateError } from "@purin-labs/tenancy/actors/organisation/types";
import type { OrganisationCommerce } from "../actors/organisation/organisation-commerce";
import {
  COMMERCE_PROJECTION_STALE_AFTER_MS,
  type CommerceProjectionKind,
  type CommerceProjectionRecord,
} from "../actors/commerce-projection";
import type {
  CommerceEntityRelationRow,
  CommerceRelationshipRelationRow,
} from "../actors/commerce-query-schema";
import { materializeCommerceRelationText } from "../actors/commerce-query-schema";
import type { Result } from "@purin-labs/kernel/result";
import { encodeCommerceCursor } from "../commerce-wasm";
import type {
  CommerceGraphSourceError,
  CommerceGraphSourceValue,
  CommerceGraphSourceResult,
  CommerceGraphSourceQueryOptions,
  CommerceGraphRelationshipStepResult,
} from "./commerce-source";
import { assertNever, errorMessage, isRecord } from "@purin-labs/std";
export type BlotterOrganisationReader = Pick<
  OrganisationCommerce,
  | "readCommerceQueryPlan"
  | "readAcceptedCommerceProjectionSequence"
  | "readCommerceRelationshipStep"
  | "readExactCommerceProjectionReference"
>;

type BlotterQueryPlanError =
  | Readonly<{
      readonly code: "query_unsupported";
      readonly source: "blotter";
      readonly capability: CommerceQueryPlanErrorCapability;
    }>
  | Readonly<{
      readonly code: "query_stale";
      readonly expected: import("@purin-labs/commerce-contracts").CommerceReadWatermark;
      readonly received: import("@purin-labs/commerce-contracts").CommerceReadWatermark;
    }>;

export type BlotterQueryPlanResult = Result<
  CommerceGraphSourceValue,
  CommerceGraphSourceError | BlotterQueryPlanError
>;

type BlotterSourceOptions = Readonly<{
  organisationId: import("@purin-labs/kernel/ids").OrganisationId;
  merchantId: string;
  integrationAccountId: import("@purin-labs/kernel/ids").IntegrationAccountId;
  organisation: BlotterOrganisationReader;
  now?: () => number;
}>;

export type BlotterQueryPlanInput = Readonly<{
  readonly planRequest: CommerceGraphQueryPlanRequest;
  readonly plan: CommerceQueryPlan;
}>;

type BlotterRelationshipStepInput = Readonly<{
  readonly planRequest: CommerceGraphQueryPlanRequest;
  readonly plan: CommerceQueryPlan;
  readonly frontier: readonly CommerceEntityRef[];
  readonly remaining: number;
}>;

type BlotterRelationshipStepResult = CommerceGraphRelationshipStepResult;

type BlotterRecord = CommerceProjectionRecord;
/** Reads retained provider facts without exposing the old presentation DTOs. */
export class BlotterSource {
  readonly source = "blotter";
  readonly #organisationId: BlotterSourceOptions["organisationId"];
  readonly #merchantId: string;
  readonly #integrationAccountId: BlotterSourceOptions["integrationAccountId"];
  readonly #organisation: BlotterOrganisationReader;
  readonly #now: () => number;

  constructor(options: BlotterSourceOptions) {
    this.#organisationId = options.organisationId;
    this.#merchantId = normalizedIdentifier(options.merchantId, "merchantId");
    this.#integrationAccountId = options.integrationAccountId;
    this.#organisation = options.organisation;
    this.#now = options.now ?? Date.now;
  }

  async queryPlan(
    input: BlotterQueryPlanInput,
    _options: CommerceGraphSourceQueryOptions = {
      sensitivityCeiling: "restricted",
    },
  ): Promise<BlotterQueryPlanResult> {
    const read = await this.#organisation.readCommerceQueryPlan({
      organisationId: this.#organisationId,
      integrationAccountId: this.#integrationAccountId,
      planRequest: input.planRequest,
      plan: input.plan,
    });
    if (!read.ok) return planReadFailure(read.error);
    if (read.value.kind === "count") {
      return aggregationResult(read.value.aggregation);
    }
    let nextCursor: CommerceCursor | null = null;
    if (read.value.hasMore) {
      const row = read.value.rows.at(-1);
      const record = read.value.records.at(-1);
      if (row === undefined || record === undefined) {
        return sourceFailure({ code: "commerce_query_relation_corrupt" });
      }
      const orderingValues = cursorOrderingValues(input.plan, row, record);
      if (orderingValues === null) {
        return sourceFailure({ code: "commerce_query_relation_corrupt" });
      }
      const encoded = encodeCommerceCursor({
        organisationId: this.#organisationId,
        merchantId: this.#merchantId,
        queryFingerprint: input.plan.queryFingerprint,
        semanticsVersion: input.plan.semanticsVersion,
        orderingVersion: input.plan.orderingVersion,
        effectiveOrdering: input.plan.effectiveOrdering,
        boundary: {
          orderingValues,
          entityRef: parseSystemEntityRef(
            systemTypeId(record.kind),
            record.canonicalId,
          ),
        },
        watermark: input.plan.watermark,
      });
      if (!encoded.ok) return sourceFailure(encoded.error);
      nextCursor = encoded.value;
    }
    const result = resultFromRecords(read.value.records, this.#now(), null);
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value, nextCursor } };
  }

  async readSnapshotRevision(): Promise<
    Result<
      import("@purin-labs/commerce-contracts").CommerceSnapshotRevision,
      CommerceGraphSourceError
    >
  > {
    const read =
      await this.#organisation.readAcceptedCommerceProjectionSequence({
        organisationId: this.#organisationId,
        integrationAccountId: this.#integrationAccountId,
      });
    if (!read.ok) return sourceFailure(read.error);
    try {
      return {
        ok: true,
        value: parseCommerceSnapshotRevision(
          read.value,
          "blotterAcceptedProjectionSequence",
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "source_invalid",
          source: "blotter",
          message: errorMessage(error),
        },
      };
    }
  }

  async hydrateSystemEntities(
    references: readonly CommerceEntityRef[],
  ): Promise<CommerceGraphSourceResult> {
    const entities: SystemCommerceEntity[] = [];
    for (const reference of references) {
      if (reference.origin !== "system")
        return sourceFailure({
          code: "commerce_projection_exact_hydration_non_system_reference",
        });
      const hydrated = await this.#exactHydrateSystemEntity(reference);
      if (!hydrated.ok) return hydrated;
      entities.push(hydrated.value);
    }
    return {
      ok: true,
      value: {
        merchantRevision: null,
        entities,
        relationships: [],
        listEntries: [],
        aggregations: [],
        nextCursor: null,
        provenance: entities.map((entity) => entity.provenance),
        freshness: entities.map((entity) => entity.freshness),
      },
    };
  }

  async readRelationshipStep(
    input: BlotterRelationshipStepInput,
  ): Promise<BlotterRelationshipStepResult> {
    const frontier = input.frontier.filter(
      (reference): reference is SystemCommerceEntityRef =>
        reference.origin === "system",
    );
    if (frontier.length !== input.frontier.length) {
      return sourceFailure({
        code: "commerce_relationship_frontier_must_be_system",
      });
    }
    const read = await this.#organisation.readCommerceRelationshipStep({
      organisationId: this.#organisationId,
      integrationAccountId: this.#integrationAccountId,
      planRequest: input.planRequest,
      plan: input.plan,
      frontier,
      remaining: input.remaining,
    });
    if (!read.ok) return relationshipPlanReadFailure(read.error);
    const entities = new Map<string, SystemCommerceEntity>();
    const relationships: CommerceRelationship[] = [];
    for (const row of read.value) {
      const sourceReference = parseSystemEntityRef(
        row.source_type_id,
        row.source_entity_id,
      );
      const sourceKey = entityKey(sourceReference);
      let sourceEntity = entities.get(sourceKey);
      if (sourceEntity === undefined) {
        const hydrated = await this.#exactHydrateSystemEntity(sourceReference);
        if (!hydrated.ok) return hydrated;
        sourceEntity = hydrated.value;
        entities.set(sourceKey, sourceEntity);
      }
      const relationship = relationshipFromRelationRow(
        row,
        sourceEntity.provenance,
      );
      if (relationship === null) {
        return sourceFailure({
          code: "commerce_relationship_relation_corrupt",
        });
      }
      relationships.push(relationship);
    }
    for (const reference of [
      ...frontier,
      ...relationships.flatMap((relationship) => [
        relationship.source,
        relationship.target,
      ]),
    ]) {
      const key = entityKey(reference);
      if (entities.has(key)) continue;
      if (reference.origin !== "system") {
        return sourceFailure({
          code: "commerce_projection_exact_hydration_non_system_reference",
        });
      }
      const hydrated = await this.#exactHydrateSystemEntity(reference);
      if (!hydrated.ok) return hydrated;
      entities.set(key, hydrated.value);
    }
    const values = [...entities.values()];
    return {
      ok: true,
      value: {
        merchantRevision: null,
        entities: values,
        relationships,
        listEntries: [],
        aggregations: [],
        nextCursor: null,
        provenance: values.map((entity) => entity.provenance),
        freshness: values.map((entity) => entity.freshness),
      },
    };
  }

  async #exactHydrateSystemEntity(
    reference: SystemCommerceEntityRef,
  ): Promise<Result<SystemCommerceEntity, CommerceGraphSourceError>> {
    const read = await this.#organisation.readExactCommerceProjectionReference({
      organisationId: this.#organisationId,
      integrationAccountId: this.#integrationAccountId,
      kind: projectionKindForEntityType(reference.typeId),
      canonicalId: reference.entityId,
    });
    if (!read.ok || read.value === null) {
      return sourceFailure({
        code: "commerce_projection_exact_hydration_failed",
      });
    }
    const entity = entityFromRecord(read.value, this.#now());
    return entity === undefined ||
      entityKey(entity.reference) !== entityKey(reference)
      ? sourceFailure({ code: "commerce_projection_exact_hydration_mismatch" })
      : { ok: true, value: entity };
  }
}

function aggregationResult(
  aggregation: CommerceAggregationResult,
): BlotterQueryPlanResult {
  return {
    ok: true,
    value: {
      merchantRevision: null,
      entities: [],
      relationships: [],
      listEntries: [],
      aggregations: [aggregation],
      nextCursor: null,
      provenance: [],
      freshness: [],
    },
  };
}

function relationshipFromRelationRow(
  row: CommerceRelationshipRelationRow,
  sourceProvenance: SourceProvenance,
): CommerceRelationship | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(payload) ||
    payload.relationshipId !== row.relationship_id ||
    payload.relationshipRevision !== row.relationship_revision
  ) {
    return null;
  }
  try {
    return parseCommerceRelationship({
      origin: row.relationship_origin,
      relationshipId: row.relationship_id,
      definition: {
        origin: row.definition_origin,
        definitionId: row.definition_id,
        revision: row.definition_revision,
      },
      sensitivity: row.sensitivity,
      source: {
        origin: row.source_origin,
        typeId: row.source_type_id,
        entityId: row.source_entity_id,
      },
      target: {
        origin: row.target_origin,
        typeId: row.target_type_id,
        entityId: row.target_entity_id,
      },
      revision: row.relationship_revision,
      provenance: sourceProvenance,
    });
  } catch {
    return null;
  }
}

function resultFromRecords(
  records: readonly BlotterRecord[],
  now: number,
  nextCursor: CommerceCursor | null,
): CommerceGraphSourceResult {
  const entities = records.map((record) => entityFromRecord(record, now));
  const relationships = relationshipsFromRecords(records, now);
  return {
    ok: true,
    value: {
      merchantRevision: null,
      entities,
      relationships: [...relationships],
      listEntries: [],
      aggregations: [],
      nextCursor,
      provenance: records.map(
        (record) => record.projection.projection.provenance,
      ),
      freshness: records.map((record) => freshness(record, now)),
    },
  };
}

function entityFromRecord(
  record: BlotterRecord,
  now: number,
): SystemCommerceEntity {
  const reference = parseSystemEntityRef(
    systemTypeId(record.kind),
    record.canonicalId,
  );
  return {
    reference,
    revision: commerceEntityRevision(record.revision),
    displayName: displayName(record),
    attributes: attributes(record),
    provenance: record.projection.projection.provenance,
    freshness: freshness(record, now),
  };
}

function attributes(record: BlotterRecord): AttributeValueAssignment[] {
  const projection = record.projection;
  const entityTypeId = entityTypeIdForKind(record.kind);
  const result: AttributeValueAssignment[] = [];
  const lifecycle = lifecycleLabel(projection);
  if (lifecycle !== null)
    result.push(
      attribute(entityTypeId, "lifecycle", {
        kind: "status",
        value: attributeOptionId(lifecycle),
      }),
    );
  switch (projection.kind) {
    case "product":
      result.push(
        attribute(entityTypeId, "title", {
          kind: "short_text",
          value: projection.projection.title,
        }),
      );
      break;
    case "sellable_variant":
      result.push(
        attribute(entityTypeId, "sku", {
          kind: "short_text",
          value: projection.projection.sku,
        }),
      );
      result.push(
        attribute(entityTypeId, "product_id", {
          kind: "external_resource_reference",
          value: externalReference(projection.projection.productId),
        }),
      );
      break;
    case "inventory_item":
      result.push(
        attribute(entityTypeId, "merchant_code", {
          kind: "short_text",
          value: projection.projection.merchantCode,
        }),
      );
      result.push(
        attribute(entityTypeId, "name", {
          kind: "short_text",
          value: projection.projection.name,
        }),
      );
      break;
    case "commerce_order":
      result.push(
        attribute(entityTypeId, "buyer", {
          kind: "short_text",
          value:
            projection.projection.buyer.kind === "identified"
              ? projection.projection.buyer.customerReference
              : "Guest",
        }),
      );
      break;
    case "payment":
      result.push(
        attribute(entityTypeId, "order_id", {
          kind: "external_resource_reference",
          value: externalReference(projection.projection.orderId),
        }),
      );
      break;
    case "fulfillment":
      result.push(
        attribute(entityTypeId, "order_id", {
          kind: "short_text",
          value: projection.projection.orderId,
        }),
      );
      result.push(
        attribute(entityTypeId, "expected_by", {
          kind: "timestamp",
          value: projection.projection.expectedBy,
        }),
      );
      break;
    case "shipment":
      result.push(
        attribute(entityTypeId, "order_id", {
          kind: "short_text",
          value: projection.projection.orderId,
        }),
      );
      result.push(
        attribute(entityTypeId, "fulfillment_id", {
          kind: "short_text",
          value: projection.projection.fulfillmentId,
        }),
      );
      if (projection.projection.kind === "external") {
        result.push(
          attribute(entityTypeId, "tracking_number", {
            kind: "short_text",
            value: projection.projection.trackingNumber,
          }),
        );
      } else if (
        projection.projection.lifecycle.state === "label_purchased" ||
        projection.projection.lifecycle.state === "in_transit" ||
        projection.projection.lifecycle.state === "delivered"
      ) {
        result.push(
          attribute(entityTypeId, "tracking_number", {
            kind: "short_text",
            value: projection.projection.lifecycle.trackingNumber,
          }),
        );
      }
      break;
    case "location":
      result.push(
        attribute(entityTypeId, "name", {
          kind: "short_text",
          value: projection.projection.name,
        }),
      );
      break;
    case "sales_channel":
      result.push(
        attribute(entityTypeId, "name", {
          kind: "short_text",
          value: projection.projection.name,
        }),
      );
      break;
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      break;
    default:
      return assertNever(projection);
  }
  return result;
}

function attribute(
  entityTypeId: CommerceEntityTypeId,
  id: string,
  value: AttributeValue,
): AttributeValueAssignment {
  if (entityTypeId.origin !== "system") {
    throw new Error("Blotter attributes require a system entity type");
  }
  return {
    attributeId: attributeDefinitionId(id),
    scope: {
      kind: "system",
      entityTypeId: entityTypeId.typeId,
      schemaRevision: systemSchemaRevision(1),
    },
    definitionRevision: attributeDefinitionRevision(1),
    sensitivity: "internal",
    value,
  };
}

function externalReference(value: string): ExternalResourceReference {
  return { source: "shopify", resourceId: value, label: null };
}

function entityTypeIdForKind(
  kind: CommerceProjectionKind,
): CommerceEntityTypeId {
  return { origin: "system", typeId: systemTypeId(kind) };
}

function systemTypeId(kind: CommerceProjectionKind): SystemCommerceEntityKind {
  switch (kind) {
    case "commerce_order":
      return "order";
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "location":
    case "sales_channel":
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "payment":
    case "fulfillment":
    case "shipment":
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      return kind;
    default:
      return assertNever(kind);
  }
}

function attributeDefinitionId(value: string): AttributeDefinitionId {
  return parseAttributeDefinitionId(value);
}

function attributeOptionId(value: string): AttributeOptionId {
  return parseAttributeOptionId(value);
}

function displayName(record: BlotterRecord): string {
  const projection = record.projection;
  switch (projection.kind) {
    case "product":
      return projection.projection.title;
    case "sellable_variant":
      return projection.projection.title;
    case "inventory_item":
      return projection.projection.name;
    case "location":
      return projection.projection.name;
    case "sales_channel":
      return projection.projection.name;
    case "commerce_order":
      return projection.projection.buyer.kind === "identified"
        ? projection.projection.buyer.customerReference
        : record.canonicalId;
    case "payment":
      return `Payment ${record.canonicalId}`;
    case "fulfillment":
      return `Fulfillment ${record.canonicalId}`;
    case "shipment":
      return projection.projection.kind === "external"
        ? projection.projection.trackingNumber
        : `Shipment ${record.canonicalId}`;
    case "offer":
      return `Offer ${record.canonicalId}`;
    case "inventory_position":
      return `Inventory position ${record.canonicalId}`;
    case "inventory_movement":
      return `Inventory movement ${record.canonicalId}`;
    case "inventory_lot":
      return projection.projection.lotCode;
    case "menu":
      return projection.projection.name;
    case "modifier_group_revision":
      return `Modifier group ${record.canonicalId}`;
    case "recipe_revision":
      return `Recipe ${record.canonicalId}`;
    case "preparation_station":
      return `Preparation station ${record.canonicalId}`;
    case "preparation_ticket":
      return `Preparation ticket ${record.canonicalId}`;
    case "production_batch":
      return `Production batch ${record.canonicalId}`;
    case "stock_policy":
      return `Stock policy ${record.canonicalId}`;
    default:
      return assertNever(projection);
  }
}

function lifecycleLabel(projection: CommerceProjection): string | null {
  switch (projection.kind) {
    case "product":
      return null;
    case "sellable_variant":
      return null;
    case "inventory_item":
      return lifecycleState(projection.projection.lifecycle);
    case "location":
      return lifecycleState(projection.projection.lifecycle);
    case "sales_channel":
      return lifecycleState(projection.projection.lifecycle);
    case "offer":
      return projection.projection.lifecycle.state;
    case "inventory_position":
      return null;
    case "inventory_movement":
      return null;
    case "inventory_lot":
      return lifecycleState(projection.projection.lifecycle);
    case "commerce_order":
      return projection.projection.lifecycle.state;
    case "payment":
      return projection.projection.lifecycle.state;
    case "fulfillment":
      return projection.projection.lifecycle.state;
    case "shipment":
      return projection.projection.lifecycle.state;
    case "menu":
      return lifecycleState(projection.projection.lifecycle);
    case "modifier_group_revision":
      return lifecycleState(projection.projection.lifecycle);
    case "recipe_revision":
      return lifecycleState(projection.projection.lifecycle);
    case "preparation_station":
      return projection.projection.lifecycle;
    case "preparation_ticket":
      return lifecycleState(projection.projection.lifecycle);
    case "production_batch":
      return null;
    case "stock_policy":
      return lifecycleState(projection.projection.lifecycle);
    default:
      return assertNever(projection);
  }
}

function relationshipsFromRecords(
  records: readonly BlotterRecord[],
  now: number,
): readonly CommerceRelationship[] {
  const relationships: CommerceRelationship[] = [];
  for (const record of records) {
    const projection = record.projection;
    switch (projection.kind) {
      case "sellable_variant":
        break;
      case "offer":
        break;
      case "commerce_order":
        break;
      case "payment":
        break;
      case "fulfillment":
        relationships.push(
          systemRelationship(
            "order_fulfillment",
            projection.projection.orderId,
            record.canonicalId,
            projection.projection.provenance,
            now,
          ),
        );
        break;
      case "shipment":
        relationships.push(
          systemRelationship(
            "order_shipment",
            projection.projection.orderId,
            record.canonicalId,
            projection.projection.provenance,
            now,
          ),
        );
        relationships.push(
          systemRelationship(
            "fulfillment_shipment",
            projection.projection.fulfillmentId,
            record.canonicalId,
            projection.projection.provenance,
            now,
          ),
        );
        break;
      case "production_batch":
        relationships.push(
          systemRelationship(
            "recipe_revision_production_batch",
            String(projection.projection.recipeId),
            record.canonicalId,
            projection.projection.provenance,
            now,
          ),
        );
        if (projection.projection.demand.kind === "shipment") {
          relationships.push(
            systemRelationship(
              "shipment_production_batch",
              projection.projection.demand.shipmentId,
              record.canonicalId,
              projection.projection.provenance,
              now,
            ),
          );
        }
        break;
      case "product":
      case "inventory_item":
      case "location":
      case "sales_channel":
      case "inventory_position":
      case "inventory_movement":
      case "inventory_lot":
      case "menu":
      case "modifier_group_revision":
      case "recipe_revision":
      case "preparation_station":
      case "preparation_ticket":
      case "stock_policy":
        break;
      default:
        return assertNever(projection);
    }
  }
  return relationships;
}

function systemRelationship(
  definitionId: SystemRelationshipDefinitionKind,
  sourceId: string,
  targetId: string,
  provenance: SourceProvenance,
  _now: number,
): SystemCommerceRelationship {
  const endpoints = relationshipEndpoints(definitionId);
  return {
    origin: "system",
    relationshipId: relationshipId(
      `system:${definitionId}:${sourceId}:${targetId}`,
    ),
    definition: {
      origin: "system",
      definitionId,
      revision: relationshipDefinitionRevision(1),
    },
    sensitivity: "internal",
    source: parseSystemEntityRef(endpoints.source, sourceId),
    target: parseSystemEntityRef(endpoints.target, targetId),
    revision: relationshipRevision(1),
    provenance,
  };
}

function relationshipEndpoints(
  definitionId: SystemRelationshipDefinitionKind,
): Readonly<{
  source: SystemCommerceEntityKind;
  target: SystemCommerceEntityKind;
}> {
  switch (definitionId) {
    case "order_shipment":
      return { source: "order", target: "shipment" };
    case "order_fulfillment":
      return { source: "order", target: "fulfillment" };
    case "fulfillment_shipment":
      return { source: "fulfillment", target: "shipment" };
    case "recipe_revision_production_batch":
      return { source: "recipe_revision", target: "production_batch" };
    case "production_batch_recipe_revision":
      return { source: "production_batch", target: "recipe_revision" };
    case "shipment_production_batch":
      return { source: "shipment", target: "production_batch" };
    default:
      return assertNever(definitionId);
  }
}

function freshness(record: BlotterRecord, now: number): CommerceFreshness {
  const observedAt = record.projection.projection.provenance.observedAt;
  const observedMillis = Date.parse(observedAt);
  const anchor = Number.isNaN(observedMillis)
    ? record.validatedAt
    : Math.max(observedMillis, record.validatedAt);
  if (now - anchor > COMMERCE_PROJECTION_STALE_AFTER_MS) {
    return {
      state: "stale",
      observedAt,
      staleSince: new Date(
        anchor + COMMERCE_PROJECTION_STALE_AFTER_MS,
      ).toISOString(),
    };
  }
  return { state: "current", observedAt };
}

export function projectionKindForEntityType(
  typeId: SystemCommerceEntityKind,
): CommerceProjectionKind {
  switch (typeId) {
    case "order":
      return "commerce_order";
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "location":
    case "sales_channel":
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "payment":
    case "fulfillment":
    case "shipment":
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      return typeId;
    default:
      throw new Error(`Unsupported system entity type ${typeId}`);
  }
}

function cursorOrderingValues(
  plan: CommerceQueryPlan,
  row: CommerceEntityRelationRow,
  record: BlotterRecord,
): readonly CommerceOrderingValue[] | null {
  const relationText = materializeCommerceRelationText(
    displayName(record),
    displayName(record),
  );
  if (
    !relationText.ok ||
    relationText.value.displayNameFolded !== row.display_name_folded ||
    relationText.value.searchTextFolded !== row.search_text_folded
  ) {
    return null;
  }
  const values: CommerceOrderingValue[] = [];
  for (const key of plan.effectiveOrdering.leadingKeys) {
    switch (key.field.kind) {
      case "updated_at":
        values.push({ kind: "integer", value: BigInt(row.updated_at) });
        break;
      case "display_name":
        values.push({
          kind: "text",
          value: relationText.value.displayNameFolded,
        });
        break;
      case "attribute":
      case "created_at":
        return null;
      default:
        return assertNever(key.field);
    }
  }
  return values;
}

function sourceFailure(error: unknown): {
  ok: false;
  error: CommerceGraphSourceError;
} {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "source read failed";
  return {
    ok: false,
    error: { code: "source_unavailable", source: "blotter", message: code },
  };
}

function entityKey(reference: CommerceEntityRef): string {
  return `${reference.origin}:${reference.typeId}:${reference.entityId}`;
}

function planReadFailure(
  error:
    | OrganisationStateError
    | CommerceQueryPlanReadError
    | { readonly code: "organisation_placement_conflict" },
): BlotterQueryPlanResult {
  switch (error.code) {
    case "commerce_query_plan_unsupported":
      return {
        ok: false,
        error: {
          code: "query_unsupported",
          source: "blotter",
          capability: error.capability,
        },
      };
    case "commerce_query_plan_invalid":
    case "commerce_query_relation_corrupt":
    case "organisation_placement_conflict":
    case "organisation_not_initialized":
    case "organisation_mismatch":
    case "invalid_policy_snapshot":
    case "policy_version_stale":
    case "policy_version_conflict":
      return sourceFailure(error);
    case "commerce_query_plan_stale":
      return {
        ok: false,
        error: {
          code: "query_stale",
          expected: error.expected,
          received: error.received,
        },
      };
    default:
      return assertNever(error);
  }
}

function relationshipPlanReadFailure(
  error:
    | OrganisationStateError
    | CommerceQueryPlanReadError
    | { readonly code: "organisation_placement_conflict" },
): BlotterRelationshipStepResult {
  switch (error.code) {
    case "commerce_query_plan_unsupported":
      return {
        ok: false,
        error: {
          code: "commerce_query_unsupported",
          capability: error.capability,
        },
      };
    case "commerce_query_plan_invalid":
    case "commerce_query_plan_stale":
    case "commerce_query_relation_corrupt":
    case "organisation_placement_conflict":
    case "organisation_not_initialized":
    case "organisation_mismatch":
    case "invalid_policy_snapshot":
    case "policy_version_stale":
    case "policy_version_conflict":
      return sourceFailure(error);
    default:
      return assertNever(error);
  }
}

function lifecycleState(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    typeof value.state === "string"
  ) {
    return value.state;
  }
  return "unknown";
}

function assertNormalizedText(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim())
    throw new Error(`${field} must be normalized text`);
}

function normalizedIdentifier(value: string, field: string): string {
  assertNormalizedText(value, field);
  return value;
}

function commerceEntityRevision(value: number): CommerceEntityRevision {
  return parseCommerceEntityRevision(value, "commerceEntityRevision");
}

function attributeDefinitionRevision(
  value: number,
): AttributeDefinitionRevision {
  return parseAttributeDefinitionRevision(value, "attributeDefinitionRevision");
}

function relationshipDefinitionRevision(
  value: number,
): RelationshipDefinitionRevision {
  return parseRelationshipDefinitionRevision(
    value,
    "relationshipDefinitionRevision",
  );
}

function relationshipRevision(value: number): RelationshipRevision {
  return parseRelationshipRevision(value, "relationshipRevision");
}

function systemSchemaRevision(value: number): SystemSchemaRevision {
  return parseSystemSchemaRevision(value, "systemSchemaRevision");
}

function relationshipId(value: string): RelationshipId {
  return parseRelationshipId(value, "relationshipId");
}
