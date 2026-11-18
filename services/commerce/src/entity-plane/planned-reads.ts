import type {
  AttributeDefinitionId,
  AttributeValue,
  CommerceAggregationCapability,
  CommerceCapabilityMatrix,
  CommerceCursor,
  CommerceCursorBoundary,
  CommerceCursorPayload,
  CommerceEntity,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceFilter,
  CommerceGraphQuery,
  CommerceGraphQueryPlanRequest,
  CommerceGraphQueryResult,
  CommerceListEntry,
  CommerceListEntryId,
  CommerceListId,
  CommerceMerchantId,
  CommerceQueryCapabilityProfile,
  CommerceQueryPlan,
  CommerceReadWatermark,
  CommerceRelationship,
  CommerceSavedViewCapabilitySource,
  CommerceSensitivity,
  CommerceSnapshotRevision,
  RelationshipDefinitionRef,
  OrganisationId,
} from "@seams/commerce-contracts";
import type { CommerceSqliteRelationshipTraversalPlan } from "@seams/commerce-query-sqlite";
import type {
  CommerceEntityPlaneCapabilityMetadataRequest,
  CommerceEntityPlaneCapabilityMetadataResponse,
  CommerceEntityPlanePlannedQueryResponse,
  CommerceEntityPlaneRelationshipTraversalStepRequest,
  CommerceEntityPlaneRelationshipTraversalStepResponse,
} from "@seams/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import {
  readCustomEntity,
  readMerchant,
  readSystemEntity,
  readSystemEntityExtension,
} from "./entities.ts";
import {
  readValidatedPlan as readValidatedCommercePlan,
  type CommerceEntityRelationReadResult,
} from "./commerce-entity-relation.ts";
import {
  hydrateCommerceRelationshipRelationRow,
  readRelationshipTraversalStep,
} from "./commerce-relationship-relation.ts";
import { listRelationshipDefinitions } from "./relationships.ts";
import { parseSnapshotRevision } from "./parsers.ts";
import type {
  EntityPlaneQueryRequest,
  EntityPlaneSystemExtensionRequest,
  EntityPlaneSystemExtensionResponse,
} from "./entity-types.ts";
import {
  encodeCursorWithLexicon,
  foldCommerceUnicodeV1,
  planWithLexicon,
  validateCommerceQueryPlanWithLexicon,
} from "./lexicon.ts";
import { EntityPlaneHttpError } from "./http-error.ts";
import { CommerceLists } from "./commerce-lists.ts";
import {
  customCapability,
  listCapability,
  savedViewPlanContext,
  systemCapability,
} from "./query-capabilities.ts";
import {
  relationshipDefinitionReference,
  sameRelationshipDefinitionRef,
} from "@seams/commerce-contracts/commerce-relationship-references";
import type { Variant } from "@seams/type-utils";
import { assertNever, canonicalJson, sameJson } from "@seams/std";

type EntityPlanePlannedReadsOptions = Readonly<{
  database: CommerceDatabase;
  commerceLists: CommerceLists;
}>;

export class EntityPlanePlannedReads {
  readonly #database: CommerceDatabase;
  readonly #commerceLists: CommerceLists;

  constructor(options: EntityPlanePlannedReadsOptions) {
    this.#database = options.database;
    this.#commerceLists = options.commerceLists;
  }

  readQuery(request: EntityPlaneQueryRequest): CommerceGraphQueryResult {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    const planRequest = buildNativePlanRequest(
      this.#database,
      request.merchantId,
      merchant,
      request.query,
    );
    if (planRequest === null) {
      throw plannedQueryHttpError({
        kind: "unsupported_query",
        capability: { kind: "source_mapping" },
      });
    }
    const planned = this.executePlannedQuery(planRequest);
    if (planned.kind === "planned") return planned.result;
    throw plannedQueryHttpError(planned);
  }

  readCapabilityMetadata(
    request: CommerceEntityPlaneCapabilityMetadataRequest,
  ): CommerceEntityPlaneCapabilityMetadataResponse {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    if (merchant.organisationId !== request.organisationId) {
      throw new EntityPlaneHttpError(
        403,
        "Merchant is outside the organisation authority",
        { code: "authority_out_of_scope" },
      );
    }
    const planRequest = buildNativePlanRequest(
      this.#database,
      request.merchantId,
      merchant,
      request.query,
    );
    if (planRequest === null) {
      throw new EntityPlaneHttpError(
        400,
        "Commerce query capability is unsupported",
        { code: "invalid_query" },
      );
    }
    const merchantRevision = parseSnapshotRevision<CommerceSnapshotRevision>(
      merchant.revision,
      "merchantRevision",
    );
    return {
      kind: "capability_metadata",
      organisationId: parsePositiveText<OrganisationId>(
        request.organisationId,
        "organisationId",
      ),
      merchantId: parsePositiveText<CommerceMerchantId>(
        request.merchantId,
        "merchantId",
      ),
      merchantRevision,
      watermark: { kind: "underclerk_native", merchantRevision },
      capabilities: planRequest.capabilities,
      projection: planRequest.projection,
    };
  }

  readValidatedPlan(
    ownerId: string,
    plan: CommerceQueryPlan,
  ): CommerceEntityRelationReadResult {
    return readValidatedCommercePlan(this.#database, ownerId, plan);
  }

  readValidatedRelationshipTraversalStep(
    request: CommerceEntityPlaneRelationshipTraversalStepRequest,
  ): CommerceEntityPlaneRelationshipTraversalStepResponse {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    if (merchant.organisationId !== request.organisationId) {
      throw new EntityPlaneHttpError(
        403,
        "Merchant is outside the organisation authority",
        { code: "authority_out_of_scope" },
      );
    }
    const merchantRevision = parseSnapshotRevision<CommerceSnapshotRevision>(
      merchant.revision,
      "merchantRevision",
    );
    if (
      String(request.planRequest.organisationId) !== request.organisationId ||
      String(request.planRequest.merchantId) !== request.merchantId
    ) {
      return { kind: "invalid" };
    }
    const expectedWatermark: CommerceReadWatermark =
      request.planRequest.watermark.kind === "provider_backed"
        ? {
            ...request.planRequest.watermark,
            underclerkExtensionMerchantRevision: merchantRevision,
          }
        : { kind: "underclerk_native", merchantRevision };
    if (!sameReadWatermark(request.planRequest.watermark, expectedWatermark)) {
      return {
        kind: "cursor_stale",
        expected: expectedWatermark,
        received: request.planRequest.watermark,
      };
    }
    const authoritativeRequest = buildNativePlanRequest(
      this.#database,
      request.merchantId,
      merchant,
      request.planRequest.query,
    );
    if (authoritativeRequest === null)
      return {
        kind: "unsupported_query",
        capability: { kind: "source_mapping" },
      };
    const currentRequest: CommerceGraphQueryPlanRequest = {
      ...authoritativeRequest,
      watermark: request.planRequest.watermark,
    };
    if (!planRequestWithinAuthority(request.planRequest, currentRequest))
      return { kind: "invalid" };
    const planned = planWithLexicon(request.planRequest);
    if (planned.kind === "error") return { kind: "invalid" };
    if (planned.value.kind !== "planned") return planned.value;
    const authoritativePlan = planned.value.plan;
    try {
      validateCommerceQueryPlanWithLexicon(request.plan);
    } catch {
      return { kind: "invalid" };
    }
    if (!sameJson(authoritativePlan, request.plan)) return { kind: "invalid" };
    if (!sameReadWatermark(authoritativePlan.watermark, expectedWatermark)) {
      return {
        kind: "cursor_stale",
        expected: expectedWatermark,
        received: authoritativePlan.watermark,
      };
    }
    if (
      authoritativePlan.operation.kind !== "relationship_traversal" ||
      authoritativePlan.predicate.kind !== "all"
    ) {
      return {
        kind: "unsupported_query",
        capability: { kind: "source_mapping" },
      };
    }
    if (request.remaining > Number(authoritativePlan.limit)) {
      return { kind: "invalid" };
    }
    const step = readRelationshipTraversalStep(
      this.#database,
      request.merchantId,
      relationshipTraversalPlan(authoritativePlan),
      request.frontier,
      request.remaining,
    );
    if (step.kind === "unsupported") {
      return { kind: "unsupported_query", capability: step.capability };
    }
    const entities = new Map<string, CommerceEntity>();
    const relationships = new Map<string, CommerceRelationship>();
    for (const reference of request.frontier) {
      if (
        authoritativePlan.watermark.kind === "provider_backed" &&
        reference.origin === "system"
      )
        continue;
      const entity = this.#readEntity(
        request.merchantId,
        reference,
        merchant.revision,
      );
      if (entity === undefined) return { kind: "invalid" };
      entities.set(entityKey(entity.reference), entity);
    }
    for (const row of step.rows) {
      const relationship = hydrateCommerceRelationshipRelationRow(
        this.#database,
        request.merchantId,
        row,
      );
      if (
        authoritativePlan.watermark.kind === "provider_backed" &&
        relationship.origin === "system"
      )
        continue;
      relationships.set(String(relationship.relationshipId), relationship);
      for (const reference of [relationship.source, relationship.target]) {
        if (
          authoritativePlan.watermark.kind === "provider_backed" &&
          reference.origin === "system"
        )
          continue;
        const entity = this.#readEntity(
          request.merchantId,
          reference,
          merchant.revision,
        );
        if (entity === undefined) return { kind: "invalid" };
        entities.set(entityKey(entity.reference), entity);
      }
    }
    const values = [...entities.values()];
    return {
      kind: "planned",
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      merchantRevision,
      plan: authoritativePlan,
      result: {
        merchantRevision,
        entities: values,
        relationships: [...relationships.values()],
        listEntries: [],
        aggregations: [],
        nextCursor: null,
        provenance: values
          .filter(isSystemEntity)
          .map((entity) => entity.provenance),
        freshness: values
          .filter(isSystemEntity)
          .map((entity) => entity.freshness),
      },
      hasMore: false,
    };
  }

  executePlannedQuery(
    request: CommerceGraphQueryPlanRequest,
  ): CommerceEntityPlanePlannedQueryResponse {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    if (merchant.organisationId !== request.organisationId) {
      throw new EntityPlaneHttpError(
        403,
        "Merchant is outside the organisation authority",
        { code: "authority_out_of_scope" },
      );
    }
    const merchantRevision = parseSnapshotRevision<CommerceSnapshotRevision>(
      merchant.revision,
      "merchantRevision",
    );
    const expectedWatermark: CommerceReadWatermark = {
      kind: "underclerk_native",
      merchantRevision,
    };
    if (request.watermark.kind !== "underclerk_native") {
      return {
        kind: "unsupported_query",
        capability: { kind: "source_mapping" },
      };
    }
    if (request.watermark.merchantRevision !== merchantRevision) {
      return {
        kind: "cursor_stale",
        expected: expectedWatermark,
        received: request.watermark,
      };
    }
    const authoritativeRequest = buildNativePlanRequest(
      this.#database,
      request.merchantId,
      merchant,
      request.query,
    );
    if (authoritativeRequest === null) {
      return {
        kind: "unsupported_query",
        capability: { kind: "source_mapping" },
      };
    }
    if (!planRequestWithinAuthority(request, authoritativeRequest))
      return { kind: "invalid" };
    const planned = planWithLexicon(request);
    if (planned.kind === "error") return { kind: "invalid" };
    if (planned.value.kind !== "planned") return planned.value;
    if (!sameReadWatermark(planned.value.plan.watermark, expectedWatermark)) {
      return {
        kind: "cursor_stale",
        expected: expectedWatermark,
        received: planned.value.plan.watermark,
      };
    }
    if (planned.value.plan.operation.kind === "relationship_traversal") {
      if (planned.value.plan.predicate.kind !== "all") {
        return {
          kind: "unsupported_query",
          capability: { kind: "source_mapping" },
        };
      }
      const result = this.#traversePlanned(
        request.merchantId,
        relationshipTraversalPlan(planned.value.plan),
        merchantRevision,
        null,
      );
      return {
        kind: "planned",
        organisationId: request.organisationId,
        merchantId: request.merchantId,
        merchantRevision,
        plan: planned.value.plan,
        result: {
          merchantRevision,
          entities: [...result.entities],
          relationships: [...result.relationships],
          listEntries: [],
          aggregations: [],
          nextCursor: null,
          provenance: result.entities
            .filter(isSystemEntity)
            .map((entity) => entity.provenance),
          freshness: result.entities
            .filter(isSystemEntity)
            .map((entity) => entity.freshness),
        },
        hasMore: false,
      };
    }
    if (
      planned.value.plan.operation.kind === "underclerk_context" &&
      request.query.kind === "underclerk_context"
    ) {
      const selected: CommerceGraphQuery =
        request.query.selection.kind === "selector"
          ? request.query.selection.selector.query
          : {
              kind: "relationship_traversal",
              seeds: request.query.selection.seeds,
              relationshipDefinition: null,
              traversal: {
                maxDepth: 0,
                resultLimit: request.query.traversal.resultLimit,
              },
              filter: null,
            };
      const selectedRequest = buildNativePlanRequest(
        this.#database,
        request.merchantId,
        merchant,
        selected,
      );
      if (selectedRequest === null)
        return {
          kind: "unsupported_query",
          capability: { kind: "source_mapping" },
        };
      const selectedResult = this.executePlannedQuery(selectedRequest);
      if (selectedResult.kind !== "planned") return selectedResult;
      const selectedListEntries = selectedResult.result.listEntries.map(
        (entry) => {
          const stored = this.#commerceLists.readEntry(
            request.merchantId,
            entry.entryId,
          );
          if (
            stored === undefined ||
            stored.lifecycleState !== "active" ||
            stored.revision !== Number(entry.revision)
          ) {
            throw new Error(
              "Saved selector references a stale Commerce List entry",
            );
          }
          return this.#commerceLists.hydrateEntry(request.merchantId, stored);
        },
      );
      const primary: QueryParts = {
        entities: selectedResult.result.entities,
        relationships: selectedResult.result.relationships,
        listEntries: selectedListEntries,
        aggregations: selectedResult.result.aggregations,
        nextCursor: null,
      };
      const seeds =
        primary.listEntries.length > 0
          ? primary.listEntries.map((entry) => entry.entityRef)
          : primary.entities.map((entity) => entity.reference);
      const traversed =
        planned.value.plan.operation.traversal.maxDepth === 0
          ? emptyQueryParts()
          : this.#traverse(
              request.merchantId,
              seeds,
              null,
              planned.value.plan.operation.traversal.maxDepth,
              planned.value.plan.operation.traversal.resultLimit,
              merchantRevision,
              null,
            );
      const projected = projectContextRelationships(
        mergeQueryParts(primary, traversed),
        planned.value.plan.projection.relationshipDefinitions,
      );
      const result = filterContextResult(projected, request.query);
      return {
        kind: "planned",
        organisationId: request.organisationId,
        merchantId: request.merchantId,
        merchantRevision,
        plan: planned.value.plan,
        result: {
          merchantRevision,
          entities: [...result.entities],
          relationships: [...result.relationships],
          listEntries: [...result.listEntries],
          aggregations: [...result.aggregations],
          nextCursor: selectedResult.result.nextCursor,
          provenance: result.entities
            .filter(isSystemEntity)
            .map((entity) => entity.provenance),
          freshness: result.entities
            .filter(isSystemEntity)
            .map((entity) => entity.freshness),
        },
        hasMore: selectedResult.hasMore,
      };
    }
    if (
      planned.value.plan.operation.kind === "entity_by_ref" &&
      planned.value.plan.operation.traversal.maxDepth > 0
    ) {
      const seedRead = this.readValidatedPlan(
        request.merchantId,
        planned.value.plan,
      );
      if (seedRead.kind === "unsupported")
        return { kind: "unsupported_query", capability: seedRead.capability };
      if (seedRead.kind !== "rows") return { kind: "invalid" };
      const graph =
        seedRead.rows.length === 0
          ? {
              entities: [],
              relationships: [],
              listEntries: [],
              aggregations: [],
              nextCursor: null,
            }
          : this.#traverse(
              request.merchantId,
              [planned.value.plan.operation.reference],
              null,
              planned.value.plan.operation.traversal.maxDepth,
              planned.value.plan.operation.traversal.resultLimit,
              merchantRevision,
              null,
            );
      return {
        kind: "planned",
        organisationId: request.organisationId,
        merchantId: request.merchantId,
        merchantRevision,
        plan: planned.value.plan,
        result: {
          merchantRevision,
          entities: [...graph.entities],
          relationships: [...graph.relationships],
          listEntries: [],
          aggregations: [],
          nextCursor: null,
          provenance: graph.entities
            .filter(isSystemEntity)
            .map((entity) => entity.provenance),
          freshness: graph.entities
            .filter(isSystemEntity)
            .map((entity) => entity.freshness),
        },
        hasMore: false,
      };
    }
    if (
      planned.value.plan.operation.kind === "entity_type_page" &&
      planned.value.plan.operation.traversal.maxDepth > 0
    ) {
      const selectedRead = this.readValidatedPlan(
        request.merchantId,
        planned.value.plan,
      );
      if (selectedRead.kind === "unsupported")
        return {
          kind: "unsupported_query",
          capability: selectedRead.capability,
        };
      if (selectedRead.kind !== "rows") return { kind: "invalid" };
      const selectedEntities = selectedRead.rows.map((row) =>
        hydrateRelationRow(
          this.#database,
          request.merchantId,
          row,
          merchant.revision,
        ),
      );
      const traversed = this.#traverse(
        request.merchantId,
        selectedEntities.map((entity) => entity.reference),
        null,
        planned.value.plan.operation.traversal.maxDepth,
        planned.value.plan.operation.traversal.resultLimit,
        merchantRevision,
        null,
      );
      const merged = mergeQueryParts(
        {
          entities: selectedEntities,
          relationships: [],
          listEntries: [],
          aggregations: [],
          nextCursor: null,
        },
        traversed,
      );
      const nextCursor =
        selectedRead.execution.kind === "page" && selectedRead.execution.hasMore
          ? this.#encodeNextCursor(
              request,
              planned.value.plan,
              selectedRead.execution.nextBoundary,
            )
          : null;
      return {
        kind: "planned",
        organisationId: request.organisationId,
        merchantId: request.merchantId,
        merchantRevision,
        plan: planned.value.plan,
        result: {
          merchantRevision,
          entities: [...merged.entities],
          relationships: [...merged.relationships],
          listEntries: [],
          aggregations: [],
          nextCursor,
          provenance: merged.entities
            .filter(isSystemEntity)
            .map((entity) => entity.provenance),
          freshness: merged.entities
            .filter(isSystemEntity)
            .map((entity) => entity.freshness),
        },
        hasMore:
          selectedRead.execution.kind === "page" &&
          selectedRead.execution.hasMore,
      };
    }
    const read = this.readValidatedPlan(request.merchantId, planned.value.plan);
    if (read.kind === "unsupported")
      return { kind: "unsupported_query", capability: read.capability };
    if (read.kind === "count") {
      return {
        kind: "planned",
        organisationId: request.organisationId,
        merchantId: request.merchantId,
        merchantRevision,
        plan: planned.value.plan,
        result: {
          merchantRevision,
          entities: [],
          relationships: [],
          listEntries: [],
          aggregations: [{ kind: "count", value: BigInt(read.value) }],
          nextCursor: null,
          provenance: [],
          freshness: [],
        },
        hasMore: false,
      };
    }
    if (read.kind === "list_rows") {
      const listEntries = read.rows.map((row) => {
        const stored = this.#commerceLists.readEntry(
          request.merchantId,
          parsePositiveText<CommerceListEntryId>(
            row.entryId,
            "listEntry.entryId",
          ),
        );
        if (
          stored === undefined ||
          stored.lifecycleState !== "active" ||
          stored.listId !== row.listId ||
          stored.revision !== row.entryRevision ||
          stored.entityOrigin !== row.entityOrigin ||
          stored.entityTypeId !== row.entityType ||
          stored.entityId !== row.entityId
        ) {
          throw new Error(
            "Commerce List relation row does not match its canonical entry",
          );
        }
        return this.#commerceLists.hydrateEntry(request.merchantId, stored);
      });
      const entities = read.rows.map((row) => {
        const entity = this.#readEntity(
          request.merchantId,
          row.reference,
          merchant.revision,
        );
        if (entity === undefined)
          throw new Error("Commerce List relation references a missing entity");
        return entity;
      });
      const projected =
        planned.value.plan.operation.kind === "saved_commerce_view"
          ? projectSavedViewAttributes(
              {
                entities,
                relationships: [],
                listEntries,
                aggregations: [],
                nextCursor: null,
              },
              planned.value.plan.projection.attributeIds,
            )
          : {
              entities,
              relationships: [],
              listEntries,
              aggregations: [],
              nextCursor: null,
            };
      const nextCursor = read.execution.hasMore
        ? this.#encodeNextCursor(
            request,
            planned.value.plan,
            read.execution.nextBoundary,
          )
        : null;
      return {
        kind: "planned",
        organisationId: request.organisationId,
        merchantId: request.merchantId,
        merchantRevision,
        plan: planned.value.plan,
        result: {
          merchantRevision,
          entities: [...projected.entities],
          relationships: [],
          listEntries: [...projected.listEntries],
          aggregations: [],
          nextCursor,
          provenance: projected.entities
            .filter(isSystemEntity)
            .map((entity) => entity.provenance),
          freshness: projected.entities
            .filter(isSystemEntity)
            .map((entity) => entity.freshness),
        },
        hasMore: read.execution.hasMore,
      };
    }
    const hydratedEntities = read.rows.map((row) =>
      hydrateRelationRow(
        this.#database,
        request.merchantId,
        row,
        merchant.revision,
      ),
    );
    const entities =
      planned.value.plan.operation.kind === "saved_commerce_view"
        ? projectSavedViewAttributes(
            {
              entities: hydratedEntities,
              relationships: [],
              listEntries: [],
              aggregations: [],
              nextCursor: null,
            },
            planned.value.plan.projection.attributeIds,
          ).entities
        : hydratedEntities;
    const result: CommerceGraphQueryResult = {
      merchantRevision,
      entities: [...entities],
      relationships: [],
      listEntries: [],
      aggregations: [],
      nextCursor: null,
      provenance: entities
        .filter(isSystemEntity)
        .map((entity) => entity.provenance),
      freshness: entities
        .filter(isSystemEntity)
        .map((entity) => entity.freshness),
    };
    const nextCursor =
      read.execution.kind === "page" && read.execution.hasMore
        ? this.#encodeNextCursor(
            request,
            planned.value.plan,
            read.execution.nextBoundary,
          )
        : null;
    return {
      kind: "planned",
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      merchantRevision,
      plan: planned.value.plan,
      result: { ...result, nextCursor },
      hasMore: read.execution.kind === "page" && read.execution.hasMore,
    };
  }

  #encodeNextCursor(
    request: CommerceGraphQueryPlanRequest,
    plan: CommerceQueryPlan,
    boundary: CommerceCursorBoundary | null,
  ): CommerceCursor {
    if (boundary === null)
      throw new EntityPlaneHttpError(
        500,
        "Page execution did not produce a cursor boundary",
      );
    const payload: CommerceCursorPayload = {
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      queryFingerprint: plan.queryFingerprint,
      semanticsVersion: plan.semanticsVersion,
      orderingVersion: plan.orderingVersion,
      effectiveOrdering: plan.effectiveOrdering,
      boundary,
      watermark: plan.watermark,
    };
    const encoded = encodeCursorWithLexicon(payload);
    if (encoded.kind === "error")
      throw new EntityPlaneHttpError(500, "Lexicon cursor encoding failed");
    return encoded.value;
  }

  readSystemExtensionSidecars(
    request: EntityPlaneSystemExtensionRequest,
  ): EntityPlaneSystemExtensionResponse {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    if (merchant.organisationId !== request.organisationId)
      throw new EntityPlaneHttpError(
        403,
        "Merchant is outside the organisation authority",
        { code: "authority_out_of_scope" },
      );
    return {
      merchantId: request.merchantId,
      merchantRevision: parseSnapshotRevision<CommerceSnapshotRevision>(
        merchant.revision,
        "merchantRevision",
      ),
      sidecars: request.entityRefs.map((entityRef) => ({
        entityRef,
        ...readSystemEntityExtension(
          this.#database,
          request.merchantId,
          entityRef,
        ),
      })),
    };
  }

  #readEntity(
    merchantId: string,
    reference: CommerceEntityRef,
    merchantRevision: number,
  ): CommerceEntity | undefined {
    return reference.origin === "system"
      ? readSystemEntity(
          this.#database,
          merchantId,
          reference,
          merchantRevision,
        )
      : readCustomEntity(
          this.#database,
          merchantId,
          reference,
          merchantRevision,
        );
  }

  #traverse(
    merchantId: string,
    seeds: readonly CommerceEntityRef[],
    definition: RelationshipDefinitionRef | null,
    maxDepth: number,
    resultLimit: number,
    merchantRevision: number,
    filter: CommerceFilter | null,
  ): QueryParts {
    const merchant = readMerchant(this.#database, merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    const request = buildNativePlanRequest(
      this.#database,
      merchantId,
      merchant,
      {
        kind: "relationship_traversal",
        seeds: [...seeds],
        relationshipDefinition: definition,
        traversal: { maxDepth, resultLimit },
        filter,
      },
    );
    if (request === null)
      unsupportedQuery(
        "Relationship traversal seeds must share one published source mapping",
      );
    const planned = planWithLexicon(request);
    if (planned.kind === "error" || planned.value.kind !== "planned") {
      unsupportedQuery("Lexicon rejected the relationship traversal plan");
    }
    if (
      planned.value.plan.operation.kind !== "relationship_traversal" ||
      planned.value.plan.predicate.kind !== "all"
    ) {
      unsupportedQuery(
        "Relationship traversal filters are not supported by the normalized relation",
      );
    }
    return this.#traversePlanned(
      merchantId,
      relationshipTraversalPlan(planned.value.plan),
      merchantRevision,
      filter,
    );
  }

  #traversePlanned(
    merchantId: string,
    plan: CommerceSqliteRelationshipTraversalPlan,
    merchantRevision: number,
    filter: CommerceFilter | null,
  ): QueryParts {
    const entities = new Map<string, CommerceEntity>();
    const relationships = new Map<string, CommerceRelationship>();
    let frontier: CommerceEntityRef[] = [];
    for (const seed of plan.operation.seeds) {
      if (entities.size >= Number(plan.limit)) break;
      const entity = this.#readEntity(merchantId, seed, merchantRevision);
      if (entity === undefined || !matchesFilter(entity, filter)) continue;
      const key = entityKey(entity.reference);
      if (entities.has(key)) continue;
      entities.set(key, entity);
      frontier.push(entity.reference);
    }
    let depth = 0;
    while (
      depth < plan.operation.traversal.maxDepth &&
      frontier.length > 0 &&
      entities.size < Number(plan.limit)
    ) {
      const remaining = Number(plan.limit) - entities.size;
      const step = readRelationshipTraversalStep(
        this.#database,
        merchantId,
        plan,
        frontier,
        remaining,
      );
      if (step.kind === "unsupported")
        unsupportedQuery(
          `Relationship traversal is unsupported: ${step.capability.kind}`,
        );
      const nextFrontier: CommerceEntityRef[] = [];
      const nextKeys = new Set<string>();
      for (const row of step.rows) {
        const relationship = hydrateCommerceRelationshipRelationRow(
          this.#database,
          merchantId,
          row,
        );
        relationships.set(String(relationshipIdOf(relationship)), relationship);
        const next = nextReferenceFromFrontier(relationship, frontier);
        if (next === undefined || entities.has(entityKey(next))) continue;
        const entity = this.#readEntity(merchantId, next, merchantRevision);
        if (entity === undefined || !matchesFilter(entity, filter)) continue;
        const key = entityKey(entity.reference);
        if (entities.has(key)) continue;
        entities.set(key, entity);
        if (depth + 1 < plan.operation.traversal.maxDepth && nextKeys.add(key))
          nextFrontier.push(entity.reference);
      }
      frontier = nextFrontier;
      depth += 1;
    }
    return {
      entities: [...entities.values()],
      relationships: [...relationships.values()],
      listEntries: [],
      aggregations: [],
      nextCursor: null,
    };
  }
}

type QueryParts = Readonly<{
  entities: readonly CommerceEntity[];
  relationships: readonly CommerceRelationship[];
  listEntries: readonly CommerceListEntry[];
  aggregations: readonly CommerceGraphQueryResult["aggregations"][number][];
  nextCursor: CommerceCursor | null;
}>;

function emptyQueryParts(): QueryParts {
  return {
    entities: [],
    relationships: [],
    listEntries: [],
    aggregations: [],
    nextCursor: null,
  };
}

function relationshipTraversalPlan(
  plan: CommerceQueryPlan,
): CommerceSqliteRelationshipTraversalPlan {
  if (plan.operation.kind !== "relationship_traversal")
    throw new Error("Relationship traversal plan operation is required");
  return {
    operation: plan.operation,
    queryFingerprint: plan.queryFingerprint,
    semanticsVersion: plan.semanticsVersion,
    orderingVersion: plan.orderingVersion,
    watermark: plan.watermark,
    effectiveOrdering: plan.effectiveOrdering,
    predicate: plan.predicate,
    projection: plan.projection,
    limit: plan.limit,
    boundary: plan.boundary,
  };
}

function projectSavedViewAttributes(
  parts: QueryParts,
  visibleAttributeIds: readonly string[],
): QueryParts {
  if (visibleAttributeIds.length === 0) return parts;
  const allowed = new Set(visibleAttributeIds);
  return {
    ...parts,
    entities: parts.entities.map((entity) => ({
      ...entity,
      attributes: entity.attributes.filter((attribute) =>
        allowed.has(attribute.attributeId),
      ),
    })),
    listEntries: parts.listEntries.map((entry) => ({
      ...entry,
      attributeValues: entry.attributeValues.filter((attribute) =>
        allowed.has(attribute.attributeId),
      ),
    })),
  };
}

function mergeQueryParts(
  primary: QueryParts,
  secondary: QueryParts,
): QueryParts {
  const entities = new Map(
    primary.entities.map((entity) => [entityKey(entity.reference), entity]),
  );
  for (const entity of secondary.entities)
    entities.set(entityKey(entity.reference), entity);
  const relationships = new Map(
    primary.relationships.map((relationship) => [
      relationshipIdOf(relationship),
      relationship,
    ]),
  );
  for (const relationship of secondary.relationships) {
    relationships.set(relationshipIdOf(relationship), relationship);
  }
  const listEntries = new Map(
    primary.listEntries.map((entry) => [
      `${entry.listId}:${entry.entryId}`,
      entry,
    ]),
  );
  for (const entry of secondary.listEntries) {
    listEntries.set(`${entry.listId}:${entry.entryId}`, entry);
  }
  return {
    entities: [...entities.values()],
    relationships: [...relationships.values()],
    listEntries: [...listEntries.values()],
    aggregations: [...primary.aggregations, ...secondary.aggregations],
    nextCursor: null,
  };
}

function projectContextRelationships(
  parts: QueryParts,
  definitions: readonly RelationshipDefinitionRef[],
): QueryParts {
  if (definitions.length === 0) return parts;
  const permitted = new Set(definitions.map(relationshipDefinitionKey));
  const relationships = parts.relationships.filter((relationship) =>
    permitted.has(relationshipDefinitionKey(relationship.definition)),
  );
  const retainedEntities = new Set(
    parts.listEntries.map((entry) => entityKey(entry.entityRef)),
  );
  for (const relationship of relationships) {
    retainedEntities.add(entityKey(relationship.source));
    retainedEntities.add(entityKey(relationship.target));
  }
  return {
    ...parts,
    entities: parts.entities.filter((entity) =>
      retainedEntities.has(entityKey(entity.reference)),
    ),
    relationships,
  };
}

function relationshipDefinitionKey(
  definition: RelationshipDefinitionRef,
): string {
  return `${definition.origin}:${definition.definitionId}:${definition.revision}`;
}

function filterContextResult(
  parts: QueryParts,
  query: Variant<CommerceGraphQuery, "underclerk_context">,
): QueryParts {
  const allowedAttributeIds = new Set(query.allowedAttributeIds.map(String));
  const entities = parts.entities
    .filter((entity) =>
      entityVisibleAtSensitivity(entity, query.allowedSensitivity),
    )
    .map((entity) => ({
      ...entity,
      attributes: entity.attributes.filter(
        (attribute) =>
          allowedAttributeIds.has(String(attribute.attributeId)) &&
          sensitivityAtMost(attribute.sensitivity, query.allowedSensitivity),
      ),
    }));
  const visibleEntities = new Set(
    entities.map((entity) => entityKey(entity.reference)),
  );
  const relationships = parts.relationships.filter(
    (relationship) =>
      sensitivityAtMost(relationship.sensitivity, query.allowedSensitivity) &&
      visibleEntities.has(entityKey(relationship.source)) &&
      visibleEntities.has(entityKey(relationship.target)),
  );
  const listEntries = parts.listEntries
    .filter((entry) => visibleEntities.has(entityKey(entry.entityRef)))
    .map((entry) => ({
      ...entry,
      attributeValues: entry.attributeValues.filter(
        (attribute) =>
          allowedAttributeIds.has(String(attribute.attributeId)) &&
          sensitivityAtMost(attribute.sensitivity, query.allowedSensitivity),
      ),
    }));
  return { ...parts, entities, relationships, listEntries, nextCursor: null };
}

function entityVisibleAtSensitivity(
  entity: CommerceEntity,
  ceiling: CommerceSensitivity,
): boolean {
  if (!("sensitivity" in entity) || entity.sensitivity === undefined)
    return true;
  return sensitivityAtMost(entity.sensitivity, ceiling);
}

function sensitivityAtMost(
  value: CommerceSensitivity,
  ceiling: CommerceSensitivity,
): boolean {
  const order: Readonly<Record<CommerceSensitivity, number>> = {
    public: 0,
    internal: 1,
    confidential: 2,
    restricted: 3,
  };
  return order[value] <= order[ceiling];
}

function unsupportedQuery(message: string): never {
  throw new EntityPlaneHttpError(400, message, { code: "invalid_query" });
}

function matchesFilter(
  entity: CommerceEntity,
  filter: CommerceFilter | null,
): boolean {
  if (filter === null) return true;
  switch (filter.kind) {
    case "all":
      return true;
    case "entity":
      return entityKey(entity.reference) === entityKey(filter.reference);
    case "search": {
      const entityText = foldCommerceUnicodeV1(entityDisplayName(entity));
      const filterText = foldCommerceUnicodeV1(filter.text);
      return (
        entityText.kind === "ok" &&
        filterText.kind === "ok" &&
        entityText.value.includes(filterText.value)
      );
    }
    case "any":
      return filter.filters.some((child) => matchesFilter(entity, child));
    case "not":
      return !matchesFilter(entity, filter.filter);
    case "attribute":
      return matchesAttributeFilter(entity, filter.filter);
    case "relationship":
      return true;
  }
}

function matchesAttributeFilter(
  entity: CommerceEntity,
  filter: Variant<CommerceFilter, "attribute">["filter"],
): boolean {
  const assignment = entity.attributes.find(
    (entry) => entry.attributeId === filter.attributeId,
  );
  switch (filter.operator) {
    case "is_empty":
      return assignment === undefined;
    case "is_not_empty":
      return assignment !== undefined;
    case "equals":
      return (
        assignment !== undefined &&
        filter.value !== null &&
        sameAttributeValue(assignment.value, filter.value)
      );
    case "not_equals":
      return (
        assignment === undefined ||
        filter.value === null ||
        !sameAttributeValue(assignment.value, filter.value)
      );
    default:
      return false;
  }
}

function sameAttributeValue(
  left: AttributeValue,
  right: AttributeValue,
): boolean {
  return (
    left.kind === right.kind && canonicalJson(left) === canonicalJson(right)
  );
}

function planRequestWithinAuthority(
  request: CommerceGraphQueryPlanRequest,
  authoritative: CommerceGraphQueryPlanRequest,
): boolean {
  const requestWithAuthoritativeCapabilities: CommerceGraphQueryPlanRequest = {
    ...request,
    capabilities: authoritative.capabilities,
  };
  return (
    sameJson(requestWithAuthoritativeCapabilities, authoritative) &&
    capabilityProfileWithinAuthority(
      request.capabilities,
      authoritative.capabilities,
    )
  );
}

function capabilityProfileWithinAuthority(
  requested: CommerceQueryCapabilityProfile,
  authoritative: CommerceQueryCapabilityProfile,
): boolean {
  switch (requested.kind) {
    case "system_mapped":
      return (
        authoritative.kind === "system_mapped" &&
        requested.systemEntityKind === authoritative.systemEntityKind &&
        Number(requested.systemSchemaRevision) ===
          Number(authoritative.systemSchemaRevision) &&
        capabilityMatrixWithinAuthority(
          requested.capability,
          authoritative.capability,
        )
      );
    case "underclerk_custom":
      return (
        authoritative.kind === "underclerk_custom" &&
        requested.entityTypeId === authoritative.entityTypeId &&
        Number(requested.publishedRevision) ===
          Number(authoritative.publishedRevision) &&
        capabilityMatrixWithinAuthority(
          requested.capability,
          authoritative.capability,
        )
      );
    case "commerce_list":
      return (
        authoritative.kind === "commerce_list" &&
        requested.listId === authoritative.listId &&
        Number(requested.listRevision) === Number(authoritative.listRevision) &&
        capabilityMatrixWithinAuthority(
          requested.capability,
          authoritative.capability,
        )
      );
    case "saved_commerce_view":
      return (
        authoritative.kind === "saved_commerce_view" &&
        requested.viewId === authoritative.viewId &&
        Number(requested.viewRevision) === Number(authoritative.viewRevision) &&
        sameJson(requested.filter, authoritative.filter) &&
        sameJson(requested.sorts, authoritative.sorts) &&
        savedViewSourceWithinAuthority(requested.source, authoritative.source)
      );
    default:
      return assertNever(requested, "entity_plane_unhandled_query_plan");
  }
}

function savedViewSourceWithinAuthority(
  requested: CommerceSavedViewCapabilitySource,
  authoritative: CommerceSavedViewCapabilitySource,
): boolean {
  switch (requested.kind) {
    case "system_mapped":
      return (
        authoritative.kind === "system_mapped" &&
        requested.systemEntityKind === authoritative.systemEntityKind &&
        Number(requested.systemSchemaRevision) ===
          Number(authoritative.systemSchemaRevision) &&
        capabilityMatrixWithinAuthority(
          requested.capability,
          authoritative.capability,
        )
      );
    case "underclerk_custom":
      return (
        authoritative.kind === "underclerk_custom" &&
        requested.entityTypeId === authoritative.entityTypeId &&
        Number(requested.publishedRevision) ===
          Number(authoritative.publishedRevision) &&
        capabilityMatrixWithinAuthority(
          requested.capability,
          authoritative.capability,
        )
      );
    case "commerce_list":
      return (
        authoritative.kind === "commerce_list" &&
        requested.listId === authoritative.listId &&
        Number(requested.listRevision) === Number(authoritative.listRevision) &&
        capabilityMatrixWithinAuthority(
          requested.capability,
          authoritative.capability,
        )
      );
    default:
      return assertNever(requested, "entity_plane_unhandled_query_plan");
  }
}

function capabilityMatrixWithinAuthority(
  requested: CommerceCapabilityMatrix,
  authoritative: CommerceCapabilityMatrix,
): boolean {
  return (
    capabilityIdsWithinAuthority(
      requested.filterableAttributeIds,
      authoritative.filterableAttributeIds,
    ) &&
    capabilityIdsWithinAuthority(
      requested.sortableAttributeIds,
      authoritative.sortableAttributeIds,
    ) &&
    aggregationCapabilityWithinAuthority(
      requested.aggregation,
      authoritative.aggregation,
    )
  );
}

function capabilityIdsWithinAuthority(
  requested: readonly AttributeDefinitionId[],
  authoritative: readonly AttributeDefinitionId[],
): boolean {
  const available = new Set<string>();
  for (const attributeId of authoritative) available.add(String(attributeId));
  for (const attributeId of requested)
    if (!available.has(String(attributeId))) return false;
  return true;
}

function aggregationCapabilityWithinAuthority(
  requested: CommerceAggregationCapability,
  authoritative: CommerceAggregationCapability,
): boolean {
  if (requested.kind === "count_only") return true;
  if (authoritative.kind !== "count_and_attributes") return false;
  return (
    capabilityIdsWithinAuthority(
      requested.groupedCountAttributeIds,
      authoritative.groupedCountAttributeIds,
    ) &&
    capabilityIdsWithinAuthority(
      requested.sumAttributeIds,
      authoritative.sumAttributeIds,
    ) &&
    capabilityIdsWithinAuthority(
      requested.minimumAttributeIds,
      authoritative.minimumAttributeIds,
    ) &&
    capabilityIdsWithinAuthority(
      requested.maximumAttributeIds,
      authoritative.maximumAttributeIds,
    ) &&
    capabilityIdsWithinAuthority(
      requested.oldestDueDateAttributeIds,
      authoritative.oldestDueDateAttributeIds,
    ) &&
    capabilityIdsWithinAuthority(
      requested.ageBucketAttributeIds,
      authoritative.ageBucketAttributeIds,
    )
  );
}

function entityDisplayName(entity: CommerceEntity): string {
  return entity.displayName;
}

function isSystemEntity(
  entity: CommerceEntity,
): entity is Extract<CommerceEntity, { reference: { origin: "system" } }> {
  return entity.reference.origin === "system";
}

function sameReadWatermark(
  left: CommerceReadWatermark,
  right: CommerceReadWatermark,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "underclerk_native" && right.kind === "underclerk_native"
    ? left.merchantRevision === right.merchantRevision
    : left.kind === "provider_backed" &&
        right.kind === "provider_backed" &&
        left.blotterAcceptedProjectionSequence ===
          right.blotterAcceptedProjectionSequence &&
        left.underclerkExtensionMerchantRevision ===
          right.underclerkExtensionMerchantRevision;
}

function hydrateEntity(
  database: CommerceDatabase,
  merchantId: string,
  reference: CommerceEntityRef,
  merchantRevision: number,
): CommerceEntity {
  const entity =
    reference.origin === "system"
      ? readSystemEntity(database, merchantId, reference, merchantRevision)
      : readCustomEntity(database, merchantId, reference, merchantRevision);
  if (entity === undefined)
    throw new EntityPlaneHttpError(
      500,
      "Validated relation row could not be hydrated",
    );
  return entity;
}

function hydrateRelationRow(
  database: CommerceDatabase,
  merchantId: string,
  row: import("./commerce-entity-relation.ts").CommerceEntityRelationRow,
  merchantRevision: number,
): CommerceEntity {
  const entity = hydrateEntity(
    database,
    merchantId,
    row.reference,
    merchantRevision,
  );
  if (
    Number(entity.revision) !== row.revision ||
    entity.displayName !== row.displayName
  ) {
    throw new EntityPlaneHttpError(
      500,
      "Commerce relation row does not match exact hydration",
    );
  }
  if (
    isSystemEntity(entity) &&
    Date.parse(entity.provenance.occurredAt) !== row.updatedAt
  ) {
    throw new EntityPlaneHttpError(
      500,
      "Commerce relation timestamp does not match exact hydration",
    );
  }
  return entity;
}

function entityKey(reference: CommerceEntityRef): string {
  return `${reference.origin}:${reference.typeId}:${reference.entityId}`;
}

function nextReferenceFromFrontier(
  relationship: CommerceRelationship,
  frontier: readonly CommerceEntityRef[],
): CommerceEntityRef | undefined {
  const sourceInFrontier = frontier.some((reference) =>
    sameRef(reference, relationship.source),
  );
  const targetInFrontier = frontier.some((reference) =>
    sameRef(reference, relationship.target),
  );
  if (sourceInFrontier && !targetInFrontier) return relationship.target;
  if (targetInFrontier && !sourceInFrontier) return relationship.source;
  return undefined;
}

function relationshipIdOf(relationship: CommerceRelationship): string {
  return relationship.relationshipId;
}

function sameRef(left: CommerceEntityRef, right: CommerceEntityRef): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function parsePositiveText<T extends string>(value: unknown, field: string): T {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim())
    throw new Error(`${field} must be normalized text`);
  if (!isPositiveText<T>(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}

function isPositiveText<T extends string>(value: string): value is T {
  return value.length > 0 && value === value.trim();
}

function buildNativePlanRequest(
  database: CommerceDatabase,
  merchantId: string,
  merchant: Readonly<{ organisationId: string; revision: number }>,
  query: CommerceGraphQuery,
): CommerceGraphQueryPlanRequest | null {
  const planningQuery = query;
  const entityTypeId = sharedPlanEntityType(planningQuery);
  const listId = sharedPlanListId(planningQuery);
  const relationshipCapability =
    planningQuery.kind === "relationship_traversal"
      ? relationshipTraversalCapability(
          database,
          merchantId,
          planningQuery.seeds,
          planningQuery.relationshipDefinition,
        )
      : null;
  const savedView =
    planningQuery.kind === "saved_commerce_view"
      ? savedViewPlanContext(database, merchantId, planningQuery.viewId)
      : null;
  const contextSavedView =
    planningQuery.kind === "underclerk_context" &&
    planningQuery.selection.kind === "selector" &&
    planningQuery.selection.selector.query.kind === "saved_commerce_view"
      ? savedViewPlanContext(
          database,
          merchantId,
          planningQuery.selection.selector.query.viewId,
        )
      : null;
  const contextCapability =
    planningQuery.kind === "underclerk_context"
      ? (contextSavedView?.capability ??
        contextPlanCapability(database, merchantId, planningQuery))
      : null;
  if (
    entityTypeId === null &&
    listId === null &&
    relationshipCapability === null &&
    savedView === null &&
    contextCapability === null
  )
    return null;
  const capability =
    savedView !== null
      ? savedView.capability
      : contextCapability !== null
        ? contextCapability
        : relationshipCapability !== null
          ? relationshipCapability
          : entityTypeId === null
            ? listCapability(database, merchantId, listId)
            : entityTypeId.origin === "system"
              ? systemCapability(database, merchantId, entityTypeId.typeId)
              : customCapability(database, merchantId, entityTypeId.typeId);
  if (capability === null) return null;
  return {
    query: planningQuery,
    semantics: {
      semanticsVersion: "v1",
      orderingVersion: "v1",
      textNormalization: "commerce_unicode_v1",
      nullPlacement: "last",
    },
    projection: {
      attributeIds:
        savedView?.visibleAttributeIds ??
        (planningQuery.kind === "underclerk_context"
          ? planningQuery.allowedAttributeIds
          : []),
      relationshipDefinitions:
        contextSavedView?.relationshipDefinitions ??
        (planningQuery.kind === "relationship_traversal" &&
        planningQuery.relationshipDefinition !== null
          ? [planningQuery.relationshipDefinition]
          : []),
      includeProvenance: true,
      includeFreshness: true,
    },
    organisationId: parsePositiveText<OrganisationId>(
      merchant.organisationId,
      "organisationId",
    ),
    merchantId: parsePositiveText<CommerceMerchantId>(merchantId, "merchantId"),
    watermark: {
      kind: "underclerk_native",
      merchantRevision: parseSnapshotRevision<CommerceSnapshotRevision>(
        merchant.revision,
        "merchantRevision",
      ),
    },
    capabilities: capability,
  };
}

function relationshipTraversalCapability(
  database: CommerceDatabase,
  merchantId: string,
  seeds: readonly CommerceEntityRef[],
  relationshipDefinition: RelationshipDefinitionRef | null = null,
) {
  const first = seeds[0];
  if (
    first === undefined ||
    seeds.some(
      (seed) => seed.origin !== first.origin || seed.typeId !== first.typeId,
    )
  )
    return null;
  if (relationshipDefinition !== null) {
    const current = listRelationshipDefinitions(database, merchantId).find(
      (definition) =>
        sameRelationshipDefinitionRef(
          relationshipDefinitionReference(definition),
          relationshipDefinition,
        ),
    );
    if (current === undefined) return null;
  }
  if (first.origin === "system") {
    return systemCapability(database, merchantId, first.typeId);
  }
  return customCapability(database, merchantId, first.typeId);
}

function sharedPlanEntityType(
  query: CommerceGraphQuery,
): CommerceEntityTypeId | null {
  switch (query.kind) {
    case "entity_by_ref":
      return query.filter === null || query.filter.kind === "all"
        ? entityTypeForReference(query.reference)
        : null;
    case "entity_type_page":
      return query.entityTypeId;
    case "search":
      return query.traversal.maxDepth === 0 ? query.entityTypeId : null;
    case "aggregation":
      return query.source.kind === "entity_type" &&
        query.aggregation.kind === "count"
        ? query.source.entityTypeId
        : null;
    case "relationship_traversal":
    case "commerce_list_page":
    case "saved_commerce_view":
    case "underclerk_context":
      return null;
    default:
      return assertNever(query, "entity_plane_unhandled_query_plan");
  }
}

function contextPlanCapability(
  database: CommerceDatabase,
  merchantId: string,
  query: Variant<CommerceGraphQuery, "underclerk_context">,
): CommerceQueryCapabilityProfile | null {
  switch (query.selection.kind) {
    case "selector": {
      const selected = query.selection.selector.query;
      if (selected.kind === "saved_commerce_view") {
        const contextView = savedViewPlanContext(
          database,
          merchantId,
          selected.viewId,
        );
        if (
          contextView === null ||
          String(query.selection.selector.selectorId) !==
            String(contextView.capability.viewId) ||
          Number(query.selection.selector.revision) !==
            Number(contextView.capability.viewRevision)
        )
          return null;
        return contextView.capability;
      }
      return sourceCapabilityForQuery(database, merchantId, selected);
    }
    case "entity_seeds": {
      const first = query.selection.seeds[0];
      if (first === undefined) return null;
      return first.origin === "system"
        ? systemCapability(database, merchantId, first.typeId)
        : customCapability(database, merchantId, first.typeId);
    }
    default:
      return assertNever(query.selection, "entity_plane_unhandled_query_plan");
  }
}

function sourceCapabilityForQuery(
  database: CommerceDatabase,
  merchantId: string,
  query: CommerceGraphQuery,
): CommerceSavedViewCapabilitySource | null {
  switch (query.kind) {
    case "entity_by_ref":
      return query.reference.origin === "system"
        ? systemCapability(database, merchantId, query.reference.typeId)
        : customCapability(database, merchantId, query.reference.typeId);
    case "entity_type_page":
    case "search":
      return query.entityTypeId === null
        ? null
        : query.entityTypeId.origin === "system"
          ? systemCapability(database, merchantId, query.entityTypeId.typeId)
          : customCapability(database, merchantId, query.entityTypeId.typeId);
    case "commerce_list_page":
      return listCapability(database, merchantId, query.listId);
    case "aggregation":
      return query.source.kind === "commerce_list"
        ? listCapability(database, merchantId, query.source.listId)
        : query.source.entityTypeId.origin === "system"
          ? systemCapability(
              database,
              merchantId,
              query.source.entityTypeId.typeId,
            )
          : customCapability(
              database,
              merchantId,
              query.source.entityTypeId.typeId,
            );
    case "relationship_traversal":
      return relationshipTraversalCapability(
        database,
        merchantId,
        query.seeds,
        query.relationshipDefinition,
      );
    case "saved_commerce_view":
      return (
        savedViewPlanContext(database, merchantId, query.viewId)?.capability
          .source ?? null
      );
    case "underclerk_context":
      return null;
    default:
      return assertNever(query, "entity_plane_unhandled_query_plan");
  }
}

function sharedPlanListId(query: CommerceGraphQuery): CommerceListId | null {
  if (query.kind === "commerce_list_page") {
    return query.listId;
  }
  if (query.kind === "aggregation" && query.source.kind === "commerce_list") {
    return query.aggregation.kind === "count" ? query.source.listId : null;
  }
  return null;
}

function entityTypeForReference(
  reference: CommerceEntityRef,
): CommerceEntityTypeId {
  return reference.origin === "system"
    ? { origin: "system", typeId: reference.typeId }
    : { origin: "custom", typeId: reference.typeId };
}

function plannedQueryHttpError(
  outcome: Exclude<
    CommerceEntityPlanePlannedQueryResponse,
    { kind: "planned" }
  >,
): EntityPlaneHttpError {
  switch (outcome.kind) {
    case "cursor_mismatch":
      return new EntityPlaneHttpError(
        400,
        `Commerce cursor does not match the query: ${outcome.reason}`,
        { code: "invalid_query" },
      );
    case "cursor_stale":
      return new EntityPlaneHttpError(
        409,
        "Commerce cursor watermark is stale",
        { code: "invalid_query" },
        "cursor_stale",
      );
    case "unsupported_query":
      return new EntityPlaneHttpError(
        400,
        `Commerce query is unsupported: ${outcome.capability.kind}`,
        { code: "invalid_query" },
      );
    case "invalid":
      return new EntityPlaneHttpError(400, "Commerce query is invalid", {
        code: "invalid_query",
      });
    default:
      return assertNever(outcome, "entity_plane_unhandled_query_plan");
  }
}
