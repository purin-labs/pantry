import {
  parseCommerceList,
  parseCustomEntityTypeDraft,
  parseRelationshipDefinition,
  parseSavedCommerceView,
} from "./parsers.ts";

export const TRADE_PARTNER_TYPE = parseCustomEntityTypeDraft({
  typeId: "trade_partner",
  label: "Trade partner",
  description:
    "An organization the merchant buys from or coordinates commerce with.",
  attributes: [
    {
      id: "legal_name",
      scope: { kind: "custom", entityTypeId: "trade_partner", typeRevision: 1 },
      label: "Legal name",
      helpText: "The partner's registered organization name.",
      required: true,
      sensitivity: "internal",
      kind: { kind: "short_text", maxLength: 200 },
      revision: 1,
    },
    {
      id: "country_code",
      scope: { kind: "custom", entityTypeId: "trade_partner", typeRevision: 1 },
      label: "Country code",
      helpText: "The partner's two-letter country code.",
      required: false,
      sensitivity: "internal",
      kind: { kind: "short_text", maxLength: 2 },
      revision: 1,
    },
  ],
});

const EXPORT_DOCUMENT_TYPE = parseCustomEntityTypeDraft({
  typeId: "export_document",
  label: "Export document",
  description:
    "Metadata for an export document whose bytes remain provider-owned.",
  attributes: [
    {
      id: "document_number",
      scope: {
        kind: "custom",
        entityTypeId: "export_document",
        typeRevision: 1,
      },
      label: "Document number",
      helpText: "The document's business identifier.",
      required: true,
      sensitivity: "internal",
      kind: { kind: "short_text", maxLength: 120 },
      revision: 1,
    },
    {
      id: "document_type",
      scope: {
        kind: "custom",
        entityTypeId: "export_document",
        typeRevision: 1,
      },
      label: "Document type",
      helpText: "The export document category.",
      required: true,
      sensitivity: "internal",
      kind: {
        kind: "status",
        options: [
          { id: "commercial_invoice", label: "Commercial invoice" },
          { id: "packing_list", label: "Packing list" },
          { id: "certificate_of_origin", label: "Certificate of origin" },
        ],
      },
      revision: 1,
    },
    {
      id: "resource",
      scope: {
        kind: "custom",
        entityTypeId: "export_document",
        typeRevision: 1,
      },
      label: "Document resource",
      helpText: "A reference to provider-owned document bytes.",
      required: false,
      sensitivity: "internal",
      kind: { kind: "external_resource_reference" },
      revision: 1,
    },
  ],
});

const TRADE_PARTNER_ORDER_DEFINITION = parseRelationshipDefinition({
  origin: "custom",
  definitionId: "trade_partner_order",
  sourceType: { origin: "custom", typeId: "trade_partner" },
  targetType: { origin: "system", typeId: "order" },
  sourceLabel: "Orders",
  inverseLabel: "Trade partner",
  cardinality: "one_to_many",
  deletionBehavior: "detach",
  sensitivity: "internal",
  revision: 1,
});

const SHIPMENT_EXPORT_DOCUMENT_DEFINITION = parseRelationshipDefinition({
  origin: "custom",
  definitionId: "shipment_export_document",
  sourceType: { origin: "system", typeId: "shipment" },
  targetType: { origin: "custom", typeId: "export_document" },
  sourceLabel: "Export documents",
  inverseLabel: "Shipment",
  cardinality: "one_to_many",
  deletionBehavior: "detach",
  sensitivity: "internal",
  revision: 1,
});

const EXPORT_COORDINATION_LIST = parseCommerceList({
  listId: "export_coordination",
  entityTypeId: { origin: "system", typeId: "shipment" },
  name: "Export Coordination",
  membership: "unique_entity",
  entryAttributeDefinitions: [
    listAttribute("stage", "Stage", {
      kind: "status",
      options: [
        { id: "pending", label: "Pending" },
        { id: "ready", label: "Ready" },
        { id: "in_transit", label: "In transit" },
        { id: "delivered", label: "Delivered" },
        { id: "missing_documents", label: "Missing documents" },
        { id: "trade_partner_follow_up", label: "Trade partner follow-up" },
        { id: "exception", label: "Exception" },
      ],
    }),
    listAttribute("owner", "Owner", { kind: "merchant_operator_reference" }),
    listAttribute("due_at", "Due at", { kind: "timestamp" }),
    listAttribute("priority", "Priority", {
      kind: "status",
      options: [
        { id: "low", label: "Low" },
        { id: "normal", label: "Normal" },
        { id: "high", label: "High" },
      ],
    }),
    listAttribute("exception_reason", "Exception reason", {
      kind: "long_text",
      maxLength: 500,
    }),
  ],
  publishedRevision: 1,
});

const EXPORT_BOARD_VIEW = parseSavedCommerceView(
  savedView({
    viewId: "export_board",
    name: "Export board",
    filter: { kind: "all" },
    sorts: [
      {
        field: { kind: "attribute", attributeId: "due_at" },
        direction: "ascending",
      },
    ],
    visibleAttributeIds: ["stage", "owner", "due_at", "priority"],
    relationshipColumns: [
      {
        relationshipDefinition: {
          origin: "custom",
          definitionId: "trade_partner_order",
          revision: 1,
        },
        label: "Trade partner",
      },
      {
        relationshipDefinition: {
          origin: "system",
          definitionId: "order_shipment",
          revision: 1,
        },
        label: "Order",
      },
      {
        relationshipDefinition: {
          origin: "custom",
          definitionId: "shipment_export_document",
          revision: 1,
        },
        label: "Export documents",
      },
      {
        relationshipDefinition: {
          origin: "system",
          definitionId: "shipment_production_batch",
          revision: 1,
        },
        label: "Production batch",
      },
    ],
    grouping: { attributeId: "stage", descending: false },
    presentation: {
      kind: "board",
      configuration: {
        laneAttributeId: "stage",
        cardAttributeIds: ["owner", "due_at", "priority"],
      },
    },
  }),
);

const MISSING_DOCUMENTS_VIEW = parseSavedCommerceView(
  savedView({
    viewId: "missing_documents",
    name: "Missing documents",
    filter: {
      kind: "attribute",
      filter: {
        attributeId: "stage",
        operator: "equals",
        value: { kind: "status", value: "missing_documents" },
      },
    },
    sorts: [
      {
        field: { kind: "attribute", attributeId: "priority" },
        direction: "descending",
      },
    ],
    visibleAttributeIds: ["stage", "exception_reason", "owner", "due_at"],
    presentation: {
      kind: "table",
      configuration: { density: "comfortable", showRowNumbers: false },
    },
  }),
);

const HANDOFF_DUE_VIEW = parseSavedCommerceView(
  savedView({
    viewId: "handoff_due",
    name: "Handoff due",
    filter: {
      kind: "attribute",
      filter: { attributeId: "due_at", operator: "is_not_empty" },
    },
    sorts: [
      {
        field: { kind: "attribute", attributeId: "due_at" },
        direction: "ascending",
      },
    ],
    visibleAttributeIds: ["stage", "owner", "due_at", "priority"],
    presentation: {
      kind: "table",
      configuration: { density: "comfortable", showRowNumbers: false },
    },
  }),
);

const TRADE_PARTNER_FOLLOW_UP_VIEW = parseSavedCommerceView(
  savedView({
    viewId: "trade_partner_follow_up",
    name: "Trade partner follow-up",
    filter: {
      kind: "attribute",
      filter: {
        attributeId: "stage",
        operator: "equals",
        value: { kind: "status", value: "trade_partner_follow_up" },
      },
    },
    sorts: [
      {
        field: { kind: "attribute", attributeId: "priority" },
        direction: "descending",
      },
    ],
    visibleAttributeIds: ["owner", "stage", "due_at", "exception_reason"],
    relationshipColumns: [
      {
        relationshipDefinition: {
          origin: "custom",
          definitionId: "shipment_export_document",
          revision: 1,
        },
        label: "Export documents",
      },
    ],
    presentation: {
      kind: "table",
      configuration: { density: "comfortable", showRowNumbers: false },
    },
  }),
);

export type EntityPlanePresetBundle = Readonly<{
  definitions: readonly ReturnType<typeof parseCustomEntityTypeDraft>[];
  relationshipDefinitions: readonly ReturnType<
    typeof parseRelationshipDefinition
  >[];
  lists: readonly ReturnType<typeof parseCommerceList>[];
  views: readonly ReturnType<typeof parseSavedCommerceView>[];
}>;

export const EXPORT_COORDINATION_PRESET: EntityPlanePresetBundle = {
  definitions: [TRADE_PARTNER_TYPE, EXPORT_DOCUMENT_TYPE],
  relationshipDefinitions: [
    TRADE_PARTNER_ORDER_DEFINITION,
    SHIPMENT_EXPORT_DOCUMENT_DEFINITION,
  ],
  lists: [EXPORT_COORDINATION_LIST],
  views: [
    EXPORT_BOARD_VIEW,
    MISSING_DOCUMENTS_VIEW,
    HANDOFF_DUE_VIEW,
    TRADE_PARTNER_FOLLOW_UP_VIEW,
  ],
};

function listAttribute(
  attributeId: string,
  label: string,
  kind: Record<string, unknown>,
) {
  return {
    attributeId,
    definition: {
      id: attributeId,
      scope: { kind: "system", entityTypeId: "shipment", schemaRevision: 1 },
      label,
      helpText: null,
      required: false,
      sensitivity: "internal",
      kind,
      revision: 1,
    },
  };
}

function savedView(input: {
  viewId: string;
  name: string;
  filter: unknown;
  sorts: readonly unknown[];
  visibleAttributeIds: readonly string[];
  relationshipColumns?: readonly unknown[];
  grouping?: unknown;
  presentation: unknown;
}) {
  return {
    viewId: input.viewId,
    name: input.name,
    source: { kind: "commerce_list", listId: "export_coordination" },
    filter: input.filter,
    sorts: input.sorts,
    visibleAttributeIds: input.visibleAttributeIds,
    relationshipColumns: input.relationshipColumns ?? [],
    grouping: input.grouping ?? null,
    presentation: input.presentation,
    revision: 1,
  };
}
