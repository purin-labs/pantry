import {
  CAPABILITY_KEYS,
  capabilityDefinitionById,
} from "../../authorization/capability-catalogue";
import {
  isRequestableCapability,
  isRequestableEntityTypeRead,
  PERMISSION_REQUESTABLE,
  REQUESTABLE_ENTITY_TYPE_READS,
  type RequestableCapability,
  type RequestableEntityTypeRead,
} from "../../authorization/requestable-capabilities";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import type { CatalogExecutionContext } from "./execute";
import type { HarnessCapabilityName, HarnessToolDefinition } from "./types";

export const PERMISSION_REQUEST_TOOL_NAME = "request_permission";

/**
 * What a Slack or Portal chat turn asks a person to allow: capabilities, and
 * reads of closed record types. Pantry keeps only the reads that the requester
 * lacks, and adds the read that a denied read or a draft edit needs.
 */
export type HarnessPermissionRequest = Readonly<{
  capabilityIds: readonly RequestableCapability[];
  entityTypeReads: readonly RequestableEntityTypeRead[];
}>;

export type HarnessPermissionRequestResult =
  | Readonly<{
      kind: "permission_requested";
      detail: string;
      reason?: never;
    }>
  | Readonly<{
      kind: "permission_not_requested";
      reason: string;
      detail?: never;
    }>;

export type HarnessPermissionRequestTool = (
  request: HarnessPermissionRequest,
) => Promise<HarnessPermissionRequestResult>;

/** The requestable capabilities that a turn with these capabilities lacks. */
export function missingRequestableCapabilities(
  allowed: readonly HarnessCapabilityName[],
): readonly RequestableCapability[] {
  const granted = new Set<HarnessCapabilityName>(allowed);
  return PERMISSION_REQUESTABLE.filter(isMissingFrom.bind(null, granted));
}

function isMissingFrom(
  granted: ReadonlySet<HarnessCapabilityName>,
  capability: RequestableCapability,
): boolean {
  return !granted.has(capability);
}

/**
 * The permission tool of a Slack thread turn. Like the follow-up, it is
 * selected by the turn's origin. Its list holds only what this turn lacks, so
 * the agent learns what it may ask for instead of answering that it cannot.
 */
export function permissionRequestDefinition(
  missing: readonly RequestableCapability[],
): HarnessToolDefinition {
  return {
    type: "function",
    name: PERMISSION_REQUEST_TOOL_NAME,
    description:
      "Ask an owner or admin of this workspace to allow work that this turn cannot do yet. In a Slack thread Seams Pantry posts one request with a link; in a Portal chat it shows the person an Allow prompt. When a person allows it, the request continues with the new permission. Ask for everything that the work needs in one call, then tell the person that you asked and stop. Call it directly, outside Code Mode, before you write your answer. Capabilities that you can ask for: " +
      missing.map(requestableCapabilityLine).join("; ") +
      (missing.includes(CAPABILITY_KEYS.commerceActionPropose)
        ? `. When the work changes a price, a listing, a product description, fulfilment tracking, stock, a production request, a purchase request or a merchant plugin, ask for ${CAPABILITY_KEYS.commerceActionPropose} instead of answering that you have no tool; an owner or admin still approves each change`
        : "") +
      '. When the work reads or edits product records, such as a product description draft, also name "product" in entityTypeReads. When it reads or changes prices, also name "offer". When it reads production requests or edits the shared production plan, name "production_requests". When it reads stock, name "inventory_position". When it reads purchase requests, name "replenishment_queue". When it reads customer orders, payments, shipments, stock policies, recipes or suppliers, name "order", "payment", "shipment", "stock_policy", "recipe_revision" or "supplier_directory"; Pantry refuses these six in a shared channel. Pantry asks only for the reads that are missing.' +
      (missing.includes(CAPABILITY_KEYS.commerceMenuDraftRead)
        ? ` When the work reads a menu board on the shop's screens or the shared menu, such as the items or prices that a board shows, ask for ${CAPABILITY_KEYS.commerceMenuDraftRead}; the board tools need it.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.commerceMenuDraftEdit)
        ? ` When the work edits a menu board or the shared menu, or proposes a new price on a board, also ask for ${CAPABILITY_KEYS.commerceMenuDraftEdit}; an owner still approves each price.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.commerceOrderQueueAdvance)
        ? ` When the work moves an order through the shop's order queue, ask for ${CAPABILITY_KEYS.commerceOrderQueueAdvance} and name "order".`
        : "") +
      (missing.includes(CAPABILITY_KEYS.commerceSoldOutMark)
        ? ` When the work marks a menu item sold out today, ask for ${CAPABILITY_KEYS.commerceSoldOutMark} and name "product".`
        : "") +
      (missing.includes(CAPABILITY_KEYS.commerceRecipeSave)
        ? ` When the work adds or edits a recipe, ask for ${CAPABILITY_KEYS.commerceRecipeSave}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.commerceSupplyCostSave)
        ? ` When the work saves supplier pack prices, bulk tiers, fixed daily labor or rent, or Mon-Sun unit plans on Costs & margins, ask for ${CAPABILITY_KEYS.commerceSupplyCostSave}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.commerceSupplierCreate)
        ? ` When the work adds a supplier, ask for ${CAPABILITY_KEYS.commerceSupplierCreate}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.deviceRead)
        ? ` When the work reads the shop's devices or proposes a change to one, ask for ${CAPABILITY_KEYS.deviceRead}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.recipeWorkflowRead)
        ? ` When the work reads a recipe's workflow or the findings of its last run, ask for ${CAPABILITY_KEYS.recipeWorkflowRead}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.recipeWorkflowPropose)
        ? ` When the work proposes a change to a recipe's workflow, ask for ${CAPABILITY_KEYS.recipeWorkflowPropose}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.devicePause)
        ? ` When the work pauses a shop device, ask for ${CAPABILITY_KEYS.devicePause}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.deviceCameraRead)
        ? ` When the work reads when a shop camera took a snapshot, ask for ${CAPABILITY_KEYS.deviceCameraRead}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.jevFeaturesRead)
        ? ` When the work reads the Jev settings or who pays for Jev, ask for ${CAPABILITY_KEYS.jevFeaturesRead}.`
        : "") +
      (missing.includes(CAPABILITY_KEYS.jevFeaturesManage)
        ? ` When the work turns a Jev switch on or off, ask for ${CAPABILITY_KEYS.jevFeaturesManage}.`
        : ""),
    strict: true,
    parameters: {
      type: "object",
      properties: {
        capabilityIds: {
          type: "array",
          items: { type: "string", enum: [...missing] },
          maxItems: missing.length,
        },
        entityTypeReads: {
          type: "array",
          items: { type: "string", enum: [...REQUESTABLE_ENTITY_TYPE_READS] },
          maxItems: REQUESTABLE_ENTITY_TYPE_READS.length,
        },
      },
      required: ["capabilityIds", "entityTypeReads"],
      additionalProperties: false,
    },
  };
}

function requestableCapabilityLine(capability: RequestableCapability): string {
  return `${capability} (${capabilityDefinitionById(capability).label})`;
}

/**
 * A direct call whose read no grant admits asks an owner or admin for the
 * read grant, so the person gets the Allow prompt instead of a denial. A turn
 * that cannot ask keeps the denial.
 */
export async function requestDeniedRead(
  requestPermission: HarnessPermissionRequestTool | undefined,
  execution: CatalogExecutionContext,
  read: RequestableEntityTypeRead | readonly RequestableEntityTypeRead[],
  denial: string,
): Promise<string> {
  if (requestPermission === undefined || execution.kind !== "direct") {
    return denial;
  }
  try {
    const result = await requestPermission({
      capabilityIds: [],
      entityTypeReads: typeof read === "string" ? [read] : read,
    });
    return result.kind === "permission_requested"
      ? result.detail
      : result.reason;
  } catch {
    return denial;
  }
}

/** The call must name at least one item. */
export function parsePermissionRequestArgs(
  input: unknown,
): HarnessPermissionRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["capabilityIds", "entityTypeReads"]) ||
    !Array.isArray(input.capabilityIds) ||
    input.capabilityIds.length > PERMISSION_REQUESTABLE.length ||
    !Array.isArray(input.entityTypeReads) ||
    input.entityTypeReads.length > REQUESTABLE_ENTITY_TYPE_READS.length
  ) {
    throw new TypeError(
      "request_permission accepts only capabilityIds and entityTypeReads",
    );
  }
  const capabilityIds = new Set<RequestableCapability>();
  for (const value of input.capabilityIds) {
    if (!isRequestableCapability(value)) {
      throw new TypeError("request_permission names an unknown capability");
    }
    capabilityIds.add(value);
  }
  const entityTypeReads = new Set<RequestableEntityTypeRead>();
  for (const value of input.entityTypeReads) {
    if (!isRequestableEntityTypeRead(value)) {
      throw new TypeError("request_permission names an unknown record type");
    }
    entityTypeReads.add(value);
  }
  if (capabilityIds.size + entityTypeReads.size === 0) {
    throw new TypeError("request_permission names nothing to allow");
  }
  return {
    capabilityIds: [...capabilityIds],
    entityTypeReads: [...entityTypeReads],
  };
}
