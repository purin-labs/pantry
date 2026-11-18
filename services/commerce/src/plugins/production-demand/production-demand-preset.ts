import {
  parseCommerceList,
  parseSavedCommerceView,
} from "../../entity-plane/parsers.ts";
import type { EntityPlanePresetBundle } from "../../entity-plane/presets.ts";

const fields = [
  {
    id: "status",
    label: "Status",
    kind: {
      kind: "status",
      options: [
        { id: "requested", label: "Requested" },
        { id: "accepted", label: "Accepted" },
        { id: "scheduled", label: "Scheduled" },
      ],
    },
  },
  {
    id: "recipe_id",
    label: "Recipe",
    kind: { kind: "short_text", maxLength: 256 },
  },
  {
    id: "recipe_revision",
    label: "Recipe revision",
    kind: { kind: "integer", minimum: 1, maximum: null },
  },
  {
    id: "location_id",
    label: "Destination",
    kind: { kind: "short_text", maxLength: 256 },
  },
  {
    id: "requested_quantity",
    label: "Requested output",
    kind: { kind: "decimal", scale: 6, minimum: null, maximum: null },
  },
  {
    id: "quantity_unit",
    label: "Unit",
    kind: { kind: "short_text", maxLength: 40 },
  },
  { id: "needed_by", label: "Needed by", kind: { kind: "timestamp" } },
];

export const PRODUCTION_DEMAND_LIST = parseCommerceList({
  listId: "production_requests",
  entityTypeId: { origin: "system", typeId: "inventory_item" },
  name: "Production requests",
  membership: "repeatable_entity",
  entryAttributeDefinitions: fields.map(productionAttribute),
  publishedRevision: 1,
});

export const PRODUCTION_DEMAND_PRESET: EntityPlanePresetBundle = {
  definitions: [],
  relationshipDefinitions: [],
  lists: [PRODUCTION_DEMAND_LIST],
  views: [
    parseSavedCommerceView({
      viewId: "production_requests",
      name: "Production requests",
      source: { kind: "commerce_list", listId: "production_requests" },
      filter: { kind: "all" },
      sorts: [],
      visibleAttributeIds: [
        "status",
        "requested_quantity",
        "quantity_unit",
        "needed_by",
        "recipe_id",
        "location_id",
      ],
      relationshipColumns: [],
      grouping: { attributeId: "status", descending: false },
      presentation: {
        kind: "board",
        configuration: {
          laneAttributeId: "status",
          cardAttributeIds: [
            "requested_quantity",
            "quantity_unit",
            "needed_by",
          ],
        },
      },
      revision: 1,
    }),
  ],
};

function productionAttribute(field: (typeof fields)[number]) {
  return {
    attributeId: field.id,
    definition: {
      id: field.id,
      scope: {
        kind: "system",
        entityTypeId: "inventory_item",
        schemaRevision: 1,
      },
      label: field.label,
      helpText: null,
      required: true,
      sensitivity: "internal",
      kind: field.kind,
      revision: 1,
    },
  };
}
