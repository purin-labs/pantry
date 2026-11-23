/**
 * Dev-only visual harness for the Checkout, Inventory, Orders, and
 * Suppliers pages.
 *
 * Serves at /commerce-preview.html under `pnpm portal`. Mounts the real
 * routes against fixture transports so the pages can be reviewed without
 * the control plane:
 *
 *   ?page=checkout | orders | suppliers
 *   &scenario=populated | empty          (checkout also: fresh or retry)
 */
import React from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  useNavigate,
  useSearchParams,
  type NavigateFunction,
} from "react-router";
import { Toaster } from "sonner";
import type {
  CheckoutProfileConfiguration,
  CommerceResourceType,
} from "@purin-labs/commerce-contracts";

import "@purin-labs/surface-portal/ui/styles.css";
import { CheckoutProfilesRoute } from "@purin-labs/area-commerce/ui/features/checkout-profiles/route";
import { CommerceEntityPlaneRoute } from "@purin-labs/area-commerce/ui/features/commerce/entity-plane/route";
import { SupplierPayoutsPanel } from "@purin-labs/area-commerce/ui/features/payouts/route";
import { CounterSaleRoute } from "@purin-labs/area-cafe/ui/features/terminals/counter-sale-route";
import type { CounterSale } from "@purin-labs/control-api/portal/counter-sale";
import { UNAVAILABLE_ACCESS } from "@purin-labs/area-organisation/ui/features/access/unavailable-access";
import type { PayoutReadAccess } from "@purin-labs/area-commerce/ui/features/payouts/read-permission";
import type { SupplierPayout } from "@purin-labs/control-api/portal/payouts";
import type { OfferPriceAllowanceTransport } from "@purin-labs/area-commerce/ui/features/commerce/price-allowance";
import type { CommerceOperationsTransport } from "@purin-labs/area-commerce/ui/features/commerce/operations";

const PREVIEW_COMMERCE_OPERATIONS: CommerceOperationsTransport = {
  previewTrackingBatch: refusePreviewOrderProposal,
  proposeAction: refusePreviewOrderProposal,
};

async function refusePreviewOrderProposal(): Promise<never> {
  throw new Error("This preview does not submit order changes.");
}

const PREVIEW_ALLOWANCE_TRANSPORT: OfferPriceAllowanceTransport = {
  save: refusePreviewAllowanceWrite,
  withdraw: refusePreviewAllowanceWrite,
};

async function refusePreviewAllowanceWrite(): Promise<never> {
  throw new Error("This preview does not change price allowances.");
}

async function refusePreviewDescriptionProposal(): Promise<never> {
  throw new Error("This preview does not submit product changes.");
}

function ignorePreviewProposal(): void {}

const PREVIEW_PAYOUT_ACCESS: PayoutReadAccess = {
  read: UNAVAILABLE_ACCESS.read,
  mutate: UNAVAILABLE_ACCESS.mutate,
  readOptions: unavailablePayoutOptions,
};

async function unavailablePayoutOptions(): Promise<never> {
  throw new Error("Access changes are unavailable in this visual preview.");
}

type PreviewPage =
  "checkout" | "products" | "orders" | "suppliers" | "counter";
type Scenario = "populated" | "empty" | "fresh" | "retry";

const NOW = "2026-08-31T09:00:00.000Z";
const COUNTER_CHECKOUT_ID =
  "checkout_counter_00000000-0000-0000-0000-000000000001";
let counterReadFailed = false;
let payoutReadFailed = false;
let inventoryReadFailed = false;

function previewPayoutStates(): readonly SupplierPayout[] {
  const states: readonly SupplierPayout["state"][] = [
    "approval_pending",
    "approved",
    "submitting",
    "provider_action_required",
    "provider_pending",
    "indeterminate",
  ];
  return states.map(previewPayout);
}

function previewPayout(state: SupplierPayout["state"]): SupplierPayout {
  return {
    payoutId: `payout_${state}`,
    payableId: `invoice_${state}`,
    supplierId: "Kyoto Roastery · seasonal café supply",
    rail: "wise_enterprise_payouts",
    destinationRevisionId: "destination_preview",
    currency: "SGD",
    recipientAmountMinor: 123456,
    feeCeilingMinor: 1000,
    state,
    approved: state !== "approval_pending",
    revision: 2,
  };
}

function previewCounterSale(): CounterSale {
  const query = new URLSearchParams(window.location.search);
  const state = previewCounterState(query.get("sale"));
  const refundState = previewRefundState(query.get("refund"));
  const currency = query.get("currency") === "JPY" ? "JPY" : "SGD";
  return {
    checkoutId: COUNTER_CHECKOUT_ID,
    pantryLocationId: "Tokyo boutique · front counter",
    revision: 3,
    state,
    collectable: state === "awaiting_collection" || state === "declined",
    recoverable:
      state === "submission_unknown"
        ? {
            paymentAttemptId: "payment_attempt_counter_preview",
            reasonCode: "provider_timeout",
            reconcileAfter: "2026-10-23T04:00:00Z",
          }
        : null,
    quote: {
      quoteDigest: `quote_${"a".repeat(64)}`,
      checkoutRevision: 3,
      lineCount: 2,
      amount: { amountMinor: 1234, currency },
    },
    orderId: state === "complete" ? "order_counter_preview" : null,
    capturedPaymentReference:
      state === "complete" || state === "captured_unplaced"
        ? "payment_counter_preview"
        : null,
    afterSale:
      state === "complete"
        ? {
            order: {
              id: "order_counter_preview",
              revision: 1,
              state: "confirmed",
            },
            payment: {
              id: "payment_counter_preview",
              revision: 1,
              state: refundState === "completed" ? "refunded" : "captured",
            },
            fulfillment: {
              id: "pickup_counter_preview",
              revision: 1,
              state:
                query.get("pickup") === "ready"
                  ? "ready_for_pickup"
                  : "requested",
            },
            refundState,
          }
        : null,
  };
}

function previewCounterState(raw: string | null): CounterSale["state"] {
  switch (raw) {
    case "collecting":
    case "submission_unknown":
    case "declined":
    case "captured_unplaced":
    case "complete":
    case "expired":
      return raw;
    default:
      return "awaiting_collection";
  }
}

function previewRefundState(
  raw: string | null,
): "none" | "pending" | "completed" | "failed" {
  switch (raw) {
    case "pending":
    case "completed":
    case "failed":
      return raw;
    default:
      return "none";
  }
}

const PROVENANCE = (
  resourceType: CommerceResourceType,
  resourceId: string,
) => ({
  organisationId: "organisation_preview",
  integrationAccountId: "intacc_commerce",
  source: "commerce",
  resourceType,
  resourceId,
  revision: 4,
  occurredAt: "2026-08-30T21:12:00.000Z",
  observedAt: "2026-08-31T08:58:00.000Z",
});

const systemAttribute = (
  entityTypeId: string,
  attributeId: string,
  value: unknown,
) => ({
  attributeId,
  scope: { kind: "system", entityTypeId, schemaRevision: 1 },
  definitionRevision: 1,
  sensitivity: "internal",
  value,
});

const orderEntity = (
  entityId: string,
  displayName: string,
  lifecycle: string,
  freshness: unknown = {
    state: "current",
    observedAt: "2026-08-31T08:58:00.000Z",
  },
) => ({
  reference: { origin: "system", typeId: "order", entityId },
  revision: 3,
  displayName,
  attributes: [
    systemAttribute("order", "lifecycle", { kind: "status", value: lifecycle }),
  ],
  provenance: PROVENANCE("commerce_order", entityId),
  freshness,
});

const ORDER_ENTITIES = [
  orderEntity("ord_1041", "Order #1041 · Aiko Sato", "pending_confirmation"),
  orderEntity("ord_1040", "Order #1040 · Kenji Watanabe", "confirmed"),
  orderEntity("ord_1039", "Order #1039 · Mei Lin", "fulfillment_pending"),
  orderEntity(
    "ord_1038",
    "Order #1038 · Hana Kobayashi",
    "partially_fulfilled",
  ),
  orderEntity("ord_1037", "Order #1037 · Taro Yamada", "fulfilled", {
    state: "stale",
    observedAt: "2026-08-30T20:00:00.000Z",
    staleSince: "2026-08-31T02:00:00.000Z",
  }),
  orderEntity("ord_1036", "Order #1036 · Sofia Marques", "cancelled"),
];

const PRODUCT_ENTITIES = [
  {
    reference: {
      origin: "system",
      typeId: "product",
      entityId: "product_financier",
    },
    revision: 3,
    displayName: "Brown butter financier · 焦がしバター",
    attributes: [
      systemAttribute("product", "description", {
        kind: "long_text",
        value:
          "A small almond cake with browned butter and a crisp golden edge. Baked fresh each morning.",
      }),
      systemAttribute("product", "lifecycle", {
        kind: "status",
        value: "active",
      }),
    ],
    provenance: PROVENANCE("product", "product_financier"),
    freshness: { state: "current", observedAt: NOW },
  },
];

const ORDER_RELATIONSHIPS = ORDER_ENTITIES.slice(0, 4).map((entity, index) => ({
  origin: "system",
  relationshipId: `rel_fulfillment_${index}`,
  definition: {
    origin: "system",
    definitionId: "order_fulfillment",
    revision: 1,
  },
  sensitivity: "internal",
  source: entity.reference,
  target: { origin: "system", typeId: "fulfillment", entityId: `ful_${index}` },
  revision: 1,
  provenance: PROVENANCE("commerce_order", entity.reference.entityId),
}));

const listAttributeDefinition = (
  scope: unknown,
  attributeId: string,
  label: string,
  kind: unknown,
  required: boolean,
  helpText: string | null = null,
) => ({
  attributeId,
  definition: {
    id: attributeId,
    scope,
    label,
    helpText,
    required,
    sensitivity: "internal",
    kind,
    revision: 1,
  },
});

const supplierScope = {
  kind: "custom",
  entityTypeId: "trade_partner",
  typeRevision: 1,
};
const replenishmentScope = {
  kind: "system",
  entityTypeId: "stock_policy",
  schemaRevision: 1,
};
const shortText = (maxLength: number) => ({ kind: "short_text", maxLength });
const decimalKind = (scale: number) => ({
  kind: "decimal",
  scale,
  minimum: null,
  maximum: null,
});

const SUPPLIER_DIRECTORY_LIST = {
  listId: "supplier_directory",
  entityTypeId: { origin: "custom", typeId: "trade_partner" },
  name: "Supplier Directory",
  membership: "unique_entity",
  entryAttributeDefinitions: [
    listAttributeDefinition(
      supplierScope,
      "contact_name",
      "Contact",
      shortText(160),
      false,
    ),
    listAttributeDefinition(
      supplierScope,
      "email",
      "Email",
      shortText(254),
      false,
    ),
    listAttributeDefinition(
      supplierScope,
      "phone",
      "Phone",
      shortText(80),
      false,
    ),
    listAttributeDefinition(
      supplierScope,
      "lead_time_days",
      "Lead time (days)",
      { kind: "integer", minimum: 0, maximum: 365 },
      true,
    ),
    listAttributeDefinition(
      supplierScope,
      "minimum_order_quantity",
      "Minimum order",
      decimalKind(3),
      false,
    ),
    listAttributeDefinition(
      supplierScope,
      "minimum_order_unit",
      "Minimum order unit",
      shortText(40),
      false,
    ),
    listAttributeDefinition(
      supplierScope,
      "purchasing_notes",
      "Purchasing notes",
      { kind: "long_text", maxLength: 1000 },
      false,
    ),
  ],
  publishedRevision: 1,
};

const REPLENISHMENT_STATUS = {
  kind: "status",
  options: [
    { id: "needs_review", label: "Needs review" },
    { id: "requested", label: "Requested" },
    { id: "expected", label: "Expected" },
    { id: "partial", label: "Partial" },
    { id: "late", label: "Late" },
    { id: "received", label: "Received" },
  ],
};

const REPLENISHMENT_QUEUE_LIST = {
  listId: "replenishment_queue",
  entityTypeId: { origin: "system", typeId: "stock_policy" },
  name: "Replenishment Queue",
  membership: "unique_entity",
  entryAttributeDefinitions: [
    listAttributeDefinition(
      replenishmentScope,
      "status",
      "Status",
      REPLENISHMENT_STATUS,
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "supplier_id",
      "Supplier",
      shortText(256),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "owner",
      "Owner",
      shortText(160),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "inventory_item_id",
      "Inventory item",
      shortText(256),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "location_id",
      "Location",
      shortText(256),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "opened_at",
      "Opened",
      { kind: "timestamp" },
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "available_quantity",
      "Available",
      decimalKind(6),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "reorder_point",
      "Reorder point",
      decimalKind(6),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "target_quantity",
      "Target",
      decimalKind(6),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "required_quantity",
      "Required",
      decimalKind(6),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "received_quantity",
      "Received quantity",
      decimalKind(6),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "quantity_unit",
      "Unit",
      shortText(40),
      true,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "purchase_request_id",
      "Purchase request",
      shortText(256),
      false,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "expected_delivery_at",
      "Expected delivery",
      { kind: "timestamp" },
      false,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "closed_at",
      "Closed",
      { kind: "timestamp" },
      false,
    ),
    listAttributeDefinition(
      replenishmentScope,
      "notes",
      "Notes",
      { kind: "long_text", maxLength: 1000 },
      false,
    ),
  ],
  publishedRevision: 1,
};

const REPLENISHMENT_QUEUE_VIEW = {
  viewId: "replenishment_queue",
  name: "Replenishment Queue",
  source: { kind: "commerce_list", listId: "replenishment_queue" },
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
};

function suppliersMetadataResponse(scenario: Scenario): unknown {
  return {
    ok: true,
    metadata: {
      kind: "enumerated",
      organisationId: "organisation_preview",
      merchantId: "merchant_nuki",
      merchantRevision: 174,
      entityTypes: [],
      lists:
        scenario === "empty"
          ? []
          : [SUPPLIER_DIRECTORY_LIST, REPLENISHMENT_QUEUE_LIST],
      views: scenario === "empty" ? [] : [REPLENISHMENT_QUEUE_VIEW],
    },
  };
}

const supplierAttributeValue = (attributeId: string, value: unknown) => ({
  attributeId,
  scope: supplierScope,
  definitionRevision: 1,
  sensitivity: "internal",
  value,
});

const supplierEntity = (
  entityId: string,
  displayName: string,
  legalName: string,
) => ({
  reference: { origin: "custom", typeId: "trade_partner", entityId },
  revision: 2,
  displayName,
  attributes: [
    supplierAttributeValue("legal_name", {
      kind: "short_text",
      value: legalName,
    }),
    supplierAttributeValue("country_code", { kind: "short_text", value: "JP" }),
  ],
  typeRevision: 1,
  state: { state: "active" },
  sensitivity: "internal",
});

const supplierEntry = (
  entityId: string,
  values: Readonly<Record<string, unknown>>,
) => ({
  entryId: `entry_${entityId}`,
  listId: "supplier_directory",
  listRevision: 1,
  entityRef: { origin: "custom", typeId: "trade_partner", entityId },
  attributeValues: Object.entries(values).map(([attributeId, value]) =>
    supplierAttributeValue(attributeId, value),
  ),
  revision: 1,
});

const SUPPLIER_ENTITIES = [
  supplierEntity(
    "packaging-supply-co",
    "Packaging Supply Co",
    "Packaging Supply Co KK",
  ),
  supplierEntity("kyoto-roastery", "Kyoto Roastery", "Kyoto Roastery GK"),
  supplierEntity("uji-matcha-farm", "Uji Matcha Farm", "Uji Matcha Farm KK"),
];

const SUPPLIER_ENTRIES = [
  supplierEntry("packaging-supply-co", {
    contact_name: { kind: "short_text", value: "Rin Takahashi" },
    email: { kind: "short_text", value: "orders@packagingsupply.jp" },
    lead_time_days: { kind: "integer", value: 5 },
    minimum_order_quantity: {
      kind: "decimal",
      value: { unscaled: 10000, scale: 3 },
    },
    minimum_order_unit: { kind: "short_text", value: "case" },
  }),
  supplierEntry("kyoto-roastery", {
    contact_name: { kind: "short_text", value: "Sora Ito" },
    email: { kind: "short_text", value: "hello@kyotoroastery.jp" },
    lead_time_days: { kind: "integer", value: 3 },
  }),
  supplierEntry("uji-matcha-farm", {
    email: { kind: "short_text", value: "farm@ujimatcha.jp" },
    lead_time_days: { kind: "integer", value: 10 },
    purchasing_notes: {
      kind: "long_text",
      value: "Harvest pauses in late autumn.",
    },
  }),
];

const replenishmentAttributeValue = (attributeId: string, value: unknown) => ({
  attributeId,
  scope: replenishmentScope,
  definitionRevision: 1,
  sensitivity: "internal",
  value,
});

const stockPolicyEntity = (entityId: string, displayName: string) => ({
  reference: { origin: "system", typeId: "stock_policy", entityId },
  revision: 1,
  displayName,
  attributes: [],
  provenance: PROVENANCE("stock_policy", entityId),
  freshness: { state: "current", observedAt: "2026-08-31T08:58:00.000Z" },
});

const INVENTORY_ENTITIES = [
  previewInventoryItem("cups-12oz", "Paper cups · 12 oz"),
  previewInventoryItem("lids-12oz", "Lids · 12 oz"),
  previewInventoryItem("coffee-house", "House blend coffee beans"),
];

function previewInventoryItem(entityId: string, displayName: string) {
  return {
    reference: { origin: "system", typeId: "inventory_item", entityId },
    revision: 1,
    displayName,
    attributes: [],
    provenance: PROVENANCE("inventory_item", entityId),
    freshness: { state: "current", observedAt: NOW },
  };
}

const replenishmentEntry = (
  entityId: string,
  status: string,
  values: Readonly<Record<string, unknown>>,
) => ({
  entryId: `entry_${entityId}`,
  listId: "replenishment_queue",
  listRevision: 1,
  entityRef: { origin: "system", typeId: "stock_policy", entityId },
  attributeValues: [
    replenishmentAttributeValue("status", { kind: "status", value: status }),
    ...Object.entries(values).map(([attributeId, value]) =>
      replenishmentAttributeValue(attributeId, value),
    ),
  ],
  revision: 2,
});

const REPLENISHMENT_ENTITIES = [
  stockPolicyEntity("policy_beans", "House espresso beans 1kg"),
  stockPolicyEntity("policy_cups", "8oz takeaway cups"),
  stockPolicyEntity("policy_matcha", "Ceremonial matcha 100g"),
];

const REPLENISHMENT_ENTRIES = [
  replenishmentEntry("policy_beans", "needs_review", {
    supplier_id: { kind: "short_text", value: "kyoto-roastery" },
    owner: { kind: "short_text", value: "Pta" },
    required_quantity: {
      kind: "decimal",
      value: { unscaled: 12000000, scale: 6 },
    },
    quantity_unit: { kind: "short_text", value: "kg" },
  }),
  replenishmentEntry("policy_cups", "requested", {
    supplier_id: { kind: "short_text", value: "packaging-supply-co" },
    owner: { kind: "short_text", value: "Pta" },
    required_quantity: {
      kind: "decimal",
      value: { unscaled: 20000000, scale: 6 },
    },
    quantity_unit: { kind: "short_text", value: "sleeve" },
    purchase_request_id: { kind: "short_text", value: "pr_2091" },
    expected_delivery_at: {
      kind: "timestamp",
      value: "2026-09-03T09:00:00.000Z",
    },
  }),
  replenishmentEntry("policy_matcha", "late", {
    supplier_id: { kind: "short_text", value: "uji-matcha-farm" },
    owner: { kind: "short_text", value: "Kenji" },
    required_quantity: {
      kind: "decimal",
      value: { unscaled: 3000000, scale: 6 },
    },
    quantity_unit: { kind: "short_text", value: "tin" },
    expected_delivery_at: {
      kind: "timestamp",
      value: "2026-08-29T09:00:00.000Z",
    },
  }),
];

function suppliersGraphResult(body: {
  query?: { kind?: string; listId?: string; viewId?: string };
}): unknown {
  const kind = body.query?.kind;
  if (
    kind === "commerce_list_page" &&
    body.query?.listId === "supplier_directory"
  ) {
    return {
      ok: true,
      result: {
        merchantRevision: 174,
        entities: SUPPLIER_ENTITIES,
        relationships: [],
        listEntries: SUPPLIER_ENTRIES,
        aggregations: [],
        nextCursor: null,
        provenance: [],
        freshness: [],
      },
    };
  }
  return {
    ok: true,
    result: {
      merchantRevision: 174,
      entities: REPLENISHMENT_ENTITIES,
      relationships: [],
      listEntries: REPLENISHMENT_ENTRIES,
      aggregations: [],
      nextCursor: null,
      provenance: [],
      freshness: [],
    },
  };
}

function graphResult(
  entities: readonly unknown[],
  relationships: readonly unknown[] = [],
) {
  return {
    ok: true,
    result: {
      merchantRevision: 174,
      entities,
      relationships,
      listEntries: [],
      aggregations: [],
      nextCursor: null,
      provenance: [PROVENANCE("commerce_order", "merchant_nuki")],
      freshness: [{ state: "current", observedAt: "2026-08-31T08:58:00.000Z" }],
    },
  };
}

function matchesSearch(entity: { displayName: string }, text: string): boolean {
  return entity.displayName.toLowerCase().includes(text.toLowerCase());
}

function buildGraphFetcher(scenario: Scenario) {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (url.includes("/commerce/published-resources")) {
      return jsonResponse(suppliersMetadataResponse(scenario));
    }
    if (url.includes("/commerce/graph/activity")) {
      return jsonResponse({ events: [], unsupportedSources: [] });
    }
    if (url.includes("/commerce/graph")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        queries?: readonly unknown[];
        query?: {
          kind?: string;
          entityTypeId?: { typeId?: string };
          text?: string;
          listId?: string;
          viewId?: string;
          seeds?: readonly { entityId: string }[];
        };
      };
      if (Array.isArray(body.queries))
        return jsonResponse({
          ok: true,
          results: body.queries.map(previewAggregation.bind(null, scenario)),
        });
      if (body.query?.kind === "relationship_traversal") {
        const entityId = body.query.seeds?.[0]?.entityId;
        const entities = [
          ...PRODUCT_ENTITIES,
          ...ORDER_ENTITIES,
          ...SUPPLIER_ENTITIES,
        ];
        return jsonResponse(
          graphResult(entities.filter(matchesEntityId.bind(null, entityId))),
        );
      }
      if (
        body.query?.kind === "commerce_list_page" ||
        body.query?.kind === "saved_commerce_view"
      ) {
        return jsonResponse(suppliersGraphResult(body));
      }
      const typeId = body.query?.entityTypeId?.typeId;
      if (typeId === "inventory_item") {
        const items = new URLSearchParams(window.location.search).get("items");
        if (items === "retry" && !inventoryReadFailed) {
          inventoryReadFailed = true;
          return jsonResponse({ ok: false }, 503);
        }
        return jsonResponse(graphResult(items === "empty" ? [] : INVENTORY_ENTITIES));
      }
      const text = body.query?.kind === "search" ? (body.query.text ?? "") : "";
      const all =
        scenario === "empty"
          ? []
          : typeId === "order"
            ? ORDER_ENTITIES
            : PRODUCT_ENTITIES;
      const entities =
        text.length === 0
          ? all
          : all.filter((entity) => matchesSearch(entity, text));
      const relationships =
        typeId === "order" && text.length === 0 && scenario !== "empty"
          ? ORDER_RELATIONSHIPS
          : [];
      return jsonResponse(graphResult(entities, relationships));
    }
    return jsonResponse({ ok: false }, 404);
  };
}

function matchesEntityId(
  entityId: string | undefined,
  entity: { reference: { entityId: string } },
): boolean {
  return entity.reference.entityId === entityId;
}

function previewAggregation(scenario: Scenario): unknown {
  const response = graphResult([], []);
  return {
    ok: true,
    result: {
      ...response.result,
      aggregations: [
        { kind: "count", value: scenario === "empty" ? "0" : "3" },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function checkoutConfiguration(): CheckoutProfileConfiguration {
  return {
    currencyPolicy: { kind: "fixed", currency: "JPY" },
    buyerPolicy: {
      kind: "guest",
      requiredContact: "email_required_phone_optional",
    },
    cartPolicy: {
      kind: "single_fulfillment",
      minimumLines: 1,
      maximumLines: 20,
      maximumTotalQuantity: 60,
    },
    pricingPolicy: {
      kind: "published_offers",
      salesChannelId: "channel_cafe_online",
    },
    fulfillmentPolicy: {
      kind: "buyer_choice",
      pickupPolicyId: "pickup_cafe_counter",
      shippingPolicyId: "shipping_jp_standard",
    },
    taxPolicy: {
      kind: "merchant_inclusive",
      jurisdictionPolicyId: "tax_jp_inclusive",
    },
    paymentPolicy: {
      kind: "external_provider",
      paymentProviderBindingId: "binding_stripe_nuki",
    },
    afterSalePolicy: {
      cancellationPolicyId: "cancel_24h",
      refundPolicyId: "refund_standard",
      refundGovernance: {
        kind: "automatic_up_to",
        threshold: { amountMinor: 5000, currency: "JPY" },
      },
    },
    presentationPolicy: {
      locale: "ja-JP",
      merchantDisplayName: "Nuki Cafe",
      termsPolicyId: "terms_v2",
      privacyPolicyId: "privacy_v2",
      supportContact: "hello@nuki.cafe",
    },
  };
}

function checkoutProfilesResponse(scenario: Scenario): unknown {
  if (scenario === "empty")
    return { ok: true, profiles: [], activations: [], storefrontIds: [] };
  const draft = {
    profile: {
      checkoutProfileId: "chk_cafe_pickup",
      merchantId: "merchant_nuki",
      revision: 4,
      name: "Cafe pickup and delivery",
      configuration: checkoutConfiguration(),
      lifecycle: { state: "draft", createdAt: NOW, updatedAt: NOW },
    },
    configurationDigest: DIGEST,
  };
  if (scenario === "fresh")
    return {
      ok: true,
      profiles: [draft],
      activations: [],
      storefrontIds: ["storefront_cafe"],
    };
  const published = {
    profile: {
      checkoutProfileId: "chk_cafe_main",
      merchantId: "merchant_nuki",
      revision: 7,
      name: "Storefront checkout",
      configuration: checkoutConfiguration(),
      lifecycle: {
        state: "published",
        publishedAt: NOW,
        publishedBy: "operator_pta",
      },
    },
    configurationDigest: DIGEST,
  };
  const retired = {
    profile: {
      checkoutProfileId: "chk_cafe_legacy",
      merchantId: "merchant_nuki",
      revision: 2,
      name: "Legacy pop-up checkout",
      configuration: checkoutConfiguration(),
      lifecycle: {
        state: "retired",
        publishedAt: NOW,
        retiredAt: NOW,
        retiredBy: "operator_pta",
      },
    },
    configurationDigest: DIGEST,
  };
  const inactive = {
    profile: {
      checkoutProfileId: "chk_cafe_seasonal",
      merchantId: "merchant_nuki",
      revision: 3,
      name: "Seasonal pickup",
      configuration: checkoutConfiguration(),
      lifecycle: {
        state: "published",
        publishedAt: NOW,
        publishedBy: "operator_pta",
      },
    },
    configurationDigest: DIGEST,
  };
  return {
    ok: true,
    profiles: [published, draft, retired, inactive],
    storefrontIds: ["storefront_cafe", "storefront_cookie_store_sg"],
    activations: [
      {
        merchantId: "merchant_nuki",
        storefrontId: "storefront_cafe",
        checkoutProfileId: "chk_cafe_main",
        checkoutProfileRevision: 7,
        activatedAt: NOW,
        activatedBy: "operator_pta",
      },
      {
        merchantId: "merchant_nuki",
        storefrontId: "storefront_cookie_store_sg",
        checkoutProfileId: "chk_cafe_legacy",
        checkoutProfileRevision: 2,
        activatedAt: NOW,
        activatedBy: "operator_pta",
      },
    ],
  };
}

function installCommerceFetchStub(scenario: Scenario): void {
  const original = window.fetch.bind(window);
  window.fetch = commercePreviewFetch.bind(null, original, scenario, {
    reads: 0,
  });
}

async function commercePreviewFetch(
  original: typeof window.fetch,
  scenario: Scenario,
  requests: { reads: number },
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (
    String(input).endsWith(`/commerce/counter-sales/${COUNTER_CHECKOUT_ID}`)
  ) {
    if (scenario === "retry" && !counterReadFailed) {
      counterReadFailed = true;
      return jsonResponse({ ok: false, error: "temporarily_unavailable" }, 503);
    }
    return jsonResponse(previewCounterEnvelope());
  }
  const url = String(input);
  if (url.includes("/commerce/priced-offers")) {
    return jsonResponse({
      ok: true,
      offers:
        scenario === "empty"
          ? []
          : [
              {
                offerId: "offer_financier",
                variantId: "variant_financier",
                salesChannelId: "channel_cafe",
                revision: 4,
                priceMinor: 1200,
                currency: "SGD",
              },
            ],
    });
  }
  if (url.includes("/price-policy")) {
    const disabled =
      new URLSearchParams(window.location.search).get("allowance") ===
      "disabled";
    return jsonResponse({
      ok: true,
      pricePolicy: {
        policy: disabled
          ? { kind: "disabled", revision: 0 }
          : {
              kind: "enabled",
              revision: 2,
              referenceOfferRevision: 4,
              referencePriceMinor: 1200,
              currency: "SGD",
              maxMovementBps: 500,
            },
        allowedRange: disabled
          ? null
          : { minimumMinor: 1140, maximumMinor: 1260 },
        currentPriceMinor: 1200,
        currentOfferRevision: 4,
        currency: "SGD",
      },
    });
  }
  if (url.includes("/commerce/supplier-payouts")) {
    const payoutScenario = new URLSearchParams(window.location.search).get(
      "payout",
    );
    if (payoutScenario === "denied")
      return jsonResponse(
        { ok: false, error: "supplier_payout_read_unavailable" },
        403,
      );
    if (payoutScenario === "retry" && !payoutReadFailed) {
      payoutReadFailed = true;
      return jsonResponse({ ok: false, error: "temporarily_unavailable" }, 503);
    }
    if (url.includes("view=exceptions"))
      return jsonResponse({ ok: true, events: [], nextCursor: null });
    return jsonResponse({
      ok: true,
      supplierPayouts:
        payoutScenario === "states"
          ? previewPayoutStates()
          : scenario === "empty"
            ? []
            : [
                {
                  payoutId: "payout_roastery",
                  payableId: "invoice_september",
                  supplierId: "Kyoto Roastery",
                  rail: "wise_enterprise_payouts",
                  destinationRevisionId: "destination_1",
                  currency: "JPY",
                  recipientAmountMinor: 48000,
                  feeCeilingMinor: 1000,
                  state: "provider_action_required",
                  approved: true,
                  revision: 2,
                },
              ],
    });
  }
  if (
    url.includes("/commerce/checkout-profiles") &&
    (init?.method ?? "GET") === "GET"
  ) {
    requests.reads += 1;
    if (scenario === "retry" && requests.reads === 1) {
      return jsonResponse({ ok: false, error: "temporarily_unavailable" }, 503);
    }
    return jsonResponse(checkoutProfilesResponse(scenario));
  }
  return original(input, init);
}

function previewCounterEnvelope(): unknown {
  const sale = previewCounterSale();
  return {
    ok: true,
    counterSale: {
      schemaVersion: "pantry.counter-sale.v1",
      checkoutId: sale.checkoutId,
      pantryLocationId: sale.pantryLocationId,
      revision: sale.revision,
      state: sale.state,
      collectable: sale.collectable,
      recoverable: sale.recoverable,
      quote: sale.quote,
      orderId: sale.orderId,
      capturedPaymentReference: sale.capturedPaymentReference,
      afterSale: sale.afterSale,
    },
  };
}

async function checkoutMutation(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<unknown> {
  console.log("[preview] checkout mutate", path, method, body);
  if (
    path.includes("/commerce/counter-sales/") &&
    path.endsWith("/refund") &&
    new URLSearchParams(window.location.search).get("refund") === "pending"
  ) {
    return previewCounterEnvelope();
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  throw new Error("Mutations are disabled in this preview.");
}

async function commerceMutation(path: string, body: unknown): Promise<unknown> {
  console.log("[preview] commerce mutate", path, body);
  await new Promise((resolve) => setTimeout(resolve, 350));
  throw new Error("Mutations are disabled in this preview.");
}

function parsePage(value: string | null): PreviewPage {
  return value === "orders" ||
    value === "suppliers" ||
    value === "products" ||
    value === "counter"
    ? value
    : "checkout";
}

function parseScenario(value: string | null): Scenario {
  return value === "empty" || value === "fresh" || value === "retry"
    ? value
    : "populated";
}

function PreviewApp(): React.ReactNode {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const page = parsePage(params.get("page"));
  const scenario = parseScenario(params.get("scenario"));
  React.useMemo(installCommerceFetchStub.bind(null, scenario), [scenario]);
  const fetcher = React.useMemo(buildGraphFetcher.bind(null, scenario), [
    scenario,
  ]);
  return (
    <div
      className="portal-shell portal-shell-workspace"
      style={{ display: "block" }}
    >
      <main
        className="portal-main"
        style={{ padding: "24px", height: "100vh", overflowY: "auto" }}
      >
        <div className="portal-main-inner">
          <nav
            aria-label="Preview pages"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "12px",
              marginBottom: "16px",
              fontSize: "13px",
            }}
          >
            {(
              [
                "products",
                "checkout",
                "orders",
                "suppliers",
                "counter",
              ] as const
            ).map((entry) => (
              <a
                key={entry}
                href={`/commerce-preview.html?page=${entry}&scenario=${scenario}`}
                aria-current={entry === page ? "page" : undefined}
              >
                {entry}
                {entry === page ? " ✓" : ""}
              </a>
            ))}
            <span aria-hidden="true">·</span>
            {(["populated", "fresh", "empty", "retry"] as const).map(
              (entry) => (
                <a
                  key={entry}
                  href={`/commerce-preview.html?page=${page}&scenario=${entry}`}
                  aria-current={entry === scenario ? "page" : undefined}
                >
                  {entry}
                  {entry === scenario ? " ✓" : ""}
                </a>
              ),
            )}
          </nav>
          <header className="portal-heading">
            <h1 id="portal-page-title" tabIndex={-1}>
              {pageTitle(page)}
            </h1>
            <p>{pageDescription(page)}</p>
          </header>
          {page === "checkout" ? (
            <CheckoutProfilesRoute
              organisationId="organisation_preview"
              canManage={true}
              integrationsPath={`/commerce-preview.html?page=${page}&scenario=${scenario}`}
              mutate={checkoutMutation}
            />
          ) : page === "counter" ? (
            <CounterSaleRoute
              organisationId="organisation_preview"
              checkoutId={COUNTER_CHECKOUT_ID}
              collection={
                params.get("role") === "viewer"
                  ? { kind: "read_only" }
                  : { kind: "enabled", mutate: checkoutMutation }
              }
            />
          ) : (
            <>
              {page === "suppliers" && params.get("resource") === null ? (
                <SupplierPayoutsPanel
                  organisationId="organisation_preview"
                  workspaceName="Nuki Cafe"
                  canManage={params.get("role") !== "viewer"}
                  accessRole={params.get("role") === "viewer" ? null : "owner"}
                  access={PREVIEW_PAYOUT_ACCESS}
                  mutate={checkoutMutation}
                />
              ) : null}
              <CommerceEntityPlaneRoute
                organisationId="organisation_preview"
                page={page}
                resourceId={params.get("resource")}
                resourceHref={previewResourceHref}
                onBack={backToPreviewCollection.bind(null, navigate, page)}
                fetcher={fetcher}
                mutate={commerceMutation}
                canManage={params.get("role") !== "viewer"}
                canOperate={params.get("role") !== "viewer"}
                commerceOperations={PREVIEW_COMMERCE_OPERATIONS}
                priceAllowances={{
                  canConfigure: params.get("role") !== "viewer",
                  transport: PREVIEW_ALLOWANCE_TRANSPORT,
                }}
                descriptionDraftActions={{
                  proposeAction: refusePreviewDescriptionProposal,
                }}
                onActionProposed={ignorePreviewProposal}
              />
            </>
          )}
        </div>
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}

function pageTitle(page: PreviewPage): string {
  switch (page) {
    case "counter":
      return "Counters & payments";
    case "products":
      return "Products";
    case "checkout":
      return "Checkout";
    case "orders":
      return "Orders";
    case "suppliers":
      return "Suppliers";
  }
}

function pageDescription(page: PreviewPage): string {
  switch (page) {
    case "counter":
      return "Review a counter sale and its next available actions.";
    case "products":
      return "Manage products and review their details.";
    case "checkout":
      return "How do customers buy from this storefront?";
    case "orders":
      return "Customer orders projected from the connected commerce system.";
    case "suppliers":
      return "Manage suppliers, supplied items, and purchasing work for low stock.";
  }
}

function previewResourceHref(
  resourceId: string,
  kind: "product" | "order" | "supplier",
): string {
  return `/commerce-preview.html?page=${kind}s&resource=${encodeURIComponent(resourceId)}`;
}

function backToPreviewCollection(
  navigate: NavigateFunction,
  page: PreviewPage,
): void {
  void navigate(`/commerce-preview.html?page=${page}`);
}

async function mount(): Promise<void> {
  const validators = await import("@purin-labs/commerce-contracts/browser-validators");
  await validators.initializeBrowserValidators();
  const container = document.getElementById("root");
  if (container === null) return;
  createRoot(container).render(
    <RouterProvider
      router={createBrowserRouter([{ path: "*", element: <PreviewApp /> }])}
    />,
  );
}

void mount();
