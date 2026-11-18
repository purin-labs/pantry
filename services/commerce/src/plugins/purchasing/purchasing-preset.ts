import {
  parseCommerceList,
  parseRelationshipDefinition,
  parseSavedCommerceView,
} from "../../entity-plane/parsers.ts";
import {
  TRADE_PARTNER_TYPE,
  type EntityPlanePresetBundle,
} from "../../entity-plane/presets.ts";
import {
  REPLENISHMENT_QUEUE_LIST_ID,
  REPLENISHMENT_QUEUE_VIEW_ID,
  SUPPLIER_DIRECTORY_LIST_ID,
  SUPPLIER_ENTITY_TYPE_ID,
  SUPPLIER_INVENTORY_ITEM_DEFINITION_ID,
  SUPPLIERS_VIEW_ID,
  SUPPLY_COST_TERMS_LIST_ID,
  SUPPLY_COST_TERMS_VIEW_ID,
} from "@seams/commerce-client";

export {
  REPLENISHMENT_QUEUE_LIST_ID,
  SUPPLIER_DIRECTORY_LIST_ID,
  SUPPLY_COST_TERMS_LIST_ID,
};

const SUPPLIER_INVENTORY_ITEM_DEFINITION = parseRelationshipDefinition({
  origin: "custom",
  definitionId: SUPPLIER_INVENTORY_ITEM_DEFINITION_ID,
  sourceType: { origin: "custom", typeId: SUPPLIER_ENTITY_TYPE_ID },
  targetType: { origin: "system", typeId: "inventory_item" },
  sourceLabel: "Supplied items",
  inverseLabel: "Suppliers",
  cardinality: "many_to_many",
  deletionBehavior: "detach",
  sensitivity: "internal",
  revision: 1,
});

export const SUPPLIER_DIRECTORY = parseCommerceList({
  listId: SUPPLIER_DIRECTORY_LIST_ID,
  entityTypeId: { origin: "custom", typeId: SUPPLIER_ENTITY_TYPE_ID },
  name: "Supplier Directory",
  membership: "unique_entity",
  entryAttributeDefinitions: [
    supplierAttribute("contact_name", "Contact", shortText(160), false),
    supplierAttribute("email", "Email", shortText(254), false),
    supplierAttribute("phone", "Phone", shortText(80), false),
    supplierAttribute(
      "lead_time_days",
      "Lead time (days)",
      integer(0, 365),
      true,
    ),
    supplierAttribute(
      "minimum_order_quantity",
      "Minimum order",
      decimal(3),
      false,
    ),
    supplierAttribute(
      "minimum_order_unit",
      "Minimum order unit",
      shortText(40),
      false,
    ),
    supplierAttribute(
      "purchasing_notes",
      "Purchasing notes",
      longText(1_000),
      false,
    ),
  ],
  publishedRevision: 1,
});

export const REPLENISHMENT_QUEUE = parseCommerceList({
  listId: REPLENISHMENT_QUEUE_LIST_ID,
  entityTypeId: { origin: "system", typeId: "stock_policy" },
  name: "Replenishment Queue",
  membership: "repeatable_entity",
  entryAttributeDefinitions: [
    replenishmentAttribute(
      "status",
      "Status",
      status([
        ["needs_review", "Needs review"],
        ["requested", "Requested"],
        ["expected", "Expected"],
        ["partial", "Partial"],
        ["late", "Late"],
        ["received", "Received"],
      ]),
      true,
    ),
    replenishmentAttribute("supplier_id", "Supplier", shortText(256), true),
    replenishmentAttribute("owner", "Owner", shortText(160), true),
    replenishmentAttribute(
      "inventory_item_id",
      "Inventory item",
      shortText(256),
      true,
    ),
    replenishmentAttribute("location_id", "Location", shortText(256), true),
    replenishmentAttribute("opened_at", "Opened", { kind: "timestamp" }, true),
    replenishmentAttribute("available_quantity", "Available", decimal(6), true),
    replenishmentAttribute("reorder_point", "Reorder point", decimal(6), true),
    replenishmentAttribute("target_quantity", "Target", decimal(6), true),
    replenishmentAttribute("required_quantity", "Required", decimal(6), true),
    replenishmentAttribute(
      "received_quantity",
      "Received quantity",
      decimal(6),
      true,
    ),
    replenishmentAttribute("quantity_unit", "Unit", shortText(40), true),
    replenishmentAttribute(
      "purchase_request_id",
      "Purchase request",
      shortText(256),
      false,
    ),
    replenishmentAttribute(
      "expected_delivery_at",
      "Expected delivery",
      { kind: "timestamp" },
      false,
    ),
    replenishmentAttribute("closed_at", "Closed", { kind: "timestamp" }, false),
    replenishmentAttribute("notes", "Notes", longText(1_000), false),
  ],
  publishedRevision: 1,
});

const SUPPLIER_DIRECTORY_VIEW = parseSavedCommerceView({
  viewId: SUPPLIERS_VIEW_ID,
  name: "Suppliers",
  source: { kind: "commerce_list", listId: SUPPLIER_DIRECTORY_LIST_ID },
  filter: { kind: "all" },
  sorts: [{ field: { kind: "display_name" }, direction: "ascending" }],
  visibleAttributeIds: [
    "contact_name",
    "email",
    "phone",
    "lead_time_days",
    "minimum_order_quantity",
    "minimum_order_unit",
  ],
  relationshipColumns: [
    {
      relationshipDefinition: {
        origin: "custom",
        definitionId: SUPPLIER_INVENTORY_ITEM_DEFINITION_ID,
        revision: 1,
      },
      label: "Supplied items",
    },
  ],
  grouping: null,
  presentation: {
    kind: "table",
    configuration: { density: "comfortable", showRowNumbers: false },
  },
  revision: 1,
});

const REPLENISHMENT_QUEUE_VIEW = parseSavedCommerceView({
  viewId: REPLENISHMENT_QUEUE_VIEW_ID,
  name: "Replenishment Queue",
  source: { kind: "commerce_list", listId: REPLENISHMENT_QUEUE_LIST_ID },
  filter: {
    kind: "attribute",
    filter: {
      attributeId: "status",
      operator: "not_equals",
      value: { kind: "status", value: "received" },
    },
  },
  sorts: [
    {
      field: { kind: "attribute", attributeId: "opened_at" },
      direction: "ascending",
    },
  ],
  visibleAttributeIds: [
    "status",
    "supplier_id",
    "owner",
    "required_quantity",
    "received_quantity",
    "quantity_unit",
    "expected_delivery_at",
  ],
  relationshipColumns: [],
  grouping: { attributeId: "status", descending: false },
  presentation: {
    kind: "board",
    configuration: {
      laneAttributeId: "status",
      cardAttributeIds: [
        "supplier_id",
        "owner",
        "required_quantity",
        "received_quantity",
        "quantity_unit",
        "expected_delivery_at",
      ],
    },
  },
  revision: 1,
});

export const SUPPLY_COST_TERMS = parseCommerceList({
  listId: SUPPLY_COST_TERMS_LIST_ID,
  entityTypeId: { origin: "system", typeId: "inventory_item" },
  name: "Supply Cost Terms",
  membership: "unique_entity",
  entryAttributeDefinitions: [
    supplyCostAttribute("currency", "Currency", shortText(16), true),
    supplyCostAttribute("pack_quantity", "Pack quantity", decimal(6), true),
    supplyCostAttribute("pack_unit", "Pack unit", shortText(40), true),
    supplyCostAttribute(
      "pack_price_minor",
      "Pack price (minor)",
      integer(0, 1_000_000_000),
      true,
    ),
    supplyCostAttribute("supplier_id", "Supplier", shortText(256), false),
    supplyCostAttribute(
      "bulk_min_7d_quantity",
      "7-day tier threshold",
      decimal(6),
      false,
    ),
    supplyCostAttribute(
      "bulk_pack_quantity",
      "Bulk pack quantity",
      decimal(6),
      false,
    ),
    supplyCostAttribute(
      "bulk_pack_price_minor",
      "Bulk pack price (minor)",
      integer(0, 1_000_000_000),
      false,
    ),
    supplyCostAttribute("notes", "Purchasing notes", longText(500), false),
  ],
  publishedRevision: 1,
});

const SUPPLY_COST_TERMS_VIEW = parseSavedCommerceView({
  viewId: SUPPLY_COST_TERMS_VIEW_ID,
  name: "Supply Cost Terms",
  source: { kind: "commerce_list", listId: SUPPLY_COST_TERMS_LIST_ID },
  filter: { kind: "all" },
  sorts: [{ field: { kind: "display_name" }, direction: "ascending" }],
  visibleAttributeIds: [
    "currency",
    "pack_quantity",
    "pack_unit",
    "pack_price_minor",
    "bulk_min_7d_quantity",
    "bulk_pack_quantity",
    "bulk_pack_price_minor",
    "supplier_id",
  ],
  relationshipColumns: [],
  grouping: null,
  presentation: {
    kind: "table",
    configuration: { density: "comfortable", showRowNumbers: false },
  },
  revision: 1,
});

export const PURCHASING_PRESET: EntityPlanePresetBundle = {
  definitions: [TRADE_PARTNER_TYPE],
  relationshipDefinitions: [SUPPLIER_INVENTORY_ITEM_DEFINITION],
  lists: [SUPPLIER_DIRECTORY, REPLENISHMENT_QUEUE, SUPPLY_COST_TERMS],
  views: [
    SUPPLIER_DIRECTORY_VIEW,
    REPLENISHMENT_QUEUE_VIEW,
    SUPPLY_COST_TERMS_VIEW,
  ],
};

function supplyCostAttribute(
  attributeId: string,
  label: string,
  kind: Record<string, unknown>,
  required: boolean,
) {
  return listAttribute(
    { kind: "system", entityTypeId: "inventory_item", schemaRevision: 1 },
    attributeId,
    label,
    kind,
    required,
  );
}

function supplierAttribute(
  attributeId: string,
  label: string,
  kind: Record<string, unknown>,
  required: boolean,
) {
  return listAttribute(
    { kind: "custom", entityTypeId: SUPPLIER_ENTITY_TYPE_ID, typeRevision: 1 },
    attributeId,
    label,
    kind,
    required,
  );
}

function replenishmentAttribute(
  attributeId: string,
  label: string,
  kind: Record<string, unknown>,
  required: boolean,
) {
  return listAttribute(
    { kind: "system", entityTypeId: "stock_policy", schemaRevision: 1 },
    attributeId,
    label,
    kind,
    required,
  );
}

function listAttribute(
  scope: Record<string, unknown>,
  attributeId: string,
  label: string,
  kind: Record<string, unknown>,
  required: boolean,
) {
  return {
    attributeId,
    definition: {
      id: attributeId,
      scope,
      label,
      helpText: null,
      required,
      sensitivity: "internal",
      kind,
      revision: 1,
    },
  };
}

function shortText(maxLength: number) {
  return { kind: "short_text", maxLength };
}

function longText(maxLength: number) {
  return { kind: "long_text", maxLength };
}

function integer(minimum: number, maximum: number) {
  return { kind: "integer", minimum, maximum };
}

function decimal(scale: number) {
  return { kind: "decimal", scale, minimum: null, maximum: null };
}

function status(options: readonly (readonly [string, string])[]) {
  return {
    kind: "status",
    options: options.map(([id, label]) => ({ id, label })),
  };
}
