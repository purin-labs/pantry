// Commerce's built-in plugins (Plan 77 step 3). This file is the source
// (Plan 78); `pnpm --filter @seams/commerce-contracts commerce-data:check` checks it.
import type { PluginDefinition } from "./records/plugins.ts";

export const BUILT_IN_PLUGIN_IDS = [
  "collections",
  "media",
  "markets",
  "discounts",
  "customers",
  "draft_orders",
  "returns",
  "stored_value",
  "food_service",
  "purchasing",
  "production_demand",
  "companies",
  "japan_export",
] as const;

export type BuiltInPluginId = (typeof BUILT_IN_PLUGIN_IDS)[number];

/** Commerce's optional features, in the order of `built_in_plugins`. */
export const BUILT_IN_PLUGINS: readonly (PluginDefinition & {
  pluginId: BuiltInPluginId;
})[] = [
  {
    pluginId: "collections",
    version: 1,
    kind: "built_in",
    title: "Collections",
    purpose: "Groups products into manual collections that storefronts show.",
    specSection: 6,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [
        "create_collection",
        "list_collections",
        "update_collection",
        "delete_collection",
        "list_buyer_collections",
        "read_buyer_collection",
      ],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "media",
    version: 1,
    kind: "built_in",
    title: "Media",
    purpose:
      "Keeps product images in object storage and serves them to storefronts.",
    specSection: 5,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [
        "upload_media",
        "create_media",
        "list_media",
        "read_media_content",
        "update_media",
        "delete_media",
        "set_product_media",
        "read_storefront_media",
      ],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "markets",
    version: 1,
    kind: "built_in",
    title: "Markets",
    purpose:
      "Sells a storefront's offers in another currency at converted or fixed prices.",
    specSection: 9,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: ["create_market", "list_markets", "update_market"],
      pipelineSteps: ["market"],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "discounts",
    version: 1,
    kind: "built_in",
    title: "Discounts",
    purpose:
      "Takes code and automatic discounts off checkout lines before tax.",
    specSection: 10,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: ["create_discount", "list_discounts", "deactivate_discount"],
      pipelineSteps: ["discounts"],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "customers",
    version: 1,
    kind: "built_in",
    title: "Customers",
    purpose:
      "Keeps customer records with sealed profiles, sign-in and saved addresses.",
    specSection: 16,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [
        "create_customer",
        "update_customer",
        "erase_customer",
        "read_customer",
        "export_customer",
        "request_customer_sign_in",
        "verify_customer_sign_in",
        "read_buyer_customer",
        "save_customer_address",
      ],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "draft_orders",
    version: 1,
    kind: "built_in",
    title: "Draft orders",
    purpose:
      "Lets staff build an order for a buyer, send an invoice link or mark it as paid.",
    specSection: 13,
    requirements: {
      hookPoints: [],
      reads: [],
      commands: [],
      dependsOn: ["customers"],
    },
    contributions: {
      routes: [
        "create_draft_order",
        "read_draft_order",
        "update_draft_order",
        "send_draft_invoice",
        "cancel_draft_order",
        "mark_draft_order_paid",
        "open_draft_invoice",
      ],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "returns",
    version: 1,
    kind: "built_in",
    title: "Returns and exchanges",
    purpose:
      "Takes return requests from buyers and staff, receives the units and exchanges them.",
    specSection: 15,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [
        "request_return",
        "list_order_returns",
        "authorize_return",
        "receive_return",
        "close_return",
        "request_buyer_return",
        "exchange_order_lines",
      ],
      pipelineSteps: [],
      entityTypes: [],
      settings: [
        {
          key: "returnWindowDays",
          valueKind: "integer",
          description:
            "Days after fulfilment that a buyer may ask for a return: 0 to 365, 30 when not set.",
        },
      ],
      functions: [],
    },
  },
  {
    pluginId: "stored_value",
    version: 1,
    kind: "built_in",
    title: "Gift cards and store credit",
    purpose:
      "Issues gift cards and store credit that pay at checkout after tax.",
    specSection: 17,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [
        "issue_gift_card",
        "credit_store_credit",
        "disable_stored_value_account",
        "list_stored_value_accounts",
        "read_stored_value_liability",
        "read_gift_card_balance",
        "place_buyer_stored_value_checkout",
      ],
      pipelineSteps: ["stored_value"],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "food_service",
    version: 1,
    kind: "built_in",
    title: "Food service",
    purpose:
      "Sells menus with recipes and modifiers, and runs preparation tickets and batches.",
    specSection: 21,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [
        "create_preparation_station",
        "create_modifier_group_revision",
        "create_recipe_revision",
        "configure_stock_policy",
        "publish_menu",
        "read_food_service_snapshot",
        "read_preparation_ticket",
        "read_pickup_queue",
        "read_sold_out_marks",
        "mark_sold_out",
        "manage_preparation_ticket",
        "complete_production_batch",
      ],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "purchasing",
    version: 1,
    kind: "built_in",
    title: "Purchasing",
    purpose:
      "Turns supplier records into purchase plans and reconciles what arrives.",
    specSection: 20,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [
        "entity_plane_purchasing_preset",
        "entity_plane_purchasing_reconcile",
      ],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "production_demand",
    version: 1,
    kind: "built_in",
    title: "Production demand",
    purpose: "Publishes the demand that open orders put on production.",
    specSection: 20,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: ["publish_production_demand_preset"],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "companies",
    version: 1,
    kind: "built_in",
    title: "B2B companies",
    purpose:
      "Gives the customers of a business their company's prices and invoice terms.",
    specSection: 16,
    requirements: {
      hookPoints: [],
      reads: [],
      commands: [],
      dependsOn: ["customers"],
    },
    contributions: {
      routes: [
        "create_company",
        "list_companies",
        "update_company",
        "place_draft_order_on_terms",
        "record_invoice_payment",
        "list_invoices",
      ],
      pipelineSteps: ["lines"],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
  {
    pluginId: "japan_export",
    version: 1,
    kind: "built_in",
    title: "Japan export shipping",
    purpose:
      "Ships from Japan: routes to each country, carrier rates, tax and duty, labels and tracking.",
    specSection: 14,
    requirements: { hookPoints: [], reads: [], commands: [], dependsOn: [] },
    contributions: {
      routes: [],
      pipelineSteps: ["shipping"],
      entityTypes: [],
      settings: [],
      functions: [],
    },
  },
];

/**
 * The command and receipt resource kinds that each built-in plugin adds to
 * the mutation receipt. The client's enums join them with the core's.
 */
export const BUILT_IN_PLUGIN_RECEIPT_KINDS = {
  collections: {
    commands: ["create_collection", "update_collection", "delete_collection"],
    resources: ["collection"],
  },
  media: {
    commands: [
      "create_media",
      "update_media",
      "delete_media",
      "set_product_media",
    ],
    resources: ["media", "product_media"],
  },
  markets: {
    commands: ["create_market", "update_market"],
    resources: ["market"],
  },
  discounts: {
    commands: ["create_discount", "deactivate_discount"],
    resources: ["discount"],
  },
  customers: {
    commands: ["create_customer", "update_customer", "erase_customer"],
    resources: ["customer"],
  },
  draft_orders: {
    commands: [
      "create_draft_order",
      "update_draft_order",
      "send_draft_invoice",
      "cancel_draft_order",
      "mark_draft_order_paid",
    ],
    resources: ["draft_order"],
  },
  returns: {
    commands: [
      "request_return",
      "authorize_return",
      "receive_return",
      "close_return",
      "exchange_order_lines",
    ],
    resources: ["return"],
  },
  stored_value: {
    commands: [
      "issue_gift_card",
      "credit_store_credit",
      "disable_stored_value_account",
    ],
    resources: ["stored_value_account"],
  },
  food_service: {
    commands: [
      "create_preparation_station",
      "create_modifier_group_revision",
      "create_recipe_revision",
      "configure_stock_policy",
      "publish_menu",
      "mark_sold_out",
      "manage_preparation_ticket",
      "complete_production_batch",
    ],
    resources: [
      "sold_out_mark",
      "preparation_ticket",
      "preparation_station",
      "modifier_group_revision",
      "recipe_revision",
      "stock_policy",
      "menu",
      "production_batch",
    ],
  },
  purchasing: {
    commands: [],
    resources: [],
  },
  production_demand: {
    commands: [],
    resources: [],
  },
  companies: {
    commands: [
      "create_company",
      "update_company",
      "place_draft_order_on_terms",
      "record_invoice_payment",
      "mark_invoice_overdue",
    ],
    resources: ["company", "company_invoice"],
  },
  japan_export: {
    commands: [],
    resources: [],
  },
} as const satisfies Readonly<
  Record<
    BuiltInPluginId,
    Readonly<{ commands: readonly string[]; resources: readonly string[] }>
  >
>;
