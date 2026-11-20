import type {
  CommerceEntityTypeId,
  CommerceGraphQuery,
  CommerceGraphQueryPlanRequest,
  CommerceQueryCapabilityProfile,
  CommerceQueryProjection,
  CommerceQueryPlanOutcome,
  CommerceReadWatermark,
  SystemCommerceEntityKind,
} from "@purin-labs/commerce-contracts";
import { parseCommerceMerchantId } from "@purin-labs/commerce-client";

import {
  planCommerceGraphQuery,
  type CommerceWasmError,
} from "../commerce-wasm";
import type { Result } from "../../result";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

type CommerceSafeQueryError = Readonly<{
  code: "commerce_query_surface_unsupported";
}>;

export function planSafeCommerceQuery(
  input: Readonly<{
    query: CommerceGraphQuery;
    organisationId: string;
    merchantId: string;
    watermark: CommerceReadWatermark;
    capabilities: CommerceQueryCapabilityProfile;
  }>,
): Result<
  CommerceQueryPlanOutcome,
  CommerceSafeQueryError | CommerceWasmError
> {
  const request = buildCommerceGraphQueryPlanRequest({
    ...input,
    projection: commerceGraphQueryProjection(input.query),
  });
  return request.ok ? planCommerceGraphQuery(request.value) : request;
}

export function buildCommerceGraphQueryPlanRequest(
  input: Readonly<{
    query: CommerceGraphQuery;
    organisationId: string;
    merchantId: string;
    watermark: CommerceReadWatermark;
    capabilities: CommerceQueryCapabilityProfile;
    projection: CommerceQueryProjection;
  }>,
): Result<
  CommerceGraphQueryPlanRequest,
  CommerceSafeQueryError | CommerceWasmError
> {
  if (!capabilityProfileMatchesQuery(input.query, input.capabilities)) {
    return { ok: false, error: { code: "commerce_query_surface_unsupported" } };
  }
  try {
    return {
      ok: true,
      value: {
        query: input.query,
        semantics: {
          semanticsVersion: "v1",
          orderingVersion: "v1",
          textNormalization: "commerce_unicode_v1",
          nullPlacement: "last",
        },
        projection: input.projection,
        organisationId: input.organisationId,
        merchantId: parseCommerceMerchantId(input.merchantId),
        watermark: input.watermark,
        capabilities: input.capabilities,
      },
    };
  } catch {
    return { ok: false, error: { code: "commerce_wasm_input_invalid" } };
  }
}

type CommerceCapabilityIdentity =
  | Readonly<{
      kind: "system_mapped";
      systemEntityKind: SystemCommerceEntityKind;
    }>
  | Readonly<{ kind: "underclerk_custom"; entityTypeId: string }>
  | Readonly<{ kind: "commerce_list"; listId: string }>
  | Readonly<{ kind: "saved_commerce_view"; viewId: string }>
  | Readonly<{ kind: "context_source" }>;

function capabilityProfileMatchesQuery(
  query: CommerceGraphQuery,
  capabilities: CommerceQueryCapabilityProfile,
): boolean {
  const expected = expectedCapabilityIdentity(query);
  if (expected === null) return false;
  switch (expected.kind) {
    case "system_mapped":
      return (
        capabilities.kind === expected.kind &&
        capabilities.systemEntityKind === expected.systemEntityKind
      );
    case "underclerk_custom":
      return (
        capabilities.kind === expected.kind &&
        capabilities.entityTypeId === expected.entityTypeId
      );
    case "commerce_list":
      return (
        capabilities.kind === expected.kind &&
        capabilities.listId === expected.listId
      );
    case "saved_commerce_view":
      return (
        capabilities.kind === expected.kind &&
        capabilities.viewId === expected.viewId
      );
    case "context_source":
      return (
        capabilities.kind === "system_mapped" ||
        capabilities.kind === "underclerk_custom" ||
        capabilities.kind === "commerce_list" ||
        capabilities.kind === "saved_commerce_view"
      );
    default:
      return assertNever(
        expected,
        "Unexpected commerce query capability branch",
      );
  }
}

function expectedCapabilityIdentity(
  query: CommerceGraphQuery,
): CommerceCapabilityIdentity | null {
  switch (query.kind) {
    case "entity_by_ref":
      return capabilityIdentityForReference(query.reference);
    case "entity_type_page":
      return capabilityIdentityForEntityType(query.entityTypeId);
    case "relationship_traversal":
      return relationshipCapabilityIdentity(query.seeds);
    case "commerce_list_page":
      return { kind: "commerce_list", listId: query.listId };
    case "saved_commerce_view":
      return { kind: "saved_commerce_view", viewId: query.viewId };
    case "search":
      return query.entityTypeId === null
        ? null
        : capabilityIdentityForEntityType(query.entityTypeId);
    case "aggregation":
      return query.aggregation.kind !== "count"
        ? null
        : query.source.kind === "commerce_list"
          ? { kind: "commerce_list", listId: query.source.listId }
          : capabilityIdentityForEntityType(query.source.entityTypeId);
    case "underclerk_context":
      if (query.selection.kind === "entity_seeds")
        return relationshipCapabilityIdentity(query.selection.seeds);
      return query.selection.selector.query.kind === "saved_commerce_view"
        ? { kind: "context_source" }
        : expectedCapabilityIdentity(query.selection.selector.query);
    default:
      return assertNever(query, "Unexpected commerce query capability branch");
  }
}

function capabilityIdentityForReference(
  reference: Variant<CommerceGraphQuery, "entity_by_ref">["reference"],
): CommerceCapabilityIdentity {
  return reference.origin === "system"
    ? { kind: "system_mapped", systemEntityKind: reference.typeId }
    : { kind: "underclerk_custom", entityTypeId: reference.typeId };
}

function capabilityIdentityForEntityType(
  entityTypeId: CommerceEntityTypeId,
): CommerceCapabilityIdentity {
  return entityTypeId.origin === "system"
    ? { kind: "system_mapped", systemEntityKind: entityTypeId.typeId }
    : { kind: "underclerk_custom", entityTypeId: entityTypeId.typeId };
}

function relationshipCapabilityIdentity(
  seeds: Variant<CommerceGraphQuery, "relationship_traversal">["seeds"],
): CommerceCapabilityIdentity | null {
  const first = seeds[0];
  if (
    first === undefined ||
    seeds.some(
      (seed) => seed.origin !== first.origin || seed.typeId !== first.typeId,
    )
  )
    return null;
  return first.origin === "system"
    ? { kind: "system_mapped", systemEntityKind: first.typeId }
    : { kind: "underclerk_custom", entityTypeId: first.typeId };
}

export function commerceGraphQueryProjection(
  query: CommerceGraphQuery,
): CommerceQueryProjection {
  return {
    attributeIds: [],
    relationshipDefinitions:
      query.kind === "relationship_traversal" &&
      query.relationshipDefinition !== null
        ? [query.relationshipDefinition]
        : [],
    includeProvenance: true,
    includeFreshness: true,
  };
}
