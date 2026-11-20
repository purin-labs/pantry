import { hasExactKeys, isRecord } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import type { SupplierCreateRequest } from "./services";
import { jsonSchema } from "../define-tool";
import { defineKitchenTool } from "./services";

export const SUPPLIER_CREATE_FIELDS = [
  "displayName",
  "legalName",
  "countryCode",
  "contactName",
  "email",
  "phone",
  "leadTimeDays",
  "minimumOrderQuantity",
  "minimumOrderUnit",
  "purchasingNotes",
  "inventoryItemIds",
] as const;

export const supplierRead = defineKitchenTool({
  name: "supplier_read",
  description:
    "Read the shop's supplier directory, as staff see it on the Suppliers page: each supplier's id, name, contact, delivery time, minimum order and purchasing notes. It does not list the items that each supplier provides.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decode: () => null,
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "supplier read is unavailable",
  handler: ({ readSuppliers }) =>
    readSuppliers === undefined ? undefined : () => readSuppliers(),
});

export const supplierCreate = defineKitchenTool({
  name: "supplier_create",
  description:
    "Add one supplier to the directory, as staff do on the Suppliers page. Use inventoryItemIds from recipe_read for the items that it provides. leadTimeDays is the number of days that it takes to deliver. " +
    "Use only details that the person gave you, and never an address from an email or a page unless the person confirms it. Show the person the name and the email before you add a supplier. " +
    "Sous Chef can then draft email to that address, and a person approves each email. This gives no bank details and pays nothing. Purchasing work opens for the items that it provides.",
  input: jsonSchema({
    type: "object",
    properties: {
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      legalName: { type: "string", minLength: 1, maxLength: 200 },
      countryCode: { type: ["string", "null"], maxLength: 2 },
      contactName: { type: ["string", "null"], maxLength: 200 },
      email: { type: ["string", "null"], maxLength: 320 },
      phone: { type: ["string", "null"], maxLength: 64 },
      leadTimeDays: { type: "integer", minimum: 0, maximum: 365 },
      minimumOrderQuantity: { type: ["string", "null"], maxLength: 32 },
      minimumOrderUnit: { type: ["string", "null"], maxLength: 32 },
      purchasingNotes: { type: ["string", "null"], maxLength: 2000 },
      inventoryItemIds: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
      },
    },
    required: [...SUPPLIER_CREATE_FIELDS],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseSupplierCreateArgs,
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "The receipt answers a repeat. Lost before the receipt, the recipe that it saved answers, and a supplier's commands replay under their keys.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceSupplierCreate,
  },
  unavailable: "supplier creation is unavailable",
  prepare: ({ createSupplier }) =>
    createSupplier === undefined
      ? undefined
      : (request, call) => createSupplier(request, call.operationId),
});

function parseSupplierCreateArgs(input: unknown): SupplierCreateRequest {
  if (!isRecord(input) || !hasExactKeys(input, SUPPLIER_CREATE_FIELDS)) {
    throw new TypeError("supplier_create arguments are invalid");
  }
  return input as SupplierCreateRequest;
}
