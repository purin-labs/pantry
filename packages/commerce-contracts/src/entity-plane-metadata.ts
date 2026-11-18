import {
  StrictObject,
  parseContract,
  parseContractArray,
  type ContractDecodeResult,
} from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import { assertNever } from "@seams/std";
import { type StrictUnion } from "@seams/type-utils";
import { javascriptTrimmedTextSchema } from "./identity-text.ts";
import { commerceSnapshotRevisionSchema } from "./query-metadata.ts";
import {
  commerceEntityTypeIdSchema,
  commerceListIdSchema,
  parseCommerceEntityTypeId,
  queryIdentitySchema,
  invalidShape,
} from "./query-parts.ts";
import {
  commerceEntityRefSchema,
  type CommerceEntityRef,
} from "./entity-reference.ts";
import {
  commerceRelationshipRefSchema,
  commerceRelationshipSchema,
  parseCommerceRelationshipShape,
  type CommerceRelationship,
  type CommerceRelationshipRef,
} from "./relationships.ts";
import { commerceListEntryRefSchema } from "./authority-scope.ts";
import {
  commerceEntityTypeSchema,
  parseCommerceEntityType,
  type CommerceEntityType,
} from "./entity-type.ts";
import {
  commerceListSchema,
  parseCommerceList,
  type CommerceList,
} from "./list-records.ts";
import {
  savedCommerceViewSchema,
  parseSavedCommerceView,
  type SavedCommerceView,
} from "./view-records.ts";
import {
  publishedCommerceSelectorSchema,
  type PublishedCommerceSelector,
} from "./graph-query-schema.ts";
import { parsePublishedCommerceSelector } from "./graph-query.ts";
import { revisionSchema } from "./entity-record.ts";
import {
  parseEntityPlaneEntityReference,
  parseEntityPlaneRelationshipReference,
} from "./entity-plane-resources.ts";

const selectorSchema = Type.Unsafe<PublishedCommerceSelector>(
  publishedCommerceSelectorSchema,
);
export const entityTypePublishedResourceReferenceSchema = StrictObject({
  kind: Type.Literal("entity_type"),
  entityTypeId: commerceEntityTypeIdSchema,
});
export const relationshipPublishedResourceReferenceSchema = StrictObject({
  kind: Type.Literal("relationship"),
  relationship: Type.Unsafe<CommerceRelationshipRef>(
    commerceRelationshipRefSchema,
  ),
});
export const commerceListPublishedResourceReferenceSchema = StrictObject({
  kind: Type.Literal("commerce_list"),
  listId: commerceListIdSchema,
});
export const commerceListEntryPublishedResourceReferenceSchema = StrictObject({
  kind: Type.Literal("commerce_list_entry"),
  entry: commerceListEntryRefSchema,
});
export const savedSelectorPublishedResourceReferenceSchema = StrictObject({
  kind: Type.Literal("saved_selector"),
  selector: selectorSchema,
});
export const entityPlanePublishedResourceReferenceSchema = Type.Union([
  entityTypePublishedResourceReferenceSchema,
  relationshipPublishedResourceReferenceSchema,
  commerceListPublishedResourceReferenceSchema,
  commerceListEntryPublishedResourceReferenceSchema,
  savedSelectorPublishedResourceReferenceSchema,
]);
export type CommerceEntityPlanePublishedResourceReference = StrictUnion<
  Readonly<StaticDecode<typeof entityPlanePublishedResourceReferenceSchema>>
>;
const requestIdentity = {
  organisationId: javascriptTrimmedTextSchema,
  merchantId: javascriptTrimmedTextSchema,
};
export const enumeratePublishedResourceRequestSchema = StrictObject({
  kind: Type.Literal("enumerate"),
  ...requestIdentity,
});
export const resolvePublishedResourceRequestSchema = StrictObject({
  kind: Type.Literal("resolve"),
  ...requestIdentity,
  resource: Type.Unsafe<CommerceEntityPlanePublishedResourceReference>(
    entityPlanePublishedResourceReferenceSchema,
  ),
});
export const entityPlanePublishedResourceMetadataRequestSchema = Type.Union([
  enumeratePublishedResourceRequestSchema,
  resolvePublishedResourceRequestSchema,
]);
export type CommerceEntityPlanePublishedResourceMetadataRequest = StrictUnion<
  Readonly<
    StaticDecode<typeof entityPlanePublishedResourceMetadataRequestSchema>
  >
>;
export const entityTypePublishedResourceSchema = StrictObject({
  kind: Type.Literal("entity_type"),
  entityType: Type.Unsafe<CommerceEntityType>(commerceEntityTypeSchema),
});
export const relationshipPublishedResourceSchema = StrictObject({
  kind: Type.Literal("relationship"),
  relationship: Type.Unsafe<CommerceRelationship>(commerceRelationshipSchema),
});
export const commerceListPublishedResourceSchema = StrictObject({
  kind: Type.Literal("commerce_list"),
  list: Type.Unsafe<CommerceList>(commerceListSchema),
});
export const commerceListEntryPublishedResourceSchema = StrictObject({
  kind: Type.Literal("commerce_list_entry"),
  entry: commerceListEntryRefSchema,
  listRevision: revisionSchema<"CommerceListRevision">(),
  entityTypeId: commerceEntityTypeIdSchema,
  entityRef: Type.Unsafe<CommerceEntityRef>(commerceEntityRefSchema),
});
export const savedSelectorPublishedResourceSchema = StrictObject({
  kind: Type.Literal("saved_selector"),
  selector: selectorSchema,
  view: Type.Unsafe<SavedCommerceView>(savedCommerceViewSchema),
});
export const entityPlanePublishedResourceSchema = Type.Union([
  entityTypePublishedResourceSchema,
  relationshipPublishedResourceSchema,
  commerceListPublishedResourceSchema,
  commerceListEntryPublishedResourceSchema,
  savedSelectorPublishedResourceSchema,
]);
export type CommerceEntityPlanePublishedResource = StrictUnion<
  Readonly<StaticDecode<typeof entityPlanePublishedResourceSchema>>
>;
const responseIdentity = {
  organisationId: javascriptTrimmedTextSchema,
  merchantId: queryIdentitySchema<"CommerceMerchantId">(),
  merchantRevision: commerceSnapshotRevisionSchema,
};
export const entityPlanePublishedResourceMetadataResponseSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("enumerated"),
    ...responseIdentity,
    entityTypes: Type.Unsafe<readonly CommerceEntityType[]>(
      Type.Array(commerceEntityTypeSchema),
    ),
    lists: Type.Unsafe<readonly CommerceList[]>(Type.Array(commerceListSchema)),
    views: Type.Unsafe<readonly SavedCommerceView[]>(
      Type.Array(savedCommerceViewSchema),
    ),
  }),
  StrictObject({
    kind: Type.Literal("resolved"),
    ...responseIdentity,
    resource: Type.Unsafe<CommerceEntityPlanePublishedResource>(
      entityPlanePublishedResourceSchema,
    ),
  }),
]);
export type CommerceEntityPlanePublishedResourceMetadataResponse =
  StrictUnion<
    Readonly<
      StaticDecode<typeof entityPlanePublishedResourceMetadataResponseSchema>
    >
  >;
const referenceWire = Type.Union([
  StrictObject({
    kind: Type.Literal("entity_type"),
    entityTypeId: Type.Unknown(),
  }),
  StrictObject({
    kind: Type.Literal("relationship"),
    relationship: Type.Unknown(),
  }),
  commerceListPublishedResourceReferenceSchema,
  StrictObject({
    kind: Type.Literal("commerce_list_entry"),
    entry: Type.Unknown(),
  }),
  StrictObject({
    kind: Type.Literal("saved_selector"),
    selector: Type.Unknown(),
  }),
]);
const requestWire = Type.Union([
  enumeratePublishedResourceRequestSchema,
  StrictObject({
    kind: Type.Literal("resolve"),
    ...requestIdentity,
    resource: Type.Unknown(),
  }),
]);
const resourceWire = Type.Union([
  StrictObject({
    kind: Type.Literal("entity_type"),
    entityType: Type.Unknown(),
  }),
  StrictObject({
    kind: Type.Literal("relationship"),
    relationship: Type.Unknown(),
  }),
  StrictObject({ kind: Type.Literal("commerce_list"), list: Type.Unknown() }),
  StrictObject({
    ...commerceListEntryPublishedResourceSchema.properties,
    entry: Type.Unknown(),
    entityTypeId: Type.Unknown(),
    entityRef: Type.Unknown(),
  }),
  StrictObject({
    kind: Type.Literal("saved_selector"),
    selector: Type.Unknown(),
    view: Type.Unknown(),
  }),
]);
const responseWire = Type.Union([
  StrictObject({
    kind: Type.Literal("enumerated"),
    ...responseIdentity,
    entityTypes: Type.Array(Type.Unknown()),
    lists: Type.Array(Type.Unknown()),
    views: Type.Array(Type.Unknown()),
  }),
  StrictObject({
    kind: Type.Literal("resolved"),
    ...responseIdentity,
    resource: Type.Unknown(),
  }),
]);
const strictEntryRef = StrictObject(commerceListEntryRefSchema.properties);

export function parseEntityPlanePublishedResourceReference(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlanePublishedResourceReference> {
  const parsed = parseContract(referenceWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const reference = parsed.value;
  switch (reference.kind) {
    case "entity_type": {
      const entityTypeId = parseCommerceEntityTypeId(reference.entityTypeId);
      if (!entityTypeId.ok) return entityTypeId;
      return {
        ok: true,
        value: { kind: reference.kind, entityTypeId: entityTypeId.value },
      };
    }
    case "relationship": {
      const relationship = parseEntityPlaneRelationshipReference(
        reference.relationship,
      );
      if (!relationship.ok) return relationship;
      return {
        ok: true,
        value: { kind: reference.kind, relationship: relationship.value },
      };
    }
    case "commerce_list":
      return {
        ok: true,
        value: { kind: reference.kind, listId: reference.listId },
      };
    case "commerce_list_entry": {
      const entry = parseContract(
        strictEntryRef,
        reference.entry,
        invalidShape,
      );
      if (!entry.ok) return entry;
      return { ok: true, value: { kind: reference.kind, entry: entry.value } };
    }
    case "saved_selector": {
      const selector = parsePublishedCommerceSelector(reference.selector);
      if (!selector.ok) return selector;
      return {
        ok: true,
        value: { kind: reference.kind, selector: selector.value },
      };
    }
    default:
      return assertNever(reference);
  }
}
export function parseEntityPlanePublishedResourceMetadataRequest(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlanePublishedResourceMetadataRequest> {
  const parsed = parseContract(requestWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  if (request.kind === "enumerate")
    return {
      ok: true,
      value: {
        kind: request.kind,
        organisationId: request.organisationId,
        merchantId: request.merchantId,
      },
    };
  const resource = parseEntityPlanePublishedResourceReference(request.resource);
  if (!resource.ok) return resource;
  return {
    ok: true,
    value: {
      kind: request.kind,
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      resource: resource.value,
    },
  };
}
export function parseEntityPlanePublishedResource(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlanePublishedResource> {
  const parsed = parseContract(resourceWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const resource = parsed.value;
  switch (resource.kind) {
    case "entity_type": {
      const entityType = parseCommerceEntityType(resource.entityType);
      if (!entityType.ok) return entityType;
      return {
        ok: true,
        value: { kind: resource.kind, entityType: entityType.value },
      };
    }
    case "relationship": {
      const relationship = parseCommerceRelationshipShape(
        resource.relationship,
      );
      if (!relationship.ok) return relationship;
      return {
        ok: true,
        value: { kind: resource.kind, relationship: relationship.value },
      };
    }
    case "commerce_list": {
      const list = parseCommerceList(resource.list);
      if (!list.ok) return list;
      return { ok: true, value: { kind: resource.kind, list: list.value } };
    }
    case "commerce_list_entry": {
      const entry = parseContract(strictEntryRef, resource.entry, invalidShape);
      if (!entry.ok) return entry;
      const entityTypeId = parseCommerceEntityTypeId(resource.entityTypeId);
      if (!entityTypeId.ok) return entityTypeId;
      const entityRef = parseEntityPlaneEntityReference(resource.entityRef);
      if (!entityRef.ok) return entityRef;
      return {
        ok: true,
        value: {
          kind: resource.kind,
          entry: entry.value,
          listRevision: resource.listRevision,
          entityTypeId: entityTypeId.value,
          entityRef: entityRef.value,
        },
      };
    }
    case "saved_selector": {
      const selector = parsePublishedCommerceSelector(resource.selector);
      if (!selector.ok) return selector;
      const view = parseSavedCommerceView(resource.view);
      if (!view.ok) return view;
      return {
        ok: true,
        value: {
          kind: resource.kind,
          selector: selector.value,
          view: view.value,
        },
      };
    }
    default:
      return assertNever(resource);
  }
}
export function parseEntityPlanePublishedResourceMetadataResponse(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlanePublishedResourceMetadataResponse> {
  const parsed = parseContract(responseWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  if (response.kind === "resolved") {
    const resource = parseEntityPlanePublishedResource(response.resource);
    if (!resource.ok) return resource;
    return {
      ok: true,
      value: {
        kind: response.kind,
        organisationId: response.organisationId,
        merchantId: response.merchantId,
        merchantRevision: response.merchantRevision,
        resource: resource.value,
      },
    };
  }
  const entityTypes = parseContractArray(
    response.entityTypes,
    parseCommerceEntityType,
  );
  if (!entityTypes.ok) return entityTypes;
  const lists = parseContractArray(response.lists, parseCommerceList);
  if (!lists.ok) return lists;
  const views = parseContractArray(response.views, parseSavedCommerceView);
  if (!views.ok) return views;
  return {
    ok: true,
    value: {
      kind: response.kind,
      organisationId: response.organisationId,
      merchantId: response.merchantId,
      merchantRevision: response.merchantRevision,
      entityTypes: entityTypes.value,
      lists: lists.value,
      views: views.value,
    },
  };
}
