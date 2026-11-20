import { isPlanQuantity } from "@purin-labs/production-plan-crdt";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import type {
  HarnessProductionPlanEdit,
  HarnessProductionPlanRead,
} from "./services";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { jsonSchema } from "../define-tool";
import { defineKitchenTool } from "./services";

export const productionPlanRead = defineKitchenTool({
  name: "production_plan_read",
  description:
    "Read one location's shared production plan: each production request that waits for acceptance, its requested quantity, " +
    "and the planned quantity in the shared plan. People may edit the plan while you work.",
  input: jsonSchema({
    type: "object",
    properties: {
      locationId: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,200}$" },
    },
    required: ["locationId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseProductionPlanReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceProductionPlanEdit,
  },
  unavailable: "production plan read is unavailable",
  handler: ({ readProductionPlan }) =>
    readProductionPlan === undefined ? undefined : (request) => readProductionPlan(request),
});

export const productionPlanEdit = defineKitchenTool({
  name: "production_plan_edit",
  description:
    "Set the planned quantity of one production request in a location's shared plan. Use a requestId from production_plan_read. " +
    "The quantity is a positive decimal in the request's unit; pieces take whole numbers. " +
    "This changes the shared draft only: a person reviews the plan and accepts it.",
  input: jsonSchema({
    type: "object",
    properties: {
      locationId: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,200}$" },
      requestId: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,200}$" },
      quantity: {
        type: "string",
        pattern: "^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$",
      },
    },
    required: ["locationId", "requestId", "quantity"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseProductionPlanEditArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceProductionPlanEdit,
  },
  unavailable: "production plan edit is unavailable",
  handler: ({ editProductionPlan }) =>
    editProductionPlan === undefined
      ? undefined
      : (request, call) =>
          editProductionPlan(request, call.operationId, call.execution),
});

const PLAN_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,200}$/u;

function parseProductionPlanReadArgs(
  args: readonly unknown[],
): HarnessProductionPlanRead {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["locationId"]) ||
    typeof args[0].locationId !== "string" ||
    !PLAN_ID_PATTERN.test(args[0].locationId)
  ) {
    throw new TypeError("production_plan_read arguments are invalid");
  }
  return { locationId: args[0].locationId };
}

function parseProductionPlanEditArgs(
  args: readonly unknown[],
): HarnessProductionPlanEdit {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["locationId", "requestId", "quantity"]) ||
    typeof args[0].locationId !== "string" ||
    !PLAN_ID_PATTERN.test(args[0].locationId) ||
    typeof args[0].requestId !== "string" ||
    !PLAN_ID_PATTERN.test(args[0].requestId) ||
    !isPlanQuantity(args[0].quantity)
  ) {
    throw new TypeError("production_plan_edit arguments are invalid");
  }
  return {
    locationId: args[0].locationId,
    requestId: args[0].requestId,
    quantity: args[0].quantity,
  };
}
