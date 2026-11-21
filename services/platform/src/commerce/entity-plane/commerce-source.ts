import type {
  CommerceEntityPlaneClient,
  CommerceEntityPlanePlannedQueryResponse,
  CommerceEntityPlaneSystemExtensionSidecar,
} from "@purin-labs/commerce-client";
import { parseCommerceSnapshotRevision } from "@purin-labs/commerce-client";
import { isSystemCommerceEntity } from "@purin-labs/commerce-contracts";
import type {
  AttributeValueAssignment,
  CommerceEntity,
  CommerceEntityRef,
  SystemCommerceEntityRef,
  CommerceGraphQueryPlanRequest,
  CommerceGraphQueryResult,
  CommerceSnapshotRevision,
  CommerceSensitivity,
  MerchantExtensionSchemaRevision,
  CommerceRelationship,
  CommerceReadWatermark,
  CommerceGraphQuery,
  CommerceQueryCapabilityProfile,
  CommerceQueryProjection,
  SourceProvenance,
} from "@purin-labs/commerce-contracts";
import type { Result } from "../../result";
import { errorMessage, isNormalizedText } from "@purin-labs/std";

export type CommerceGraphSourceError = Readonly<{
  code:
    | "source_unavailable"
    | "source_invalid"
    | "commerce_query_surface_unsupported";
  source: "commerce" | "blotter";
  message: string;
}>;

export type CommerceGraphSourceValue = Omit<
  CommerceGraphQueryResult,
  "merchantRevision"
> &
  Readonly<{
    /** Commerce owns this cursor. Blotter deliberately returns null. */
    merchantRevision: CommerceSnapshotRevision | null;
  }>;

export type CommerceGraphCapabilityMetadata = Readonly<{
  organisationId: string;
  merchantId: string;
  merchantRevision: CommerceSnapshotRevision;
  watermark: CommerceReadWatermark;
  capabilities: CommerceQueryCapabilityProfile;
  projection: CommerceQueryProjection;
}>;

export type CommerceGraphSourceResult = Result<
  CommerceGraphSourceValue,
  CommerceGraphSourceError
>;

export type CommerceGraphRelationshipStepInput = Readonly<{
  planRequest: CommerceGraphQueryPlanRequest;
  plan: import("@purin-labs/commerce-contracts").CommerceQueryPlan;
  frontier: readonly CommerceEntityRef[];
  remaining: number;
}>;

export type CommerceGraphRelationshipStepError =
  | CommerceGraphSourceError
  | Readonly<{
      code: "commerce_cursor_mismatch";
      reason: import("@purin-labs/commerce-contracts").CommerceCursorMismatchReason;
    }>
  | Readonly<{
      code: "commerce_cursor_stale";
      expected: CommerceReadWatermark;
      received: CommerceReadWatermark;
    }>
  | Readonly<{
      code: "commerce_query_unsupported";
      capability: import("@purin-labs/commerce-contracts").CommerceQueryPlanErrorCapability;
    }>
  | Readonly<{ code: "invalid_query" }>;

export type CommerceGraphRelationshipStepResult = Result<
  CommerceGraphSourceValue,
  CommerceGraphRelationshipStepError
>;

export type CommerceGraphPlannedSourceResult = Result<
  CommerceEntityPlanePlannedQueryResponse,
  CommerceGraphSourceError
>;

export type CommerceGraphSourceQueryOptions = Readonly<{
  sensitivityCeiling: CommerceSensitivity;
}>;

export type CommerceGraphHydrationResult = Readonly<{
  merchantRevision: CommerceSnapshotRevision;
  sidecars: readonly CommerceGraphEntityExtensionSidecar[];
}>;

export type CommerceGraphEntityExtensionSidecar = Readonly<{
  entityRef: SystemCommerceEntityRef;
  attributes: readonly AttributeValueAssignment[];
  extensionSchemaRevision: MerchantExtensionSchemaRevision | null;
}>;

export type CommerceGraphSource = Readonly<{
  readonly source: "commerce" | "blotter";
  readonly readRelationshipStep?: (
    input: CommerceGraphRelationshipStepInput,
    options?: CommerceGraphSourceQueryOptions,
  ) => Promise<CommerceGraphRelationshipStepResult>;
  readonly hydrateEntityExtensions?: (
    references: readonly CommerceEntityRef[],
    options?: CommerceGraphSourceQueryOptions,
  ) => Promise<Result<CommerceGraphHydrationResult, CommerceGraphSourceError>>;
  readonly readSnapshotRevision?: () => Promise<
    Result<CommerceSnapshotRevision, CommerceGraphSourceError>
  >;
  readonly readCapabilityMetadata?: (
    query: CommerceGraphQuery,
  ) => Promise<
    Result<CommerceGraphCapabilityMetadata, CommerceGraphSourceError>
  >;
}>;

type CommerceSourceOptions = Readonly<{
  organisationId: string;
  merchantId: string;
  integrationAccountId: string;
  client: CommerceEntityPlaneClient;
}>;

/**
 * Keeps the Commerce client behind the graph reader's source boundary.
 * The client owns wire parsing; this adapter owns organisation and provenance fencing.
 */
export class CommerceEngineSource {
  readonly source = "commerce" as const;
  readonly #organisationId: string;
  readonly #merchantId: string;
  readonly #integrationAccountId: string;
  readonly #client: CommerceEntityPlaneClient;

  constructor(options: CommerceSourceOptions) {
    this.#organisationId = normalizedText(
      options.organisationId,
      "organisationId",
    );
    this.#merchantId = normalizedText(options.merchantId, "merchantId");
    this.#integrationAccountId = normalizedText(
      options.integrationAccountId,
      "integrationAccountId",
    );
    this.#client = options.client;
  }

  async queryPlanned(
    request: CommerceGraphQueryPlanRequest,
  ): Promise<CommerceGraphPlannedSourceResult> {
    let response: Awaited<ReturnType<CommerceEntityPlaneClient["queryPlan"]>>;
    try {
      response = await this.#client.queryPlan(request);
    } catch (error) {
      return invalidSource(errorMessage(error), "source_unavailable");
    }
    if (!response.ok) {
      if (response.error.kind === "http" && response.error.status === 400) {
        return {
          ok: false,
          error: {
            code: "commerce_query_surface_unsupported",
            source: "commerce",
            message: response.error.message,
          },
        };
      }
      return invalidSource(
        response.error.message,
        response.error.kind === "invalid_response"
          ? "source_invalid"
          : "source_unavailable",
      );
    }
    if (response.value.kind !== "planned") return response;
    if (
      response.value.organisationId !== this.#organisationId ||
      response.value.merchantId !== this.#merchantId
    ) {
      return invalidSource(
        "Commerce planned query authority mismatch",
        "source_invalid",
      );
    }
    try {
      return {
        ok: true,
        value: {
          ...response.value,
          result: normalizePlannedResult(
            response.value.result,
            this.#organisationId,
            this.#integrationAccountId,
          ),
        },
      };
    } catch (error) {
      return invalidSource(errorMessage(error), "source_invalid");
    }
  }

  async readCapabilityMetadata(
    query: CommerceGraphQuery,
  ): Promise<
    Result<CommerceGraphCapabilityMetadata, CommerceGraphSourceError>
  > {
    let response: Awaited<
      ReturnType<CommerceEntityPlaneClient["capabilityMetadata"]>
    >;
    try {
      response = await this.#client.capabilityMetadata({
        organisationId: this.#organisationId,
        merchantId: this.#merchantId,
        query,
      });
    } catch (error) {
      return invalidSource(errorMessage(error), "source_unavailable");
    }
    if (!response.ok) {
      if (response.error.kind === "http" && response.error.status === 400) {
        return {
          ok: false,
          error: {
            code: "commerce_query_surface_unsupported",
            source: "commerce",
            message: response.error.message,
          },
        };
      }
      return invalidSource(
        response.error.message,
        response.error.kind === "invalid_response"
          ? "source_invalid"
          : "source_unavailable",
      );
    }
    const metadata = response.value;
    if (
      metadata.organisationId !== this.#organisationId ||
      metadata.merchantId !== this.#merchantId
    ) {
      return invalidSource(
        "Commerce capability metadata authority mismatch",
        "source_invalid",
      );
    }
    if (
      metadata.watermark.kind !== "commerce_native" ||
      metadata.watermark.merchantRevision !== metadata.merchantRevision
    ) {
      return invalidSource(
        "Commerce capability metadata watermark mismatch",
        "source_invalid",
      );
    }
    return {
      ok: true,
      value: {
        organisationId: metadata.organisationId,
        merchantId: metadata.merchantId,
        merchantRevision: metadata.merchantRevision,
        watermark: metadata.watermark,
        capabilities: metadata.capabilities,
        projection: metadata.projection,
      },
    };
  }

  async readRelationshipStep(
    input: CommerceGraphRelationshipStepInput,
    _options: CommerceGraphSourceQueryOptions = unrestrictedSourceOptions(),
  ): Promise<CommerceGraphRelationshipStepResult> {
    let response: Awaited<
      ReturnType<CommerceEntityPlaneClient["readRelationshipTraversalStep"]>
    >;
    try {
      response = await this.#client.readRelationshipTraversalStep({
        organisationId: this.#organisationId,
        merchantId: this.#merchantId,
        planRequest: input.planRequest,
        plan: input.plan,
        frontier: input.frontier,
        remaining: input.remaining,
      });
    } catch (error) {
      return relationshipStepFailure(errorMessage(error), "source_unavailable");
    }
    if (!response.ok) {
      return relationshipStepFailure(
        response.error.message,
        response.error.kind === "invalid_response"
          ? "source_invalid"
          : "source_unavailable",
      );
    }
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
      return {
        ok: false,
        error: {
          code: "commerce_cursor_stale",
          expected: response.value.expected,
          received: response.value.received,
        },
      };
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
    if (
      response.value.organisationId !== this.#organisationId ||
      response.value.merchantId !== this.#merchantId
    ) {
      return relationshipStepFailure(
        "Commerce relationship step authority mismatch",
        "source_invalid",
      );
    }
    if (
      input.plan.watermark.kind === "provider_backed" &&
      (response.value.result.entities.some(
        (entity) => entity.reference.origin === "system",
      ) ||
        response.value.result.relationships.some(
          (relationship) => relationship.origin === "system",
        ))
    ) {
      return relationshipStepFailure(
        "Provider-backed Commerce relationship step returned system-owned facts",
        "source_invalid",
      );
    }
    try {
      return {
        ok: true,
        value: normalizePlannedResult(
          response.value.result,
          this.#organisationId,
          this.#integrationAccountId,
        ),
      };
    } catch (error) {
      return relationshipStepFailure(errorMessage(error), "source_invalid");
    }
  }

  async hydrateEntityExtensions(
    references: readonly CommerceEntityRef[],
    _options: CommerceGraphSourceQueryOptions = unrestrictedSourceOptions(),
  ): Promise<Result<CommerceGraphHydrationResult, CommerceGraphSourceError>> {
    const uniqueReferences = uniqueSystemReferences(references);
    if (references.some((reference) => reference.origin !== "system")) {
      return invalidHydration(
        "Commerce extension hydration accepts system references only",
        "source_invalid",
      );
    }
    let response: Awaited<
      ReturnType<CommerceEntityPlaneClient["readSystemExtensionSidecars"]>
    >;
    try {
      response = await this.#client.readSystemExtensionSidecars({
        organisationId: this.#organisationId,
        merchantId: this.#merchantId,
        entityRefs: uniqueReferences,
      });
    } catch (error) {
      return invalidHydration(errorMessage(error), "source_unavailable");
    }
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code:
            response.error.kind === "invalid_response"
              ? "source_invalid"
              : "source_unavailable",
          source: "commerce",
          message: response.error.message,
        },
      };
    }
    if (response.value.merchantId !== this.#merchantId) {
      return invalidHydration(
        "Commerce merchant mismatch during extension hydration",
        "source_invalid",
      );
    }
    const expected = new Set(uniqueReferences.map(entityReferenceKey));
    let sidecars: CommerceGraphEntityExtensionSidecar[];
    try {
      sidecars = response.value.sidecars.map(parseSidecar);
    } catch (error) {
      return invalidHydration(errorMessage(error), "source_invalid");
    }
    if (
      sidecars.length !== expected.size ||
      sidecars.some(
        (sidecar) => !expected.delete(entityReferenceKey(sidecar.entityRef)),
      )
    ) {
      return invalidHydration(
        "Commerce extension sidecar references do not match the requested page",
        "source_invalid",
      );
    }
    return {
      ok: true,
      value: { merchantRevision: response.value.merchantRevision, sidecars },
    };
  }

  async readSnapshotRevision(): Promise<
    Result<CommerceSnapshotRevision, CommerceGraphSourceError>
  > {
    let response: Awaited<
      ReturnType<CommerceEntityPlaneClient["readSystemExtensionSidecars"]>
    >;
    try {
      response = await this.#client.readSystemExtensionSidecars({
        organisationId: this.#organisationId,
        merchantId: this.#merchantId,
        entityRefs: [],
      });
    } catch (error) {
      return invalidHydration(errorMessage(error), "source_unavailable");
    }
    if (!response.ok) {
      return invalidHydration(
        response.error.message,
        response.error.kind === "invalid_response"
          ? "source_invalid"
          : "source_unavailable",
      );
    }
    if (
      response.value.merchantId !== this.#merchantId ||
      response.value.sidecars.length !== 0
    ) {
      return invalidHydration(
        "Commerce snapshot watermark response is invalid",
        "source_invalid",
      );
    }
    return {
      ok: true,
      value: parseCommerceSnapshotRevision(
        response.value.merchantRevision,
        "commerceSnapshotRevision",
      ),
    };
  }
}

function unrestrictedSourceOptions(): CommerceGraphSourceQueryOptions {
  return { sensitivityCeiling: "restricted" };
}

function uniqueSystemReferences(
  references: readonly CommerceEntityRef[],
): readonly SystemCommerceEntityRef[] {
  const seen = new Set<string>();
  return references.flatMap((reference) => {
    if (reference.origin !== "system") return [];
    const key = entityReferenceKey(reference);
    if (seen.has(key)) return [];
    seen.add(key);
    return [reference];
  });
}

function entityReferenceKey(reference: SystemCommerceEntityRef): string {
  return `${reference.typeId}:${reference.entityId}`;
}

function parseSidecar(
  sidecar: CommerceEntityPlaneSystemExtensionSidecar,
): CommerceGraphEntityExtensionSidecar {
  if (sidecar.entityRef.origin !== "system") {
    throw new Error(
      "Commerce extension sidecar returned a non-system entity reference",
    );
  }
  const extensionSchemaRevision =
    sidecar.extension.state === "published" ? sidecar.extension.revision : null;
  for (const attribute of sidecar.attributes) {
    if (
      attribute.scope.kind !== "merchant_extension" ||
      attribute.scope.entityTypeId !== sidecar.entityRef.typeId ||
      extensionSchemaRevision === null ||
      attribute.scope.schemaRevision !== extensionSchemaRevision ||
      Number(attribute.definitionRevision) !== Number(extensionSchemaRevision)
    ) {
      throw new Error(
        "Commerce extension attribute scope does not match its sidecar",
      );
    }
  }
  return {
    entityRef: sidecar.entityRef,
    attributes: sidecar.attributes,
    extensionSchemaRevision,
  };
}

function normalizePlannedResult(
  result: CommerceGraphQueryResult,
  organisationId: string,
  integrationAccountId: string,
): CommerceGraphQueryResult {
  return {
    ...result,
    entities: result.entities.map((entity) =>
      normalizeEntity(entity, organisationId, integrationAccountId),
    ),
    relationships: result.relationships.map((relationship) =>
      normalizeRelationship(relationship, organisationId, integrationAccountId),
    ),
    provenance: result.provenance.map((provenance) =>
      normalizeProvenance(provenance, organisationId, integrationAccountId),
    ),
  };
}

function normalizeEntity(
  entity: CommerceEntity,
  organisationId: string,
  integrationAccountId: string,
): CommerceEntity {
  if (!isSystemCommerceEntity(entity)) return entity;
  return {
    ...entity,
    provenance: normalizeProvenance(
      entity.provenance,
      organisationId,
      integrationAccountId,
    ),
  };
}

function normalizeRelationship(
  relationship: CommerceRelationship,
  organisationId: string,
  integrationAccountId: string,
): CommerceRelationship {
  if (relationship.origin !== "system") return relationship;
  return {
    ...relationship,
    provenance: normalizeProvenance(
      relationship.provenance,
      organisationId,
      integrationAccountId,
    ),
  };
}

function normalizeProvenance(
  provenance: SourceProvenance,
  organisationId: string,
  integrationAccountId: string,
): SourceProvenance {
  if (provenance.organisationId !== organisationId)
    throw new Error("Commerce provenance organisation mismatch");
  if (provenance.source !== "commerce")
    throw new Error("Commerce provenance source mismatch");
  return { ...provenance, integrationAccountId };
}

function invalidSource(
  message: string,
  code: CommerceGraphSourceError["code"],
): Result<never, CommerceGraphSourceError> {
  return { ok: false, error: { code, source: "commerce", message } };
}

function relationshipStepFailure(
  message: string,
  code: CommerceGraphSourceError["code"],
): Result<never, CommerceGraphRelationshipStepError> {
  return { ok: false, error: { code, source: "commerce", message } };
}

function invalidHydration(
  message: string,
  code: CommerceGraphSourceError["code"],
): Result<never, CommerceGraphSourceError> {
  return { ok: false, error: { code, source: "commerce", message } };
}

function normalizedText(value: string, field: string): string {
  if (!isNormalizedText(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}
