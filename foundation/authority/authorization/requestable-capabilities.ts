import type { AgentPermissionEntityTypeRead } from "@purin-labs/control-api";
import type { EntityTypeReadAudience } from "./access-grants/entity-type-reads";
import {
  CAPABILITY_KEYS,
  capabilityDefinitionById,
} from "./capability-catalogue";

/**
 * The capabilities that an agent may ask an owner or admin to allow. Each one
 * reads Pantry records, edits a Pantry draft, proposes a commerce change or takes
 * a step that staff take on the shop's pages: the order queue, recipes and the
 * supplier directory. None moves money. A proposed change waits for an owner or admin to approve it, every
 * time. An agent cannot ask for anything outside this list.
 */
export const PERMISSION_REQUESTABLE = [
  CAPABILITY_KEYS.commerceActionPropose,
  CAPABILITY_KEYS.commerceEntityPlaneContext,
  CAPABILITY_KEYS.commerceProductDescriptionDraftEdit,
  CAPABILITY_KEYS.commerceWorkflowCanvasMove,
  CAPABILITY_KEYS.commerceMenuDraftRead,
  CAPABILITY_KEYS.commerceMenuDraftEdit,
  CAPABILITY_KEYS.marketingEmailDraftEdit,
  CAPABILITY_KEYS.commerceProductionPlanEdit,
  CAPABILITY_KEYS.commerceOrderQueueAdvance,
  CAPABILITY_KEYS.commerceSoldOutMark,
  CAPABILITY_KEYS.commerceRecipeSave,
  CAPABILITY_KEYS.commerceSupplyCostSave,
  CAPABILITY_KEYS.commerceSupplierCreate,
  CAPABILITY_KEYS.deviceRead,
  CAPABILITY_KEYS.devicePause,
  CAPABILITY_KEYS.recipeWorkflowRead,
  CAPABILITY_KEYS.recipeWorkflowPropose,
  CAPABILITY_KEYS.deviceCameraRead,
  CAPABILITY_KEYS.jevFeaturesRead,
  CAPABILITY_KEYS.jevFeaturesManage,
  CAPABILITY_KEYS.organisationLogoChange,
  CAPABILITY_KEYS.bakeRead,
  CAPABILITY_KEYS.bakePropose,
  CAPABILITY_KEYS.bakeRunPause,
] as const;

export type RequestableCapability = (typeof PERMISSION_REQUESTABLE)[number];

const REQUESTABLE_CAPABILITIES: ReadonlySet<string> = new Set(
  PERMISSION_REQUESTABLE,
);

export function isRequestableCapability(
  value: unknown,
): value is RequestableCapability {
  return typeof value === "string" && REQUESTABLE_CAPABILITIES.has(value);
}

/**
 * The reads that a permission request may include: every record of a system
 * type ("product") or every entry of one commerce list
 * ("production_requests"). A draft tool reads its source under a
 * `commerce.entity.read` grant for that scope. The agent may name one of
 * these reads, and Pantry adds the read that a denied read or a draft edit
 * needs. A request keeps only the reads that the requester lacks, and a
 * person allows each one. The stored field keeps its first name,
 * `entityTypeReads`.
 */
export const REQUESTABLE_ENTITY_TYPE_READS = [
  "product",
  "offer",
  "inventory_position",
  "production_requests",
  "replenishment_queue",
  "order",
  "payment",
  "shipment",
  "stock_policy",
  "recipe_revision",
  "supplier_directory",
] as const satisfies readonly AgentPermissionEntityTypeRead[];

/**
 * Orders, payments and shipments hold customer data, and a stock policy reads
 * beside them in the same reports. An agent asks for one of these reads only
 * in a Portal chat or a direct message, so that one click never opens them to
 * a shared channel (owner's decision, 2026-11-02). Recipes are the shop's trade
 * secret, and the supplier directory holds people's names, emails and phone
 * numbers, so they follow the same rule.
 */
const PRIVATE_CHAT_READS: ReadonlySet<string> = new Set([
  "order",
  "payment",
  "shipment",
  "stock_policy",
  "recipe_revision",
  "supplier_directory",
]);

export function readNeedsPrivateChat(read: RequestableEntityTypeRead): boolean {
  return PRIVATE_CHAT_READS.has(read);
}

/** The commerce read scope that a requestable read's grant covers. */
type RequestableReadScope =
  | Readonly<{
      kind: "entity_type";
      typeId:
        | "product"
        | "offer"
        | "inventory_position"
        | "order"
        | "payment"
        | "shipment"
        | "stock_policy"
        | "recipe_revision";
    }>
  | Readonly<{
      kind: "commerce_list";
      listId:
        "production_requests" | "replenishment_queue" | "supplier_directory";
    }>;

export function requestableReadScope(
  read: RequestableEntityTypeRead,
): RequestableReadScope {
  switch (read) {
    case "product":
    case "offer":
    case "inventory_position":
    case "order":
    case "payment":
    case "shipment":
    case "stock_policy":
    case "recipe_revision":
      return { kind: "entity_type", typeId: read };
    case "production_requests":
    case "replenishment_queue":
    case "supplier_directory":
      return { kind: "commerce_list", listId: read };
  }
}

export type RequestableEntityTypeRead =
  (typeof REQUESTABLE_ENTITY_TYPE_READS)[number];

/** The capability that a record-type read grant gives. */
export const ENTITY_TYPE_READ_CAPABILITY = CAPABILITY_KEYS.commerceEntityRead;

const REQUESTABLE_READS: ReadonlySet<string> = new Set(
  REQUESTABLE_ENTITY_TYPE_READS,
);

export function isRequestableEntityTypeRead(
  value: unknown,
): value is RequestableEntityTypeRead {
  return typeof value === "string" && REQUESTABLE_READS.has(value);
}

/** The record type that a requested capability cannot work without. */
const IMPLIED_ENTITY_TYPE_READS: Readonly<
  Partial<Record<RequestableCapability, RequestableEntityTypeRead>>
> = {
  [CAPABILITY_KEYS.commerceProductDescriptionDraftEdit]: "product",
  [CAPABILITY_KEYS.commerceProductionPlanEdit]: "production_requests",
  [CAPABILITY_KEYS.commerceRecipeSave]: "recipe_revision",
  [CAPABILITY_KEYS.commerceSupplyCostSave]: "recipe_revision",
  [CAPABILITY_KEYS.commerceSupplierCreate]: "supplier_directory",
};

export function impliedEntityTypeReads(
  capabilityIds: readonly RequestableCapability[],
): readonly RequestableEntityTypeRead[] {
  const reads = new Set<RequestableEntityTypeRead>();
  for (const capability of capabilityIds) {
    const read = IMPLIED_ENTITY_TYPE_READS[capability];
    if (read !== undefined) reads.add(read);
  }
  return [...reads];
}

export function entityTypeReadLabel(read: RequestableEntityTypeRead): string {
  switch (read) {
    case "product":
      return "Read product records";
    case "offer":
      return "Read prices";
    case "inventory_position":
      return "Read stock levels";
    case "production_requests":
      return "Read production requests";
    case "replenishment_queue":
      return "Read purchase requests";
    case "order":
      return "Read customer orders";
    case "payment":
      return "Read payments";
    case "shipment":
      return "Read shipments";
    case "stock_policy":
      return "Read stock policies";
    case "recipe_revision":
      return "Read recipes";
    case "supplier_directory":
      return "Read suppliers";
  }
}

export function entityTypeReadDescription(
  read: RequestableEntityTypeRead,
  audience: EntityTypeReadAudience,
): string {
  switch (read) {
    case "product":
      return audience === "conversation"
        ? "Read product names and descriptions to answer in the Slack channel, where everyone sees the answer."
        : "Read product names and descriptions in drafts, Portal chats and direct messages.";
    case "offer":
      return audience === "conversation"
        ? "Read the prices and availability of products to answer in the Slack channel, where everyone sees the answer."
        : "Read the prices and availability of products in Portal chats and direct messages.";
    case "inventory_position":
      return audience === "conversation"
        ? "Read how much stock each location holds to answer in the Slack channel, where everyone sees the answer."
        : "Read how much stock each location holds in Portal chats and direct messages.";
    case "replenishment_queue":
      return audience === "conversation"
        ? "Read the items, quantities, suppliers and dates of purchase requests to answer in the Slack channel, where everyone sees the answer."
        : "Read the items, quantities, suppliers and dates of purchase requests in Portal chats and direct messages.";
    case "production_requests":
      return audience === "conversation"
        ? "Read the products, quantities and dates of production requests to answer in the Slack channel, where everyone sees the answer."
        : "Read the products, quantities and dates of production requests. Every role sees the shared production plan, so an agent may change the plan only when every role may read the requests.";
    case "order":
      return "Read customer orders in Portal chats and direct messages, with any customer details on each order. This does not open them to a Slack channel.";
    case "payment":
      return "Read payments and their results in Portal chats and direct messages, with any customer details on each payment. This does not open them to a Slack channel.";
    case "shipment":
      return "Read shipments and their delivery status in Portal chats and direct messages, with any customer details on each shipment. This does not open them to a Slack channel.";
    case "stock_policy":
      return "Read reorder points and low stock flags in Portal chats and direct messages. This does not open them to a Slack channel.";
    case "recipe_revision":
      return "Read recipes, their ingredients and batch yields, and the names of stock items, in Portal chats and direct messages. This does not open them to a Slack channel.";
    case "supplier_directory":
      return "Read suppliers, their contacts, delivery times and purchasing notes in Portal chats and direct messages. This does not open them to a Slack channel.";
  }
}

/** The labels of the requested items, joined for one sentence. */
export function permissionLabels(
  capabilityIds: readonly RequestableCapability[],
  entityTypeReads: readonly RequestableEntityTypeRead[],
): string {
  const labels = [
    ...entityTypeReads.map(entityTypeReadLabel),
    ...capabilityIds.map(capabilityLabel),
  ].map(lowerFirst);
  return labels.length <= 1
    ? labels.join("")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function capabilityLabel(capability: RequestableCapability): string {
  return capabilityDefinitionById(capability).label;
}

function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
