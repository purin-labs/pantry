import type {
  CommerceEntity,
  CommerceEntityPlaneError,
  CommerceEntityRef,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceCursorMismatchReason,
  CommerceQueryPlanErrorCapability,
  CommerceQueryCapabilityProfile,
  CommerceReadWatermark,
  CommerceRelationship,
  SourceProvenance,
  SystemCommerceEntityRef,
} from "@seams/contracts";
import type { Result } from "../../result";
import type { CommerceSystem } from "../../data/organisation-commerce-system";
import type { CommerceWasmError } from "../commerce-wasm";
import { commerceBlotterSystemAttributeIds } from "../../actors/commerce-query-schema";
import type { BlotterQueryPlanResult } from "./blotter-source";
import { buildCommerceGraphQueryPlanRequest } from "./planner";
import { planCommerceGraphQuery } from "../commerce-wasm";
import {
  enforceCommerceGraphReadAuthority,
  filterCommerceGraphSensitivity,
  type CommerceGraphReadAuthority,
} from "./authority";
import type {
  CommerceGraphCapabilityMetadata,
  CommerceGraphEntityExtensionSidecar,
  CommerceGraphSourceError,
  CommerceGraphSource as CommerceGraphQuerySource,
  CommerceGraphSourceQueryOptions,
  CommerceGraphSourceValue,
  CommerceGraphSourceResult,
  CommerceGraphPlannedSourceResult,
  CommerceGraphRelationshipStepInput,
  CommerceGraphRelationshipStepResult,
} from "./commerce-source";
import type { Variant, VariantBy } from "@seams/type-utils";
import { assertNever } from "@seams/std";

const SQLITE_TEXT_ENCODER = new TextEncoder();

export type CommerceGraphReaderError =
  | CommerceEntityPlaneError
  | CommerceGraphSourceError
  | Readonly<{
      code:
        | "commerce_system_not_found"
        | "blotter_source_missing"
        | "commerce_query_surface_unsupported";
    }>
  | Readonly<{
      code: "commerce_cursor_mismatch";
      reason: CommerceCursorMismatchReason;
    }>
  | Readonly<{
      code: "commerce_cursor_stale";
      expected: CommerceReadWatermark;
      received: CommerceReadWatermark;
    }>
  | Readonly<{
      code: "commerce_results_changed";
      expected: CommerceReadWatermark;
      received: CommerceReadWatermark;
    }>
  | Readonly<{
      code: "commerce_read_stale";
      expected: CommerceReadWatermark;
      received: CommerceReadWatermark;
      restart: true;
    }>
  | Readonly<{
      code: "commerce_query_unsupported";
      capability: CommerceQueryPlanErrorCapability;
    }>;

export type CommerceGraphReaderOptions =
  | Readonly<{
      organisationId: string;
      merchantId: string;
      commerceSystem: Variant<CommerceSystem, "satyr_commerce">;
      underclerk: CommerceGraphCommerceSource;
    }>
  | Readonly<{
      organisationId: string;
      merchantId: string;
      commerceSystem: Variant<CommerceSystem, "shopify">;
      underclerk: CommerceGraphHydratingSource;
      blotter: CommerceGraphBlotterSource;
    }>;

export type CommerceGraphCommerceSource = CommerceGraphQuerySource &
  Readonly<{
    source: "underclerk";
    readSnapshotRevision: NonNullable<
      CommerceGraphQuerySource["readSnapshotRevision"]
    >;
    readCapabilityMetadata?: (
      query: CommerceGraphQuery,
    ) => Promise<
      Result<CommerceGraphCapabilityMetadata, CommerceGraphSourceError>
    >;
    queryPlanned: (
      request: import("@seams/contracts").CommerceGraphQueryPlanRequest,
    ) => Promise<CommerceGraphPlannedSourceResult>;
    readRelationshipStep?: (
      input: CommerceGraphRelationshipStepInput,
      options?: CommerceGraphSourceQueryOptions,
    ) => Promise<CommerceGraphRelationshipStepResult>;
  }>;

export type CommerceGraphBlotterSource = Readonly<{
  source: "blotter";
  readSnapshotRevision: NonNullable<
    CommerceGraphQuerySource["readSnapshotRevision"]
  >;
  queryPlan: (
    input: import("./blotter-source").BlotterQueryPlanInput,
    options?: CommerceGraphSourceQueryOptions,
  ) => Promise<BlotterQueryPlanResult>;
  readRelationshipStep?: (
    input: CommerceGraphRelationshipStepInput,
    options?: CommerceGraphSourceQueryOptions,
  ) => Promise<CommerceGraphRelationshipStepResult>;
  hydrateSystemEntities?: (
    references: readonly CommerceEntityRef[],
  ) => Promise<CommerceGraphSourceResult>;
}>;

export type CommerceGraphHydratingSource = CommerceGraphCommerceSource &
  Readonly<{
    hydrateEntityExtensions: NonNullable<
      CommerceGraphQuerySource["hydrateEntityExtensions"]
    >;
  }>;

export type CommerceGraphSource =
  CommerceGraphCommerceSource | CommerceGraphBlotterSource;

export type CommerceGraphReadInput = Readonly<{
  query: CommerceGraphQuery;
  authority: CommerceGraphReadAuthority;
  now: string;
}>;

/**
 * Composes the merchant extension source with the one selected system source.
 * Callers never choose an adapter or receive an authority-specific DTO.
 */
export class CommerceGraphReader {
  readonly #organisationId: string;
  readonly #merchantId: string;
  readonly #commerceSystem: CommerceSystem;
  readonly #underclerk: CommerceGraphCommerceSource;
  readonly #blotter: CommerceGraphBlotterSource | null;

  constructor(options: CommerceGraphReaderOptions) {
    this.#organisationId = options.organisationId;
    this.#merchantId = options.merchantId;
    this.#commerceSystem = options.commerceSystem;
    this.#underclerk = options.underclerk;
    this.#blotter = isShopifyReaderOptions(options) ? options.blotter : null;
  }

  async query(
    input: CommerceGraphReadInput,
  ): Promise<Result<CommerceGraphQueryResult, CommerceGraphReaderError>> {
    const authorized = enforceCommerceGraphReadAuthority({
      organisationId: this.#organisationId,
      query: input.query,
      authority: input.authority,
      now: input.now,
    });
    if (!authorized.ok) return authorized;
    const sourceOptions: CommerceGraphSourceQueryOptions = {
      sensitivityCeiling: input.authority.context.sensitivityCeiling,
    };
    if (input.query.kind === "relationship_traversal") {
      return this.#readRelationshipTraversal(
        input.query,
        input.authority,
        sourceOptions,
      );
    }
    const metadata = await this.#readCapabilityMetadata(input.query);
    if (!metadata.ok) return metadata;
    const commerceNative = await this.#readUnderclerkOwnedQuery(
      input.query,
      metadata.value,
    );
    if (!commerceNative.ok) return commerceNative;
    if (commerceNative.value !== null) {
      const hydrated = await this.#hydrateUnderclerkOwnedSystemReferences(
        commerceNative.value,
      );
      if (!hydrated.ok) return hydrated;
      const allowedAttributes =
        input.query.kind === "underclerk_context"
          ? input.query.allowedAttributeIds
          : undefined;
      return {
        ok: true,
        value: filterCommerceGraphSensitivity(
          hydrated.value,
          input.authority,
          allowedAttributes,
        ),
      };
    }
    const hydrated = await this.#readShopifySystemQuery(
      input.query,
      sourceOptions,
      metadata.value,
    );
    if (!hydrated.ok) return hydrated;
    if (hydrated.value !== null) {
      const result = mergeSourceResults(
        hydrated.value.results,
        hydrated.value.pageOwner,
      );
      if (!result.ok) return result;
      const allowedAttributes =
        input.query.kind === "underclerk_context"
          ? input.query.allowedAttributeIds
          : undefined;
      return {
        ok: true,
        value: filterCommerceGraphSensitivity(
          result.value,
          input.authority,
          allowedAttributes,
        ),
      };
    }
    // Every source read must arrive through the validated Lexicon plan path.
    // Unsupported surfaces terminate here instead of falling back to a raw
    // query or adapter-owned pagination implementation.
    return {
      ok: false,
      error: {
        code: "commerce_query_unsupported",
        capability: { kind: "source_mapping" },
      },
    };
  }

  read(
    input: CommerceGraphReadInput,
  ): Promise<Result<CommerceGraphQueryResult, CommerceGraphReaderError>> {
    return this.query(input);
  }

  async #readRelationshipTraversal(
    query: Variant<CommerceGraphQuery, "relationship_traversal">,
    authority: CommerceGraphReadAuthority,
    options: CommerceGraphSourceQueryOptions,
  ): Promise<Result<CommerceGraphQueryResult, CommerceGraphReaderError>> {
    const metadata = await this.#readCapabilityMetadata(query);
    if (!metadata.ok) return metadata;
    const revision = metadata.value.merchantRevision;
    let watermark: CommerceReadWatermark;
    let sources: readonly CommerceGraphSource[];
    if (this.#commerceSystem.kind === "satyr_commerce") {
      watermark = metadata.value.watermark;
      sources = [this.#underclerk];
    } else {
      if (
        this.#blotter === null ||
        this.#blotter.readSnapshotRevision === undefined
      ) {
        return { ok: false, error: { code: "blotter_source_missing" } };
      }
      const blotterRevision = await this.#blotter.readSnapshotRevision();
      if (!blotterRevision.ok) return blotterRevision;
      watermark = {
        kind: "provider_backed",
        blotterAcceptedProjectionSequence: blotterRevision.value,
        underclerkExtensionMerchantRevision: revision,
      };
      sources = [this.#blotter, this.#underclerk];
    }
    const request = buildCommerceGraphQueryPlanRequest({
      query,
      organisationId: this.#organisationId,
      merchantId: this.#merchantId,
      watermark,
      capabilities: publicCommerceCapabilities(metadata.value.capabilities),
      projection: metadata.value.projection,
    });
    if (!request.ok)
      return {
        ok: false,
        error: { code: "commerce_query_surface_unsupported" },
      };
    const planned = planCommerceGraphQuery(request.value);
    if (!planned.ok) return sourceWasmFailure(planned.error.code);
    if (planned.value.kind === "cursor_mismatch") {
      return {
        ok: false,
        error: {
          code: "commerce_cursor_mismatch",
          reason: planned.value.reason,
        },
      };
    }
    if (planned.value.kind === "cursor_stale") {
      return staleReaderError(
        query,
        planned.value.expected,
        planned.value.received,
      );
    }
    if (planned.value.kind === "unsupported_query") {
      return {
        ok: false,
        error: {
          code: "commerce_query_unsupported",
          capability: planned.value.capability,
        },
      };
    }
    if (planned.value.kind === "invalid")
      return { ok: false, error: { code: "invalid_query" } };
    const plan = planned.value.plan;
    if (
      plan.operation.kind !== "relationship_traversal" ||
      plan.predicate.kind !== "all"
    ) {
      return {
        ok: false,
        error: {
          code: "commerce_query_unsupported",
          capability: { kind: "source_mapping" },
        },
      };
    }
    const seeds = [...plan.operation.seeds];
    const entities = new Map<string, CommerceEntity>();
    const relationships = new Map<string, CommerceRelationship>();
    let frontier = [...seeds];
    const limit = Number(plan.limit);
    const maxDepth = plan.operation.traversal.maxDepth;
    for (
      let depth = 0;
      depth <= maxDepth && frontier.length > 0 && entities.size < limit;
      depth += 1
    ) {
      const remaining = limit - entities.size;
      const responses = await Promise.all(
        sources.map(async (source) => {
          if (source.readRelationshipStep === undefined) {
            return {
              source: source.source,
              result: {
                ok: false as const,
                error: {
                  code: "source_invalid" as const,
                  source: source.source,
                  message: "Relationship step source is unavailable",
                },
              },
            };
          }
          const sourceFrontier =
            source.source === "blotter"
              ? frontier.filter(
                  (reference): reference is SystemCommerceEntityRef =>
                    reference.origin === "system",
                )
              : frontier;
          if (sourceFrontier.length === 0) {
            return {
              source: source.source,
              result: {
                ok: true as const,
                value: merchantRevisionResult(null),
              },
            };
          }
          return {
            source: source.source,
            result: await source.readRelationshipStep(
              {
                planRequest: request.value,
                plan,
                frontier: sourceFrontier,
                remaining,
              },
              options,
            ),
          };
        }),
      );
      const stepEntities = new Map<
        string,
        { entity: CommerceEntity; source: CommerceGraphSource["source"] }
      >();
      const stepRelationships = new Map<
        string,
        {
          relationship: CommerceRelationship;
          source: CommerceGraphSource["source"];
        }
      >();
      for (const response of responses.sort(compareSourceResponses)) {
        if (!response.result.ok)
          return relationshipStepReaderFailure(query, response.result.error);
        for (const entity of response.result.value.entities) {
          const key = entityKey(entity.reference);
          const existing = stepEntities.get(key);
          stepEntities.set(
            key,
            existing === undefined
              ? { entity, source: response.source }
              : {
                  entity: mergeEntity(existing.entity, entity, response.source),
                  source: response.source,
                },
          );
        }
        for (const relationship of response.result.value.relationships) {
          const key = relationshipKey(relationship);
          const existing = stepRelationships.get(key);
          stepRelationships.set(
            key,
            existing === undefined
              ? { relationship, source: response.source }
              : {
                  relationship: preferRelationship(
                    existing.relationship,
                    relationship,
                    response.source,
                  ),
                  source: response.source,
                },
          );
        }
      }
      const missingSystemReferences = new Map<string, CommerceEntityRef>();
      for (const { relationship } of stepRelationships.values()) {
        for (const reference of [relationship.source, relationship.target]) {
          const key = entityKey(reference);
          if (
            reference.origin === "system" &&
            !entities.has(key) &&
            !stepEntities.has(key)
          )
            missingSystemReferences.set(key, reference);
        }
      }
      if (
        missingSystemReferences.size > 0 &&
        this.#commerceSystem.kind === "shopify"
      ) {
        const blotter = this.#blotter;
        if (blotter?.hydrateSystemEntities === undefined) {
          return {
            ok: false,
            error: {
              code: "source_invalid",
              source: "blotter",
              message: "Blotter exact system hydration is unavailable",
            },
          };
        }
        const hydrated = await blotter.hydrateSystemEntities([
          ...missingSystemReferences.values(),
        ]);
        if (!hydrated.ok) return hydrated;
        for (const entity of hydrated.value.entities)
          stepEntities.set(entityKey(entity.reference), {
            entity,
            source: "blotter",
          });
      }
      const orderedStepEntities = [
        ...frontier.flatMap((reference) => {
          const key = entityKey(reference);
          const entry = stepEntities.get(key);
          return entry === undefined ? [] : [[key, entry] as const];
        }),
        ...[...stepEntities.entries()]
          .filter(
            ([key]) =>
              !frontier.some((reference) => entityKey(reference) === key),
          )
          .sort(compareKeyedEntries),
      ];
      for (const [key, entry] of orderedStepEntities) {
        if (entities.has(key)) continue;
        if (maxDepth === 0 && !seeds.some((seed) => entityKey(seed) === key))
          continue;
        if (entities.size >= limit) break;
        entities.set(key, entry.entity);
      }
      const nextFrontier: CommerceEntityRef[] = [];
      for (const [key, entry] of [...stepRelationships.entries()].sort(
        compareKeyedEntries,
      )) {
        if (maxDepth === 0) continue;
        const relationship = entry.relationship;
        const sourceKey = entityKey(relationship.source);
        const targetKey = entityKey(relationship.target);
        const next = frontier.some(
          (reference) => entityKey(reference) === sourceKey,
        )
          ? relationship.target
          : frontier.some((reference) => entityKey(reference) === targetKey)
            ? relationship.source
            : undefined;
        if (
          next !== undefined &&
          !entities.has(entityKey(next)) &&
          entities.size >= limit
        )
          continue;
        if (!entities.has(sourceKey) || !entities.has(targetKey)) continue;
        relationships.set(key, relationship);
        if (
          next !== undefined &&
          !frontier.some(
            (reference) => entityKey(reference) === entityKey(next),
          )
        ) {
          nextFrontier.push(next);
        }
      }
      frontier = [
        ...new Map(
          nextFrontier
            .sort(compareEntityReferences)
            .map((reference) => [entityKey(reference), reference]),
        ).values(),
      ];
      if (depth === maxDepth) break;
    }
    const result: CommerceGraphQueryResult = {
      merchantRevision: revision,
      entities: [...entities.values()],
      relationships: [...relationships.values()],
      listEntries: [],
      aggregations: [],
      nextCursor: null,
      provenance: [...entities.values()]
        .filter(
          (
            entity,
          ): entity is Extract<
            CommerceEntity,
            { reference: { origin: "system" } }
          > => entity.reference.origin === "system",
        )
        .map((entity) => entity.provenance),
      freshness: [...entities.values()]
        .filter(
          (
            entity,
          ): entity is Extract<
            CommerceEntity,
            { reference: { origin: "system" } }
          > => entity.reference.origin === "system",
        )
        .map((entity) => entity.freshness),
    };
    return {
      ok: true,
      value: filterCommerceGraphSensitivity(result, authority),
    };
  }

  async #readCapabilityMetadata(
    query: CommerceGraphQuery,
  ): Promise<
    Result<CommerceGraphCapabilityMetadata, CommerceGraphReaderError>
  > {
    if (this.#underclerk.readCapabilityMetadata === undefined) {
      return {
        ok: false,
        error: {
          code: "source_invalid",
          source: "underclerk",
          message: "Underclerk capability metadata is unavailable",
        },
      };
    }
    const metadata = await this.#underclerk.readCapabilityMetadata(query);
    if (
      !metadata.ok &&
      metadata.error.code === "commerce_query_surface_unsupported"
    ) {
      return {
        ok: false,
        error: { code: "commerce_query_surface_unsupported" },
      };
    }
    return metadata;
  }

  async #hydrateUnderclerkOwnedSystemReferences(
    result: CommerceGraphQueryResult,
  ): Promise<Result<CommerceGraphQueryResult, CommerceGraphReaderError>> {
    if (this.#commerceSystem.kind !== "shopify")
      return { ok: true, value: result };
    const references = [
      ...result.entities.map((entity) => entity.reference),
      ...result.listEntries.map((entry) => entry.entityRef),
    ]
      .filter(
        (reference): reference is SystemCommerceEntityRef =>
          reference.origin === "system",
      )
      .filter(
        (reference, index, all) =>
          all.findIndex(
            (candidate) => entityKey(candidate) === entityKey(reference),
          ) === index,
      );
    if (references.length === 0) return { ok: true, value: result };
    const blotter = this.#blotter;
    if (blotter?.hydrateSystemEntities === undefined) {
      return {
        ok: false,
        error: {
          code: "source_invalid",
          source: "blotter",
          message: "Blotter exact system hydration is unavailable",
        },
      };
    }
    const hydrated = await blotter.hydrateSystemEntities(references);
    if (!hydrated.ok) return hydrated;
    const byReference = new Map(
      hydrated.value.entities.map((entity) => [
        entityKey(entity.reference),
        entity,
      ]),
    );
    if (
      references.some((reference) => !byReference.has(entityKey(reference)))
    ) {
      return {
        ok: false,
        error: {
          code: "source_invalid",
          source: "blotter",
          message:
            "Blotter exact system hydration omitted a requested reference",
        },
      };
    }
    const entities = result.entities.map((entity) => {
      if (entity.reference.origin !== "system") return entity;
      const hydratedEntity = byReference.get(entityKey(entity.reference));
      if (hydratedEntity === undefined)
        throw new Error("Blotter exact system hydration invariant failed");
      return hydratedEntity;
    });
    for (const entry of result.listEntries) {
      if (
        entry.entityRef.origin !== "system" ||
        entities.some(
          (entity) =>
            entityKey(entity.reference) === entityKey(entry.entityRef),
        )
      )
        continue;
      const hydratedEntity = byReference.get(entityKey(entry.entityRef));
      if (hydratedEntity !== undefined) entities.push(hydratedEntity);
    }
    const systemEntities = entities.filter(
      (
        entity,
      ): entity is Extract<
        CommerceEntity,
        { reference: { origin: "system" } }
      > => entity.reference.origin === "system",
    );
    return {
      ok: true,
      value: {
        ...result,
        entities,
        provenance: systemEntities.map((entity) => entity.provenance),
        freshness: systemEntities.map((entity) => entity.freshness),
      },
    };
  }

  async #readUnderclerkOwnedQuery(
    query: CommerceGraphQuery,
    metadata: CommerceGraphCapabilityMetadata,
  ): Promise<
    Result<CommerceGraphQueryResult | null, CommerceGraphReaderError>
  > {
    if (
      this.#commerceSystem.kind !== "satyr_commerce" &&
      usesBlotterPageOwner(query, metadata.capabilities)
    ) {
      return { ok: true, value: null };
    }
    const revision = metadata.merchantRevision;
    const watermark: CommerceReadWatermark = metadata.watermark;
    const request = buildCommerceGraphQueryPlanRequest({
      query,
      organisationId: this.#organisationId,
      merchantId: this.#merchantId,
      watermark,
      capabilities: publicCommerceCapabilities(metadata.capabilities),
      projection: metadata.projection,
    });
    if (!request.ok) {
      return request.error.code === "commerce_query_surface_unsupported"
        ? { ok: false, error: { code: "commerce_query_surface_unsupported" } }
        : sourceWasmFailure(request.error.code, "underclerk");
    }
    const response = await this.#underclerk.queryPlanned(request.value);
    if (!response.ok) return response;
    if (response.value.kind === "cursor_mismatch") {
      return {
        ok: false,
        error: {
          code: "commerce_cursor_mismatch",
          reason: response.value.reason,
        },
      };
    }
    if (response.value.kind === "cursor_stale") {
      return staleReaderError(
        query,
        response.value.expected,
        response.value.received,
      );
    }
    if (response.value.kind === "unsupported_query") {
      return {
        ok: false,
        error: {
          code: "commerce_query_unsupported",
          capability: response.value.capability,
        },
      };
    }
    if (response.value.kind === "invalid")
      return { ok: false, error: { code: "invalid_query" } };
    const planned = response.value;
    if (
      planned.plan.watermark.kind !== "underclerk_native" ||
      planned.plan.watermark.merchantRevision !== revision ||
      planned.merchantRevision !== revision ||
      planned.result.merchantRevision !== revision
    ) {
      return {
        ok: false,
        error: {
          code: "source_invalid",
          source: "underclerk",
          message:
            "Underclerk planned query revision does not match its accepted snapshot",
        },
      };
    }
    return { ok: true, value: planned.result };
  }

  async #readShopifySystemQuery(
    query: CommerceGraphQuery,
    options: CommerceGraphSourceQueryOptions,
    metadata: CommerceGraphCapabilityMetadata,
  ): Promise<Result<ShopifyPlannedRead | null, CommerceGraphReaderError>> {
    if (
      this.#commerceSystem.kind !== "shopify" ||
      !usesBlotterPageOwner(query, metadata.capabilities)
    ) {
      return { ok: true, value: null };
    }
    if (this.#blotter === null) {
      return { ok: false, error: { code: "blotter_source_missing" } };
    }
    const revisions = await Promise.all([this.#blotter.readSnapshotRevision()]);
    const blotterRevision = revisions[0];
    if (!blotterRevision.ok) return blotterRevision;
    const commerceRevision = metadata.merchantRevision;
    const watermark: CommerceReadWatermark = {
      kind: "provider_backed",
      blotterAcceptedProjectionSequence: blotterRevision.value,
      underclerkExtensionMerchantRevision: commerceRevision,
    };
    const planRequest = buildCommerceGraphQueryPlanRequest({
      query,
      organisationId: this.#organisationId,
      merchantId: this.#merchantId,
      watermark,
      capabilities: publicCommerceCapabilities(metadata.capabilities),
      projection: metadata.projection,
    });
    if (!planRequest.ok) {
      return planRequest.error.code === "commerce_query_surface_unsupported"
        ? { ok: false, error: { code: "commerce_query_surface_unsupported" } }
        : sourceWasmFailure(planRequest.error.code);
    }
    const planned = planCommerceGraphQuery(planRequest.value);
    if (!planned.ok) return sourceWasmFailure(planned.error.code);
    const plan = planned.value;
    if (plan.kind === "cursor_mismatch") {
      return {
        ok: false,
        error: { code: "commerce_cursor_mismatch", reason: plan.reason },
      };
    }
    if (plan.kind === "cursor_stale") {
      return staleReaderError(query, plan.expected, plan.received);
    }
    if (plan.kind === "unsupported_query") {
      return {
        ok: false,
        error: {
          code: "commerce_query_unsupported",
          capability: plan.capability,
        },
      };
    }
    if (plan.kind === "invalid")
      return { ok: false, error: { code: "invalid_query" } };
    if (plan.plan.watermark.kind !== "provider_backed") {
      return {
        ok: false,
        error: {
          code: "source_invalid",
          source: "blotter",
          message: "Lexicon selected an invalid provider page owner",
        },
      };
    }
    const planWatermark = plan.plan.watermark;
    const response = await this.#blotter.queryPlan(
      { planRequest: planRequest.value, plan: plan.plan },
      options,
    );
    if (!response.ok) {
      if (response.error.code === "query_unsupported") {
        return {
          ok: false,
          error: {
            code: "commerce_query_unsupported",
            capability: response.error.capability,
          },
        };
      }
      if (response.error.code === "query_stale") {
        return staleReaderError(
          query,
          response.error.expected,
          response.error.received,
        );
      }
      return { ok: false, error: response.error };
    }
    const references = response.value.entities.map(
      (entity) => entity.reference,
    );
    if (this.#underclerk.hydrateEntityExtensions === undefined) {
      return {
        ok: false,
        error: {
          code: "source_invalid",
          source: "underclerk",
          message: "Underclerk extension sidecar hydration is unavailable",
        },
      };
    }
    const hydrated = await this.#underclerk.hydrateEntityExtensions(
      references,
      options,
    );
    if (!hydrated.ok) return hydrated;
    if (
      hydrated.value.merchantRevision !==
      planWatermark.underclerkExtensionMerchantRevision
    ) {
      return staleReaderError(query, planWatermark, {
        kind: "provider_backed",
        blotterAcceptedProjectionSequence:
          planWatermark.blotterAcceptedProjectionSequence,
        underclerkExtensionMerchantRevision: hydrated.value.merchantRevision,
      });
    }
    return {
      ok: true,
      value: {
        pageOwner: pageOwnerFromWatermark(planWatermark),
        results: [
          {
            source: "underclerk",
            value: merchantRevisionResult(hydrated.value.merchantRevision),
          },
          {
            source: "blotter",
            value: attachExtensionSidecars(
              response.value,
              hydrated.value.sidecars,
            ),
          },
        ],
      },
    };
  }
}

function isShopifyReaderOptions(
  options: CommerceGraphReaderOptions,
): options is VariantBy<
  CommerceGraphReaderOptions,
  "commerceSystem",
  Variant<CommerceSystem, "shopify">
> {
  return options.commerceSystem.kind === "shopify";
}

function pageOwnerFromWatermark(
  watermark: CommerceReadWatermark,
): CommerceGraphSource["source"] {
  switch (watermark.kind) {
    case "underclerk_native":
      return "underclerk";
    case "provider_backed":
      return "blotter";
    default:
      return assertNever(watermark);
  }
}

function sourceWasmFailure(
  code: CommerceWasmError["code"],
  source: CommerceGraphSource["source"] = "blotter",
): Result<never, CommerceGraphReaderError> {
  return {
    ok: false,
    error: {
      code: "source_invalid",
      source,
      message: `Lexicon planner failure: ${code}`,
    },
  };
}

function staleReaderError(
  query: CommerceGraphQuery,
  expected: CommerceReadWatermark,
  received: CommerceReadWatermark,
): Result<never, CommerceGraphReaderError> {
  switch (query.kind) {
    case "aggregation":
    case "underclerk_context":
      return {
        ok: false,
        error: {
          code: "commerce_read_stale",
          expected,
          received,
          restart: true,
        },
      };
    case "entity_by_ref":
    case "entity_type_page":
    case "search":
    case "relationship_traversal":
    case "commerce_list_page":
    case "saved_commerce_view":
      return {
        ok: false,
        error: { code: "commerce_results_changed", expected, received },
      };
    default:
      return assertNever(query);
  }
}

function relationshipStepReaderFailure(
  query: CommerceGraphQuery,
  error: import("./commerce-source").CommerceGraphRelationshipStepError,
): Result<never, CommerceGraphReaderError> {
  switch (error.code) {
    case "source_unavailable":
    case "source_invalid":
      return { ok: false, error };
    case "commerce_query_surface_unsupported":
      return {
        ok: false,
        error: { code: "commerce_query_surface_unsupported" },
      };
    case "commerce_cursor_mismatch":
    case "commerce_query_unsupported":
    case "invalid_query":
      return { ok: false, error };
    case "commerce_cursor_stale":
      return staleReaderError(query, error.expected, error.received);
    default:
      return assertNever(error);
  }
}

function usesBlotterPageOwner(
  query: CommerceGraphQuery,
  capabilities: CommerceQueryCapabilityProfile,
): boolean {
  switch (query.kind) {
    case "entity_by_ref":
      return query.reference.origin === "system";
    case "entity_type_page":
      return query.entityTypeId.origin === "system";
    case "search":
      return (
        query.entityTypeId === null || query.entityTypeId.origin === "system"
      );
    case "aggregation":
      return (
        query.source.kind === "entity_type" &&
        query.source.entityTypeId.origin === "system"
      );
    case "underclerk_context":
      return query.selection.kind === "entity_seeds"
        ? query.selection.seeds.some((seed) => seed.origin === "system")
        : usesBlotterPageOwner(
            query.selection.selector.query,
            selectorCapabilities(capabilities),
          );
    case "saved_commerce_view":
      return capabilities.kind === "saved_commerce_view"
        ? capabilities.source.kind === "system_mapped"
        : capabilities.kind === "system_mapped";
    case "commerce_list_page":
      return false;
    case "relationship_traversal":
      return false;
    default:
      return assertNever(query);
  }
}

function selectorCapabilities(
  capabilities: CommerceQueryCapabilityProfile,
): CommerceQueryCapabilityProfile {
  if (capabilities.kind === "saved_commerce_view") return capabilities.source;
  return capabilities;
}

function publicCommerceCapabilities(
  capabilities: CommerceQueryCapabilityProfile,
): CommerceQueryCapabilityProfile {
  switch (capabilities.kind) {
    case "system_mapped":
      return blotterSystemCapabilities(capabilities);
    case "saved_commerce_view":
      return {
        kind: "saved_commerce_view",
        viewId: capabilities.viewId,
        viewRevision: capabilities.viewRevision,
        filter: capabilities.filter,
        sorts: capabilities.sorts,
        source:
          capabilities.source.kind === "system_mapped"
            ? blotterSystemCapabilities(capabilities.source)
            : capabilities.source,
      };
    case "underclerk_custom":
    case "commerce_list":
      return capabilities;
    default:
      return assertNever(capabilities);
  }
}

function blotterSystemCapabilities(
  capabilities: Variant<CommerceQueryCapabilityProfile, "system_mapped">,
): Variant<CommerceQueryCapabilityProfile, "system_mapped"> {
  const supported = commerceBlotterSystemAttributeIds(
    capabilities.systemEntityKind,
  );
  return {
    kind: "system_mapped",
    systemEntityKind: capabilities.systemEntityKind,
    systemSchemaRevision: capabilities.systemSchemaRevision,
    capability: {
      ...capabilities.capability,
      filterableAttributeIds:
        capabilities.capability.filterableAttributeIds.filter((attributeId) =>
          supported.includes(attributeId),
        ),
      sortableAttributeIds: capabilities.capability.sortableAttributeIds.filter(
        (attributeId) => supported.includes(attributeId),
      ),
    },
  };
}

function queryNeedsBlotter(query: CommerceGraphQuery): boolean {
  switch (query.kind) {
    case "entity_by_ref":
      return query.reference.origin === "system";
    case "entity_type_page":
      return query.entityTypeId.origin === "system";
    case "search":
      return (
        query.entityTypeId === null || query.entityTypeId.origin === "system"
      );
    case "relationship_traversal":
      return query.seeds.some((seed) => seed.origin === "system");
    case "aggregation":
      return (
        query.source.kind === "entity_type" &&
        query.source.entityTypeId.origin === "system"
      );
    case "underclerk_context":
      return query.selection.kind === "entity_seeds"
        ? query.selection.seeds.some((seed) => seed.origin === "system")
        : selectorNeedsBlotter(query.selection.selector.query);
    case "commerce_list_page":
    case "saved_commerce_view":
      return false;
  }
}

function selectorNeedsBlotter(query: CommerceGraphQuery): boolean {
  return queryNeedsBlotter(query);
}

type SourceResult = Readonly<{
  source: CommerceGraphSource["source"];
  value: CommerceGraphSourceValue;
}>;

type ShopifyPlannedRead = Readonly<{
  pageOwner: CommerceGraphSource["source"];
  results: readonly SourceResult[];
}>;

function mergeSourceResults(
  results: readonly SourceResult[],
  pageOwner: CommerceGraphSource["source"],
): Result<CommerceGraphQueryResult, CommerceGraphReaderError> {
  const commerceEngine = results.find((result) => result.source === "underclerk");
  if (commerceEngine === undefined) {
    return {
      ok: false,
      error: {
        code: "source_invalid",
        source: "underclerk",
        message: "Underclerk is the merchant revision owner",
      },
    };
  }
  if (commerceEngine.value.merchantRevision === null) {
    return {
      ok: false,
      error: {
        code: "source_invalid",
        source: "underclerk",
        message: "Underclerk did not provide the merchant revision",
      },
    };
  }
  const ownerResult = results.find((result) => result.source === pageOwner);
  if (ownerResult === undefined) {
    return {
      ok: false,
      error: {
        code: "source_invalid",
        source: pageOwner,
        message: "The selected page owner did not return a result",
      },
    };
  }
  const owner = ownerResult.value;
  const entities = new Map<string, CommerceEntity>();
  const relationships = new Map<
    string,
    SourceResult["value"]["relationships"][number]
  >();
  const provenance = new Map<string, SourceProvenance>();
  const freshness = new Map<
    string,
    CommerceGraphQueryResult["freshness"][number]
  >();
  for (const result of results) {
    for (const entity of result.value.entities) {
      const key = entityKey(entity.reference);
      const existing = entities.get(key);
      entities.set(
        key,
        existing === undefined
          ? entity
          : mergeEntity(existing, entity, result.source),
      );
    }
    for (const relationship of result.value.relationships) {
      const key = relationshipKey(relationship);
      const existing = relationships.get(key);
      relationships.set(
        key,
        existing === undefined
          ? relationship
          : preferRelationship(existing, relationship, result.source),
      );
    }
    for (const item of result.value.provenance)
      provenance.set(provenanceKey(item), item);
    for (const item of result.value.freshness)
      freshness.set(freshnessKey(item), item);
  }
  return {
    ok: true,
    value: {
      merchantRevision: commerceEngine.value.merchantRevision,
      entities: [...entities.values()],
      relationships: [...relationships.values()],
      listEntries: owner.listEntries,
      aggregations: owner.aggregations,
      nextCursor: owner.nextCursor,
      provenance: [...provenance.values()],
      freshness: [...freshness.values()],
    },
  };
}

function merchantRevisionResult(
  merchantRevision: CommerceGraphSourceValue["merchantRevision"],
): CommerceGraphSourceValue {
  return {
    merchantRevision,
    entities: [],
    relationships: [],
    listEntries: [],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  };
}

function attachExtensionSidecars(
  result: CommerceGraphSourceValue,
  sidecars: readonly CommerceGraphEntityExtensionSidecar[],
): CommerceGraphSourceValue {
  const byReference = new Map(
    sidecars.map((sidecar) => [entityKey(sidecar.entityRef), sidecar]),
  );
  return {
    ...result,
    entities: result.entities.map((entity) => {
      const sidecar =
        entity.reference.origin === "system"
          ? byReference.get(entityKey(entity.reference))
          : undefined;
      return sidecar === undefined
        ? entity
        : {
            ...entity,
            attributes: mergeAttributes(entity.attributes, sidecar.attributes),
          };
    }),
  };
}

function mergeAttributes(
  systemAttributes: readonly CommerceEntity["attributes"][number][],
  extensionAttributes: readonly CommerceEntity["attributes"][number][],
): CommerceEntity["attributes"] {
  const attributes = new Map<string, CommerceEntity["attributes"][number]>();
  for (const attribute of systemAttributes)
    attributes.set(attributeKey(attribute), attribute);
  for (const attribute of extensionAttributes) {
    if (attribute.scope.kind !== "merchant_extension") continue;
    if (!attributes.has(attributeKey(attribute)))
      attributes.set(attributeKey(attribute), attribute);
  }
  return [...attributes.values()];
}

function attributeKey(attribute: CommerceEntity["attributes"][number]): string {
  switch (attribute.scope.kind) {
    case "system":
    case "merchant_extension":
      return `${attribute.scope.kind}:${attribute.scope.entityTypeId}:${String(attribute.scope.schemaRevision)}:${String(attribute.definitionRevision)}:${String(attribute.attributeId)}`;
    case "custom":
      return `${attribute.scope.kind}:${attribute.scope.entityTypeId}:${String(attribute.scope.typeRevision)}:${String(attribute.definitionRevision)}:${String(attribute.attributeId)}`;
  }
}

function mergeEntity(
  left: CommerceEntity,
  right: CommerceEntity,
  incomingSource: CommerceGraphSource["source"],
): CommerceEntity {
  const preferIncoming =
    incomingSource === "blotter" && right.reference.origin === "system";
  const preferred = preferIncoming ? right : left;
  const secondary = preferIncoming ? left : right;
  return {
    ...preferred,
    attributes: mergeAttributes(preferred.attributes, secondary.attributes),
  };
}

function preferRelationship(
  left: CommerceRelationship,
  right: CommerceRelationship,
  incomingSource: CommerceGraphSource["source"],
): CommerceRelationship {
  return incomingSource === "blotter" && right.origin === "system"
    ? right
    : left;
}

function entityKey(reference: CommerceEntityRef): string {
  return `${reference.origin}:${reference.typeId}:${reference.entityId}`;
}

function relationshipKey(relationship: CommerceRelationship): string {
  return `${relationship.origin}:${relationship.relationshipId}`;
}

function provenanceKey(provenance: SourceProvenance): string {
  return `${provenance.source}:${provenance.resourceType}:${provenance.resourceId}:${provenance.revision}`;
}

function freshnessKey(
  freshness: CommerceGraphQueryResult["freshness"][number],
): string {
  switch (freshness.state) {
    case "current":
      return `current:${freshness.observedAt}`;
    case "stale":
      return `stale:${freshness.observedAt}:${freshness.staleSince}`;
    case "unavailable":
      return `unavailable:${freshness.reason}`;
    default:
      return assertNever(freshness);
  }
}

function compareSourceResponses(
  left: Readonly<{ source: string }>,
  right: Readonly<{ source: string }>,
): number {
  return compareSqliteText(left.source, right.source);
}

function compareKeyedEntries<T>(
  left: readonly [string, T],
  right: readonly [string, T],
): number {
  return compareSqliteText(left[0], right[0]);
}

function compareEntityReferences(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): number {
  return compareSqliteText(entityKey(left), entityKey(right));
}

function compareSqliteText(left: string, right: string): number {
  const leftBytes = SQLITE_TEXT_ENCODER.encode(left);
  const rightBytes = SQLITE_TEXT_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
