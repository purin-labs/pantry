import { selectorContextSelectionSchema } from "./graph-query-schema.ts";
import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revision,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cleanValue } from "@purin-labs/contract-schema/sorted-unions";
import { assertNever } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import {
  commerceEntityRefWireSchema,
  commerceEntityTypeWireSchema,
  commerceGraphQueryWireSchema,
  relationshipDefinitionWireSchema,
} from "./query-wire.ts";
import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";
import {
  commerceEntityTypeIdSchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  queryIdentitySchema,
  parseCommerceEntityTypeId,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import {
  relationshipDefinitionRefSchema,
  parseRelationshipDefinitionRef,
} from "./query-filter.ts";
import { commerceRelationshipRefSchema } from "./relationships.ts";
import {
  relationshipRefWireSchema,
  parseCommerceRelationshipRef,
} from "./relationship-commands.ts";

import { parseCommerceContextSelection } from "./graph-query.ts";
import { revisionSchema } from "./entity-record.ts";

import { cursorRefusal } from "./cursor-values.ts";

export const commerceListEntryRefSchema = OpenObject({
  entryId: queryIdentitySchema<"CommerceListEntryId">(),
  listId: commerceListIdSchema,
  revision: revisionSchema<"CommerceListEntryRevision">(),
});

const entityTypeAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("entity_type"),
  entityTypeId: commerceEntityTypeWireSchema,
});
const entityAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("entity"),
  entityRef: commerceEntityRefWireSchema,
});
const relationshipDefinitionAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("relationship_definition"),
  relationshipDefinition: relationshipDefinitionWireSchema,
});
const relationshipAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("relationship"),
  relationship: relationshipRefWireSchema,
});
const commerceListAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("commerce_list"),
  listId: Type.String(),
});
export const commerceListEntryAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("commerce_list_entry"),
  entry: OpenObject({
    entryId: Type.String(),
    listId: Type.String(),
    revision,
  }),
});
const savedSelectorAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("saved_selector"),
  selector: OpenObject({
    selectorId: Type.String(),
    revision,
    query: commerceGraphQueryWireSchema,
  }),
});
const savedViewAuthorityScopeWireSchema = OpenObject({
  kind: Type.Literal("saved_view"),
  viewId: Type.String(),
});
export const commerceAuthorityScopeWireSchema = Type.Union([
  entityTypeAuthorityScopeWireSchema,
  entityAuthorityScopeWireSchema,
  relationshipDefinitionAuthorityScopeWireSchema,
  relationshipAuthorityScopeWireSchema,
  commerceListAuthorityScopeWireSchema,
  commerceListEntryAuthorityScopeWireSchema,
  savedSelectorAuthorityScopeWireSchema,
  savedViewAuthorityScopeWireSchema,
]);
const entityTypeAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("entity_type"),
  entityTypeId: commerceEntityTypeIdSchema,
});
const entityAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("entity"),
  entityRef: commerceEntityRefSchema,
});
const relationshipDefinitionAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("relationship_definition"),
  relationshipDefinition: relationshipDefinitionRefSchema,
});
const relationshipAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("relationship"),
  relationship: commerceRelationshipRefSchema,
});
export const commerceListAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("commerce_list"),
  listId: commerceListIdSchema,
});
export const commerceListEntryAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("commerce_list_entry"),
  entry: commerceListEntryRefSchema,
});
const savedSelectorAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("saved_selector"),
  selector: selectorContextSelectionSchema.properties.selector,
});
export const savedViewAuthorityScopeSchema = OpenObject({
  kind: Type.Literal("saved_view"),
  viewId: savedCommerceViewIdSchema,
});
export const commerceAuthorityScopeSchema = Type.Union([
  entityTypeAuthorityScopeSchema,
  entityAuthorityScopeSchema,
  relationshipDefinitionAuthorityScopeSchema,
  relationshipAuthorityScopeSchema,
  commerceListAuthorityScopeSchema,
  commerceListEntryAuthorityScopeSchema,
  savedSelectorAuthorityScopeSchema,
  savedViewAuthorityScopeSchema,
]);
export type CommerceAuthorityScope = StrictUnion<
  Static<typeof commerceAuthorityScopeSchema>
>;
export type CommerceListEntryRef = Static<typeof commerceListEntryRefSchema>;
export function parseCommerceAuthorityScope(
  input: unknown,
): ContractDecodeResult<CommerceAuthorityScope> {
  const parsed = parseContract(
    commerceAuthorityScopeWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const scope = parsed.value;
  switch (scope.kind) {
    case "entity_type": {
      const entityTypeId = parseCommerceEntityTypeId(scope.entityTypeId);
      if (!entityTypeId.ok) return entityTypeId;
      return {
        ok: true,
        value: { kind: scope.kind, entityTypeId: entityTypeId.value },
      };
    }
    case "entity": {
      const entityRef = parseCommerceEntityRef(scope.entityRef);
      if (!entityRef.ok) return entityRef;
      return {
        ok: true,
        value: { kind: scope.kind, entityRef: entityRef.value },
      };
    }
    case "relationship_definition": {
      const definition = parseRelationshipDefinitionRef(
        scope.relationshipDefinition,
      );
      if (!definition.ok) return definition;
      return {
        ok: true,
        value: { kind: scope.kind, relationshipDefinition: definition.value },
      };
    }
    case "relationship": {
      const relationship = parseCommerceRelationshipRef(scope.relationship);
      if (!relationship.ok) return relationship;
      return {
        ok: true,
        value: { kind: scope.kind, relationship: relationship.value },
      };
    }
    case "commerce_list": {
      const listId = scope.listId;
      if (!Value.Check(commerceListIdSchema, listId))
        return identityRefusal("CommerceListId");
      return { ok: true, value: { kind: scope.kind, listId } };
    }
    case "commerce_list_entry": {
      const entry = parseCommerceListEntryRef(scope.entry);
      if (!entry.ok) return entry;
      return { ok: true, value: { kind: scope.kind, entry: entry.value } };
    }
    case "saved_selector": {
      const selection = parseCommerceContextSelection({
        kind: "selector",
        selector: scope.selector,
      });
      if (!selection.ok) return selection;
      if (selection.value.kind !== "selector") return cursorRefusal("parse");
      return {
        ok: true,
        value: { kind: scope.kind, selector: selection.value.selector },
      };
    }
    case "saved_view": {
      const viewId = scope.viewId;
      if (!Value.Check(savedCommerceViewIdSchema, viewId))
        return identityRefusal("SavedCommerceViewId");
      return { ok: true, value: { kind: scope.kind, viewId } };
    }
    default:
      return assertNever(scope);
  }
}

export function parseCommerceListEntryRef(
  input: unknown,
): ContractDecodeResult<CommerceListEntryRef> {
  const raw = parseContract(
    commerceListEntryAuthorityScopeWireSchema.properties.entry,
    input,
    invalidShape,
  );
  if (!raw.ok) return raw;
  const entry = raw.value;
  if (
    !Value.Check(commerceListEntryRefSchema.properties.entryId, entry.entryId)
  )
    return identityRefusal("CommerceListEntryId");
  if (!Value.Check(commerceListIdSchema, entry.listId))
    return identityRefusal("CommerceListId");
  if (entry.revision === 0)
    return cursorRefusal("invalid_revision", {
      field: "CommerceListEntryRevision",
    });
  return parseContract(
    commerceListEntryRefSchema,
    cleanValue(commerceListEntryRefSchema, Value.Clone(entry)),
    invalidShape,
  );
}
