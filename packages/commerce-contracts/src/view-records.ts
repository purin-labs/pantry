import {
  StrictObject,
  NonNegativeInteger,
  parseContract,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever, canonicalJsonByCodePoint } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import {
  commerceFilterSchema,
  relationshipDefinitionRefSchema,
  parseCommerceFilter,
  parseRelationshipDefinitionRef,
  type CommerceFilter,
} from "./query-filter.ts";
import {
  commerceFilterWireSchema,
  commerceEntityTypeWireSchema,
  relationshipDefinitionWireSchema,
} from "./query-wire.ts";
import {
  attributeDefinitionIdSchema,
  commerceEntityTypeIdSchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  queryIdentitySchema,
  parseCommerceEntityTypeId,
  parseSorts,
  sortWire,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import { commerceSortSchema } from "./query-ordering.ts";
import { revisionSchema } from "./entity-record.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { cursorRefusal } from "./cursor-values.ts";

export const savedCommerceViewSourceSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("entity_type"),
    entityTypeId: commerceEntityTypeIdSchema,
  }),
  StrictObject({
    kind: Type.Literal("commerce_list"),
    listId: commerceListIdSchema,
  }),
]);
export const visibleRelationshipColumnSchema = StrictObject({
  relationshipDefinition: relationshipDefinitionRefSchema,
  label: Type.String(),
});
export const commerceGroupingSchema = StrictObject({
  attributeId: attributeDefinitionIdSchema,
  descending: Type.Boolean(),
});
export const commerceTableDensitySchema = Type.Enum([
  "compact",
  "comfortable",
  "spacious",
]);
export const commerceTableViewConfigurationSchema = StrictObject({
  density: commerceTableDensitySchema,
  showRowNumbers: Type.Boolean(),
});
export const commerceBoardViewConfigurationSchema = StrictObject({
  laneAttributeId: attributeDefinitionIdSchema,
  cardAttributeIds: Type.Array(attributeDefinitionIdSchema, {
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
  }),
});
export const tableViewPresentationSchema = StrictObject({
  kind: Type.Literal("table"),
  configuration: commerceTableViewConfigurationSchema,
});
export const boardViewPresentationSchema = StrictObject({
  kind: Type.Literal("board"),
  configuration: commerceBoardViewConfigurationSchema,
});
export const commerceViewPresentationSchema = Type.Union([
  tableViewPresentationSchema,
  boardViewPresentationSchema,
]);
const viewNameSchema = queryIdentitySchema<"CommerceViewName">();
const viewRevisionSchema = revisionSchema<"SavedCommerceViewRevision">();
export const savedCommerceViewSchema = StrictObject({
  viewId: savedCommerceViewIdSchema,
  name: viewNameSchema,
  source: Type.Unsafe<SavedCommerceViewSource>(savedCommerceViewSourceSchema),
  filter: Type.Unsafe<CommerceFilter>(commerceFilterSchema),
  sorts: Type.Array(commerceSortSchema, { maxItems: 8 }),
  visibleAttributeIds: Type.Array(attributeDefinitionIdSchema, {
    minItems: 1,
    maxItems: 64,
    uniqueItems: true,
  }),
  relationshipColumns: Type.Array(visibleRelationshipColumnSchema, {
    maxItems: 16,
  }),
  grouping: Type.Union([commerceGroupingSchema, Type.Null()]),
  presentation: Type.Unsafe<CommerceViewPresentation>(
    commerceViewPresentationSchema,
  ),
  revision: viewRevisionSchema,
});
export type SavedCommerceView = Static<typeof savedCommerceViewSchema>;
export type SavedCommerceViewSource = StrictUnion<
  Static<typeof savedCommerceViewSourceSchema>
>;
export type VisibleRelationshipColumn = Static<
  typeof visibleRelationshipColumnSchema
>;
export type CommerceGrouping = Static<typeof commerceGroupingSchema>;
export type CommerceTableDensity = Static<typeof commerceTableDensitySchema>;
export type CommerceTableViewConfiguration = Static<
  typeof commerceTableViewConfigurationSchema
>;
export type CommerceBoardViewConfiguration = Static<
  typeof commerceBoardViewConfigurationSchema
>;
export type CommerceViewPresentation = StrictUnion<
  Static<typeof commerceViewPresentationSchema>
>;

const sourceWire = Type.Union([
  StrictObject({
    kind: Type.Literal("entity_type"),
    entityTypeId: commerceEntityTypeWireSchema,
  }),
  StrictObject({ kind: Type.Literal("commerce_list"), listId: Type.String() }),
]);
const columnWire = StrictObject({
  relationshipDefinition: relationshipDefinitionWireSchema,
  label: Type.String(),
});
const groupingWire = StrictObject({
  attributeId: Type.String(),
  descending: Type.Boolean(),
});
const presentationWire = Type.Union([
  tableViewPresentationSchema,
  StrictObject({
    kind: Type.Literal("board"),
    configuration: StrictObject({
      laneAttributeId: Type.String(),
      cardAttributeIds: Type.Array(Type.String()),
    }),
  }),
]);
export const savedCommerceViewWireSchema = StrictObject({
  viewId: Type.String(),
  name: Type.String(),
  source: sourceWire,
  filter: commerceFilterWireSchema,
  sorts: Type.Array(sortWire),
  visibleAttributeIds: Type.Array(Type.String()),
  relationshipColumns: Type.Array(columnWire),
  grouping: Type.Optional(Type.Union([groupingWire, Type.Null()])),
  presentation: presentationWire,
  revision: NonNegativeInteger,
});

export function parseSavedCommerceView(
  input: unknown,
): ContractDecodeResult<SavedCommerceView> {
  const parsed = parseContract(
    savedCommerceViewWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const view = parsed.value;
  const viewId = view.viewId;
  if (!Value.Check(savedCommerceViewIdSchema, viewId))
    return identityRefusal("SavedCommerceViewId");
  const name = view.name;
  if (!Value.Check(viewNameSchema, name))
    return identityRefusal("CommerceViewName");
  const source = parseViewSource(view.source);
  if (!source.ok) return source;
  const filter = parseCommerceFilter(view.filter);
  if (!filter.ok) return filter;
  if (view.sorts.length > 8) return invalidPresentation();
  const sorts = parseSorts(view.sorts);
  if (!sorts.ok) return sorts;
  if (
    view.visibleAttributeIds.length === 0 ||
    view.visibleAttributeIds.length > 64
  )
    return invalidPresentation();
  const visible = parseAttributeIds(view.visibleAttributeIds);
  if (!visible.ok) return visible;
  if (view.relationshipColumns.length > 16) return invalidPresentation();
  const relationshipColumns: VisibleRelationshipColumn[] = [];
  const seen = new Set<string>();
  for (const column of view.relationshipColumns) {
    const reference = parseRelationshipDefinitionRef(
      column.relationshipDefinition,
    );
    if (!reference.ok) return reference;
    if (!Value.Check(trimmedIdentityTextSchema, column.label))
      return cursorRefusal("invalid_text", {
        field: "visible_relationship_column.label",
      });
    const key = canonicalJsonByCodePoint(reference.value);
    if (seen.has(key)) return cursorRefusal("duplicate_identity");
    seen.add(key);
    relationshipColumns.push({
      relationshipDefinition: reference.value,
      label: column.label,
    });
  }
  const grouping = parseGrouping(view.grouping ?? null);
  if (!grouping.ok) return grouping;
  const presentation = parsePresentation(view.presentation);
  if (!presentation.ok) return presentation;
  const revision = view.revision;
  if (!Value.Check(viewRevisionSchema, revision))
    return cursorRefusal("invalid_revision", {
      field: "SavedCommerceViewRevision",
    });
  if (
    presentation.value.kind === "board" &&
    source.value.kind === "entity_type"
  )
    return cursorRefusal("invalid_view_source");
  return {
    ok: true,
    value: {
      viewId,
      name,
      source: source.value,
      filter: filter.value,
      sorts: sorts.value,
      visibleAttributeIds: visible.value,
      relationshipColumns,
      grouping: grouping.value,
      presentation: presentation.value,
      revision,
    },
  };
}

function parseViewSource(
  source: Static<typeof sourceWire>,
): ContractDecodeResult<SavedCommerceViewSource> {
  switch (source.kind) {
    case "entity_type": {
      const entityTypeId = parseCommerceEntityTypeId(source.entityTypeId);
      if (!entityTypeId.ok) return entityTypeId;
      return {
        ok: true,
        value: { kind: source.kind, entityTypeId: entityTypeId.value },
      };
    }
    case "commerce_list": {
      const listId = source.listId;
      if (!Value.Check(commerceListIdSchema, listId))
        return identityRefusal("CommerceListId");
      return { ok: true, value: { kind: source.kind, listId } };
    }
    default:
      return assertNever(source);
  }
}
function parseAttributeIds(
  inputs: string[],
): ContractDecodeResult<Static<typeof attributeDefinitionIdSchema>[]> {
  const ids: Static<typeof attributeDefinitionIdSchema>[] = [];
  const seen = new Set<string>();
  for (const id of inputs) {
    if (!Value.Check(attributeDefinitionIdSchema, id))
      return identityRefusal("AttributeDefinitionId");
    if (seen.has(id)) return cursorRefusal("duplicate_identity");
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, value: ids };
}
function parseGrouping(
  input: Static<typeof groupingWire> | null,
): ContractDecodeResult<CommerceGrouping | null> {
  if (input === null) return { ok: true, value: null };
  const attributeId = input.attributeId;
  if (!Value.Check(attributeDefinitionIdSchema, attributeId))
    return identityRefusal("AttributeDefinitionId");
  return { ok: true, value: { attributeId, descending: input.descending } };
}
function parsePresentation(
  presentation: Static<typeof presentationWire>,
): ContractDecodeResult<CommerceViewPresentation> {
  if (presentation.kind === "table")
    return {
      ok: true,
      value: {
        kind: presentation.kind,
        configuration: {
          density: presentation.configuration.density,
          showRowNumbers: presentation.configuration.showRowNumbers,
        },
      },
    };
  const laneAttributeId = presentation.configuration.laneAttributeId;
  if (!Value.Check(attributeDefinitionIdSchema, laneAttributeId))
    return identityRefusal("AttributeDefinitionId");
  const rawIds = presentation.configuration.cardAttributeIds;
  if (rawIds.length === 0 || rawIds.length > 16) return invalidPresentation();
  const ids = parseAttributeIds(rawIds);
  if (!ids.ok) return ids;
  return {
    ok: true,
    value: {
      kind: presentation.kind,
      configuration: { laneAttributeId, cardAttributeIds: ids.value },
    },
  };
}
function invalidPresentation(): ContractDecodeResult<never> {
  return cursorRefusal("invalid_view_presentation");
}
