import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revisionWire,
} from "@purin-labs/contract-schema";
import { Type, type Static, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { compareCodePoints } from "@purin-labs/std";
import {
  attributeDefinitionSchema,
  parseAttributeDefinition,
  validateDefinedAttribute,
  definitionMismatch,
  invalidValue,
  type AttributeDefinition,
} from "./attribute-definition.ts";
import {
  attributeValueAssignmentSchema,
  parseAssignment,
  revisionSchema,
} from "./entity-record.ts";
import {
  attributeDefinitionWireSchema,
  attributeAssignmentWireSchema,
  type AttributeAssignmentWire,
} from "./entity-wire.ts";
import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
  type CommerceEntityRef,
} from "./entity-reference.ts";
import type { AttributeValue } from "./attribute-value.ts";
import {
  commerceEntityRefWireSchema,
  commerceEntityTypeWireSchema,
} from "./query-wire.ts";
import {
  commerceListIdSchema,
  commerceEntityTypeIdSchema,
  attributeDefinitionIdSchema,
  queryIdentitySchema,
  parseCommerceEntityTypeId,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";

import { cursorRefusal } from "./cursor-values.ts";

const entryIdSchema = queryIdentitySchema<"CommerceListEntryId">();
const listNameSchema = queryIdentitySchema<"CommerceListName">();
const listRevisionSchema = revisionSchema<"CommerceListRevision">();
const entryRevisionSchema = revisionSchema<"CommerceListEntryRevision">();

const commerceListMembershipSchema = Type.Enum([
  "unique_entity",
  "repeatable_entity",
]);
const listEntryAttributeDefinitionSchema = OpenObject({
  attributeId: attributeDefinitionIdSchema,
  definition: attributeDefinitionSchema,
});
export const listEntryAttributeValueSchema = StrictObject({
  ...attributeValueAssignmentSchema.properties,
  value: Type.Readonly(
    Type.Unsafe<AttributeValue>(
      attributeValueAssignmentSchema.properties.value,
    ),
  ),
});
export type ListEntryAttributeDefinition = Static<
  typeof listEntryAttributeDefinitionSchema
>;
export type ListEntryAttributeValue = StaticDecode<
  typeof listEntryAttributeValueSchema
>;
export const commerceListSchema = OpenObject({
  listId: commerceListIdSchema,
  entityTypeId: commerceEntityTypeIdSchema,
  name: listNameSchema,
  entryAttributeDefinitions: Type.Array(listEntryAttributeDefinitionSchema),
  publishedRevision: listRevisionSchema,
  membership: commerceListMembershipSchema,
});
export const commerceListEntrySchema = OpenObject({
  entryId: entryIdSchema,
  listId: commerceListIdSchema,
  listRevision: listRevisionSchema,
  entityRef: Type.Unsafe<CommerceEntityRef>(commerceEntityRefSchema),
  attributeValues: Type.Array(listEntryAttributeValueSchema),
  revision: entryRevisionSchema,
});
export type CommerceList = Static<typeof commerceListSchema>;
export type CommerceListEntry = StaticDecode<typeof commerceListEntrySchema>;

const definitionWire = OpenObject({
  attributeId: Type.String(),
  definition: attributeDefinitionWireSchema,
});
export const commerceListWireSchema = OpenObject({
  listId: Type.String(),
  entityTypeId: commerceEntityTypeWireSchema,
  name: Type.String(),
  entryAttributeDefinitions: Type.Array(definitionWire),
  publishedRevision: revisionWire,
  membership: commerceListMembershipSchema,
});
const commerceListEntryWireSchema = OpenObject({
  entryId: Type.String(),
  listId: Type.String(),
  listRevision: revisionWire,
  entityRef: commerceEntityRefWireSchema,
  attributeValues: Type.Array(attributeAssignmentWireSchema),
  revision: revisionWire,
});
const entryRequest = StrictObject({
  entry: Type.Unknown(),
  list: Type.Unknown(),
});

export function parseCommerceList(
  input: unknown,
): ContractDecodeResult<CommerceList> {
  const parsed = parseContract(commerceListWireSchema, input, invalidShape);
  if (!parsed.ok) return parsed;
  const list = parsed.value;
  const listId = list.listId;
  if (!Value.Check(commerceListIdSchema, listId))
    return identityRefusal("CommerceListId");
  const entityType = parseCommerceEntityTypeId(list.entityTypeId);
  if (!entityType.ok) return entityType;
  const name = list.name;
  if (!Value.Check(listNameSchema, name))
    return identityRefusal("CommerceListName");
  const publishedRevision = list.publishedRevision;
  if (!Value.Check(listRevisionSchema, publishedRevision))
    return invalidRevision("CommerceListRevision");

  const definitions: {
    attributeId: string;
    definition: AttributeDefinition;
  }[] = [];
  const seen = new Set<string>();
  for (const raw of list.entryAttributeDefinitions) {
    const definition = parseAttributeDefinition(raw.definition);
    if (!definition.ok) return definition;
    if (seen.has(definition.value.id))
      return cursorRefusal("duplicate_identity");
    seen.add(definition.value.id);
    definitions.push({
      attributeId: raw.attributeId,
      definition: definition.value,
    });
  }
  const entryAttributeDefinitions: ListEntryAttributeDefinition[] = [];
  for (const item of definitions) {
    const attributeId = item.attributeId;
    if (!Value.Check(attributeDefinitionIdSchema, attributeId))
      return identityRefusal("AttributeDefinitionId");
    if (attributeId !== item.definition.id)
      return definitionMismatch(attributeId);
    const scope = item.definition.scope;
    if (
      scope.entityTypeId !== entityType.value.typeId ||
      (scope.kind === "custom") !== (entityType.value.origin === "custom")
    )
      return definitionMismatch(attributeId);
    entryAttributeDefinitions.push({
      attributeId,
      definition: item.definition,
    });
  }
  return {
    ok: true,
    value: {
      listId,
      entityTypeId: entityType.value,
      name,
      entryAttributeDefinitions,
      publishedRevision,
      membership: list.membership,
    },
  };
}

export function parseListEntryAttributeValues(
  inputs: AttributeAssignmentWire[],
): ContractDecodeResult<ListEntryAttributeValue[]> {
  const values: ListEntryAttributeValue[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const parsed = parseAssignment(input);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.attributeId))
      return cursorRefusal("duplicate_identity");
    seen.add(parsed.value.attributeId);
    values.push(parsed.value);
  }
  return { ok: true, value: values };
}

export function parseCommerceListEntryShape(
  input: unknown,
): ContractDecodeResult<CommerceListEntry> {
  const parsed = parseContract(
    commerceListEntryWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const entry = parsed.value;
  const entryId = entry.entryId;
  if (!Value.Check(entryIdSchema, entryId))
    return identityRefusal("CommerceListEntryId");
  const listId = entry.listId;
  if (!Value.Check(commerceListIdSchema, listId))
    return identityRefusal("CommerceListId");
  const listRevision = entry.listRevision;
  if (!Value.Check(listRevisionSchema, listRevision))
    return invalidRevision("CommerceListRevision");
  const entityRef = parseCommerceEntityRef(entry.entityRef);
  if (!entityRef.ok) return entityRef;
  const revision = entry.revision;
  if (!Value.Check(entryRevisionSchema, revision))
    return invalidRevision("CommerceListEntryRevision");
  const values = parseListEntryAttributeValues(entry.attributeValues);
  if (!values.ok) return values;
  return {
    ok: true,
    value: {
      entryId,
      listId,
      listRevision,
      entityRef: entityRef.value,
      attributeValues: values.value,
      revision,
    },
  };
}

export function parseCommerceListEntry(
  input: unknown,
): ContractDecodeResult<CommerceListEntry> {
  const request = parseContract(entryRequest, input, invalidRequest);
  if (!request.ok) return request;
  const list = parseCommerceList(request.value.list);
  if (!list.ok) return list;
  const parsed = parseContract(
    commerceListEntryWireSchema,
    request.value.entry,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const entry = parsed.value;
  if (
    entry.listId !== list.value.listId ||
    entry.listRevision !== list.value.publishedRevision
  )
    return cursorRefusal("revision_conflict", {
      expected: list.value.publishedRevision,
      received: entry.listRevision,
    });
  const entryId = entry.entryId;
  if (!Value.Check(entryIdSchema, entryId))
    return identityRefusal("CommerceListEntryId");
  const entityRef = parseCommerceEntityRef(entry.entityRef);
  if (!entityRef.ok) return entityRef;
  const revision = entry.revision;
  if (!Value.Check(entryRevisionSchema, revision))
    return invalidRevision("CommerceListEntryRevision");
  if (
    entityRef.value.origin !== list.value.entityTypeId.origin ||
    entityRef.value.typeId !== list.value.entityTypeId.typeId
  )
    return cursorRefusal("invalid_list_entry_entity_type");
  const definitions = new Map<string, ListEntryAttributeDefinition>();
  for (const definition of list.value.entryAttributeDefinitions)
    definitions.set(definition.attributeId, definition);
  const attributeValues: ListEntryAttributeValue[] = [];
  const seen = new Set<string>();
  for (const input of entry.attributeValues) {
    if (seen.has(input.attributeId)) return cursorRefusal("duplicate_identity");
    seen.add(input.attributeId);
    const definition = definitions.get(input.attributeId);
    if (definition === undefined) return definitionMismatch(input.attributeId);
    const value = parseAssignment(input);
    if (!value.ok) return value;
    const valid = validateDefinedAttribute(value.value, definition.definition);
    if (!valid.ok) return valid;
    attributeValues.push(value.value);
  }
  for (const id of [...definitions.keys()].sort(compareCodePoints)) {
    const definition = definitions.get(id)!;
    if (definition.definition.required && !seen.has(id))
      return invalidValue(id);
  }
  return {
    ok: true,
    value: {
      entryId,
      listId: list.value.listId,
      listRevision: list.value.publishedRevision,
      entityRef: entityRef.value,
      attributeValues,
      revision,
    },
  };
}

function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}
function invalidRequest() {
  return {
    code: "invalid_request",
    reason: "invalid list entry request",
    details: null,
  };
}
