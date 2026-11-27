import {
  systemRelationshipDefinitionRefSchema,
  customRelationshipDefinitionRefSchema,
} from "./query-filter.ts";
import { customRelationshipRefSchema } from "./relationships.ts";
import {
  OpenObject,
  StrictObject,
  parseContract,
  parseContractArray,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import { Type, type Static, type StaticDecode } from "typebox";
import { assertNever } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import { javascriptTrimmedTextSchema } from "./identity-text.ts";
import { commerceSnapshotRevisionSchema } from "./query-metadata.ts";
import { merchantRevisionSchema } from "./entity-plane-receipts.ts";
import {
  commerceEntityTypeIdSchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  queryIdentitySchema,
  parseCommerceEntityTypeId,
  invalidShape,
} from "./query-parts.ts";
import {
  systemCommerceEntityRefSchema,
  customCommerceEntityRefSchema,
  parseCommerceEntityRef,
  type SystemCommerceEntityRef,
} from "./entity-reference.ts";

import { parseCommerceRelationshipRef } from "./relationship-commands.ts";
import {
  commerceListEntryRefSchema,
  parseCommerceListEntryRef,
} from "./authority-scope.ts";
import {
  commerceListEntrySchema,
  parseCommerceListEntryShape,
  type CommerceListEntry,
} from "./list-records.ts";
import {
  attributeValueAssignmentSchema,
  revisionSchema,
  parseAssignment,
  type AttributeValueAssignment,
} from "./entity-record.ts";
import { attributeAssignmentWireSchema } from "./entity-wire.ts";
import {
  systemEntityExtensionSchema,
  parseSystemEntityExtension,
  type SystemEntityExtension,
} from "./entity-type.ts";
import { cursorRefusal } from "./cursor-values.ts";

const entityTypeChangeResourceSchema = OpenObject({
  kind: Type.Literal("entity_type"),
  typeId: commerceEntityTypeIdSchema,
});
const entityChangeResourceSchema = OpenObject({
  kind: Type.Literal("entity"),
  ref: customCommerceEntityRefSchema,
});
const relationshipDefinitionChangeResourceSchema = OpenObject({
  kind: Type.Literal("relationship_definition"),
  definitionId: queryIdentitySchema<"RelationshipDefinitionId">(),
});
const customRelationshipChangeResourceSchema = OpenObject({
  kind: Type.Literal("custom_relationship"),
  ref: customRelationshipRefSchema,
});
const commerceListChangeResourceSchema = OpenObject({
  kind: Type.Literal("commerce_list"),
  listId: commerceListIdSchema,
});
const commerceListEntryChangeResourceSchema = OpenObject({
  kind: Type.Literal("commerce_list_entry"),
  ref: Type.Unsafe<Readonly<Static<typeof commerceListEntryRefSchema>>>(
    commerceListEntryRefSchema,
  ),
});
const savedViewChangeResourceSchema = OpenObject({
  kind: Type.Literal("saved_view"),
  viewId: savedCommerceViewIdSchema,
});
const entityPlaneChangeResourceSchema = Type.Union([
  entityTypeChangeResourceSchema,
  entityChangeResourceSchema,
  relationshipDefinitionChangeResourceSchema,
  customRelationshipChangeResourceSchema,
  commerceListChangeResourceSchema,
  commerceListEntryChangeResourceSchema,
  savedViewChangeResourceSchema,
]);
export type CommerceEntityPlaneChangeResource = StrictUnion<
  Readonly<Static<typeof entityPlaneChangeResourceSchema>>
>;
const entityPlaneChangeSchema = OpenObject({
  changeId: javascriptTrimmedTextSchema,
  merchantRevision: merchantRevisionSchema,
  resource: Type.Unsafe<CommerceEntityPlaneChangeResource>(
    entityPlaneChangeResourceSchema,
  ),
  operation: Type.Enum([
    "created",
    "updated",
    "archived",
    "published",
    "deleted",
  ]),
  createdAt: javascriptTrimmedTextSchema,
});
export type CommerceEntityPlaneChange = Readonly<
  Static<typeof entityPlaneChangeSchema>
>;
const entityPlaneChangesSchema = OpenObject({
  merchantId: javascriptTrimmedTextSchema,
  merchantRevision: commerceSnapshotRevisionSchema,
  changes: Type.Unsafe<readonly CommerceEntityPlaneChange[]>(
    Type.Array(entityPlaneChangeSchema),
  ),
  nextAfterMerchantRevision: commerceSnapshotRevisionSchema,
  hasMore: Type.Boolean(),
});
export type CommerceEntityPlaneChanges = Readonly<
  Static<typeof entityPlaneChangesSchema>
>;
const entityPlaneSystemExtensionRequestSchema = OpenObject({
  organisationId: javascriptTrimmedTextSchema,
  merchantId: javascriptTrimmedTextSchema,
  entityRefs: Type.Unsafe<readonly SystemCommerceEntityRef[]>(
    Type.Array(systemCommerceEntityRefSchema, { maxItems: 100 }),
  ),
});
export type CommerceEntityPlaneSystemExtensionRequest = Readonly<
  Static<typeof entityPlaneSystemExtensionRequestSchema>
>;
const entityPlaneSystemExtensionSidecarSchema = OpenObject({
  entityRef: Type.Unsafe<SystemCommerceEntityRef>(
    systemCommerceEntityRefSchema,
  ),
  extension: Type.Unsafe<SystemEntityExtension>(systemEntityExtensionSchema),
  attributes: Type.Unsafe<readonly AttributeValueAssignment[]>(
    Type.Array(attributeValueAssignmentSchema),
  ),
});
export type CommerceEntityPlaneSystemExtensionSidecar = Readonly<
  StaticDecode<typeof entityPlaneSystemExtensionSidecarSchema>
>;
const entityPlaneSystemExtensionResponseSchema = OpenObject({
  merchantId: javascriptTrimmedTextSchema,
  merchantRevision: commerceSnapshotRevisionSchema,
  sidecars: Type.Unsafe<readonly CommerceEntityPlaneSystemExtensionSidecar[]>(
    Type.Array(entityPlaneSystemExtensionSidecarSchema),
  ),
});
export type CommerceEntityPlaneSystemExtensionResponse = Readonly<
  StaticDecode<typeof entityPlaneSystemExtensionResponseSchema>
>;
const listEntryReadRequestSchema = StrictObject({
  merchantId: javascriptTrimmedTextSchema,
  listId: commerceListIdSchema,
  entryId: commerceListEntryRefSchema.properties.entryId,
});
export type CommerceListEntryReadRequest = Readonly<
  Static<typeof listEntryReadRequestSchema>
>;
const missingListEntryReadResultSchema = OpenObject({
  kind: Type.Literal("missing"),
});
const foundListEntryReadResultSchema = OpenObject({
  kind: Type.Literal("found"),
  merchantRevision: commerceSnapshotRevisionSchema,
  listRevision: revisionSchema<"CommerceListRevision">(),
  entry: Type.Unsafe<CommerceListEntry>(commerceListEntrySchema),
});
const listEntryReadResultSchema = Type.Union([
  missingListEntryReadResultSchema,
  foundListEntryReadResultSchema,
]);
export type CommerceListEntryReadResult = StrictUnion<
  Readonly<StaticDecode<typeof listEntryReadResultSchema>>
>;

const changeResourceWire = Type.Union([
  OpenObject({ kind: Type.Literal("entity_type"), typeId: Type.Unknown() }),
  OpenObject({
    kind: Type.Enum(["entity", "custom_relationship", "commerce_list_entry"]),
    ref: Type.Unknown(),
  }),
  OpenObject({
    kind: Type.Literal("relationship_definition"),
    definitionId:
      relationshipDefinitionChangeResourceSchema.properties.definitionId,
  }),
  OpenObject({
    kind: Type.Literal("commerce_list"),
    listId: commerceListIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("saved_view"),
    viewId: savedCommerceViewIdSchema,
  }),
]);
const entityReferenceInput = StrictObject({
  origin: Type.Unknown(),
  typeId: Type.Unknown(),
  entityId: Type.Unknown(),
});
const relationshipReferenceInput = StrictObject({
  origin: Type.Optional(Type.Unknown()),
  relationshipId: Type.Unknown(),
  definition: Type.Union([
    StrictObject(systemRelationshipDefinitionRefSchema.properties),
    StrictObject(customRelationshipDefinitionRefSchema.properties),
  ]),
  revision: Type.Unknown(),
});
export function parseEntityPlaneEntityReference(input: unknown) {
  const parsed = parseContract(entityReferenceInput, input, invalidShape);
  if (!parsed.ok) return parsed;
  return parseCommerceEntityRef(parsed.value);
}
export function parseEntityPlaneRelationshipReference(input: unknown) {
  const parsed = parseContract(relationshipReferenceInput, input, invalidShape);
  if (!parsed.ok) return parsed;
  const reference = parsed.value;
  // This HTTP boundary derives the origin from the definition, as the existing SDK does.
  return parseCommerceRelationshipRef({
    origin: reference.definition.origin,
    relationshipId: reference.relationshipId,
    definition: reference.definition,
    revision: reference.revision,
  });
}
const changeWire = OpenObject({
  ...entityPlaneChangeSchema.properties,
  resource: Type.Unknown(),
});
const changesWire = OpenObject({
  ...entityPlaneChangesSchema.properties,
  changes: Type.Array(Type.Unknown()),
});
const extensionRequestWire = OpenObject({
  ...entityPlaneSystemExtensionRequestSchema.properties,
  entityRefs: Type.Array(Type.Unknown(), { maxItems: 100 }),
});
const sidecarWire = OpenObject({
  entityRef: Type.Unknown(),
  extension: Type.Unknown(),
  attributes: Type.Array(attributeAssignmentWireSchema),
});
const extensionResponseWire = OpenObject({
  ...entityPlaneSystemExtensionResponseSchema.properties,
  sidecars: Type.Array(Type.Unknown()),
});
const readResultWire = Type.Union([
  missingListEntryReadResultSchema,
  OpenObject({
    ...foundListEntryReadResultSchema.properties,
    entry: Type.Unknown(),
  }),
]);

function parseEntityPlaneChangeResource(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneChangeResource> {
  const parsed = parseContract(changeResourceWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const resource = parsed.value;
  switch (resource.kind) {
    case "entity_type": {
      const typeId = parseCommerceEntityTypeId(resource.typeId);
      if (!typeId.ok) return typeId;
      return { ok: true, value: { kind: resource.kind, typeId: typeId.value } };
    }
    case "entity": {
      const ref = parseEntityPlaneEntityReference(resource.ref);
      if (!ref.ok) return ref;
      if (ref.value.origin !== "custom") return cursorRefusal("parse");
      return { ok: true, value: { kind: resource.kind, ref: ref.value } };
    }
    case "custom_relationship": {
      const ref = parseEntityPlaneRelationshipReference(resource.ref);
      if (!ref.ok) return ref;
      if (ref.value.origin !== "custom") return cursorRefusal("parse");
      return { ok: true, value: { kind: resource.kind, ref: ref.value } };
    }
    case "commerce_list_entry": {
      const ref = parseCommerceListEntryRef(resource.ref);
      if (!ref.ok) return ref;
      return { ok: true, value: { kind: resource.kind, ref: ref.value } };
    }
    case "relationship_definition":
      return {
        ok: true,
        value: { kind: resource.kind, definitionId: resource.definitionId },
      };
    case "commerce_list":
      return {
        ok: true,
        value: { kind: resource.kind, listId: resource.listId },
      };
    case "saved_view":
      return {
        ok: true,
        value: { kind: resource.kind, viewId: resource.viewId },
      };
    default:
      return assertNever(resource);
  }
}
function parseEntityPlaneChange(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneChange> {
  const parsed = parseContract(changeWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const change = parsed.value;
  const resource = parseEntityPlaneChangeResource(change.resource);
  if (!resource.ok) return resource;
  return {
    ok: true,
    value: {
      changeId: change.changeId,
      merchantRevision: change.merchantRevision,
      resource: resource.value,
      operation: change.operation,
      createdAt: change.createdAt,
    },
  };
}
export function parseEntityPlaneChanges(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneChanges> {
  const parsed = parseContract(changesWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  const changes = parseContractArray(response.changes, parseEntityPlaneChange);
  if (!changes.ok) return changes;
  return {
    ok: true,
    value: {
      merchantId: response.merchantId,
      merchantRevision: response.merchantRevision,
      changes: changes.value,
      nextAfterMerchantRevision: response.nextAfterMerchantRevision,
      hasMore: response.hasMore,
    },
  };
}
export function parseEntityPlaneSystemExtensionRequest(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneSystemExtensionRequest> {
  const parsed = parseContract(extensionRequestWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const entityRefs = parseContractArray(
    request.entityRefs,
    parseSystemEntityRef,
  );
  if (!entityRefs.ok) return entityRefs;
  return {
    ok: true,
    value: {
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      entityRefs: entityRefs.value,
    },
  };
}
function parseSystemEntityRef(
  input: unknown,
): ContractDecodeResult<SystemCommerceEntityRef> {
  const parsed = parseEntityPlaneEntityReference(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.origin !== "system") return cursorRefusal("parse");
  return { ok: true, value: parsed.value };
}
function parseEntityPlaneSystemExtensionSidecar(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneSystemExtensionSidecar> {
  const parsed = parseContract(sidecarWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const sidecar = parsed.value;
  const entityRef = parseSystemEntityRef(sidecar.entityRef);
  if (!entityRef.ok) return entityRef;
  const extension = parseSystemEntityExtension(sidecar.extension);
  if (!extension.ok) return extension;
  const attributes: AttributeValueAssignment[] = [];
  for (const raw of sidecar.attributes) {
    const parsedAttribute = parseAssignment(raw);
    if (!parsedAttribute.ok) return parsedAttribute;
    const attribute = parsedAttribute.value;
    if (
      attribute.scope.kind !== "merchant_extension" ||
      attribute.scope.entityTypeId !== entityRef.value.typeId
    )
      return cursorRefusal("attribute_definition_mismatch", {
        attributeId: attribute.attributeId,
      });
    if (
      extension.value.state === "absent" ||
      Number(attribute.definitionRevision) !== Number(extension.value.revision)
    )
      return cursorRefusal("attribute_definition_mismatch", {
        attributeId: attribute.attributeId,
      });
    attributes.push(attribute);
  }
  return {
    ok: true,
    value: {
      entityRef: entityRef.value,
      extension: extension.value,
      attributes,
    },
  };
}
export function parseEntityPlaneSystemExtensionResponse(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneSystemExtensionResponse> {
  const parsed = parseContract(extensionResponseWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  const sidecars = parseContractArray(
    response.sidecars,
    parseEntityPlaneSystemExtensionSidecar,
  );
  if (!sidecars.ok) return sidecars;
  return {
    ok: true,
    value: {
      merchantId: response.merchantId,
      merchantRevision: response.merchantRevision,
      sidecars: sidecars.value,
    },
  };
}
export function parseListEntryReadRequest(
  input: unknown,
): ContractDecodeResult<CommerceListEntryReadRequest> {
  return parseContract(listEntryReadRequestSchema, input, invalidShape);
}
export function parseListEntryReadResult(
  input: unknown,
): ContractDecodeResult<CommerceListEntryReadResult> {
  const parsed = parseContract(readResultWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  if (result.kind === "missing")
    return { ok: true, value: { kind: "missing" } };
  const entry = parseCommerceListEntryShape(result.entry);
  if (!entry.ok) return entry;
  return {
    ok: true,
    value: {
      kind: "found",
      merchantRevision: result.merchantRevision,
      listRevision: result.listRevision,
      entry: entry.value,
    },
  };
}
