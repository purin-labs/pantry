import {
  StrictObject,
  checkContract,
  type ContractDecodeResult,
  type ContractRejection,
  NonNegativeInteger as count,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import type { StrictUnion } from "@purin-labs/type-utils";
import { javascriptTrimmedTextSchema } from "./identity-text.ts";
import { commerceSnapshotRevisionSchema } from "./query-metadata.ts";

export const SUPPLIER_DIRECTORY_LIST_ID = "supplier_directory" as const;
export const SUPPLIER_ENTITY_TYPE_ID = "trade_partner" as const;
export const REPLENISHMENT_QUEUE_LIST_ID = "replenishment_queue" as const;
export const SUPPLY_COST_TERMS_LIST_ID = "supply_cost_terms" as const;
export const SUPPLIER_INVENTORY_ITEM_DEFINITION_ID =
  "supplier_inventory_item" as const;
export const SUPPLIERS_VIEW_ID = "suppliers" as const;
export const REPLENISHMENT_QUEUE_VIEW_ID = "replenishment_queue" as const;
export const SUPPLY_COST_TERMS_VIEW_ID = "supply_cost_terms" as const;

const identity = {
  organisationId: javascriptTrimmedTextSchema,
  merchantId: javascriptTrimmedTextSchema,
};
const purchasingPresetPublishRequestSchema = StrictObject(identity);
export type CommercePurchasingPresetPublishRequest = Readonly<
  Static<typeof purchasingPresetPublishRequestSchema>
>;
const purchasingPresetPublishResponseSchema = StrictObject({
  kind: Type.Literal("published"),
  ...identity,
  merchantRevision: commerceSnapshotRevisionSchema,
});
export type CommercePurchasingPresetPublishResponse = Readonly<
  Static<typeof purchasingPresetPublishResponseSchema>
>;
const purchasingReconcileRequestSchema = purchasingPresetPublishRequestSchema;
export type CommercePurchasingReconcileRequest = Readonly<
  Static<typeof purchasingReconcileRequestSchema>
>;
const responseIdentity = {
  ...identity,
  merchantRevision: commerceSnapshotRevisionSchema,
};

const purchasingReconcileResponseSchema = Type.Union([
  StrictObject({ kind: Type.Literal("inactive"), ...responseIdentity }),
  StrictObject({
    kind: Type.Literal("reconciled"),
    ...responseIdentity,
    opened: count,
    updated: count,
    received: count,
  }),
]);
export type CommercePurchasingReconcileResponse = StrictUnion<
  Readonly<Static<typeof purchasingReconcileResponseSchema>>
>;

export function parsePurchasingPresetPublishRequest(
  input: unknown,
): ContractDecodeResult<CommercePurchasingPresetPublishRequest> {
  return checkContract(
    purchasingPresetPublishRequestSchema,
    input,
    invalidPurchasingEnvelope,
  );
}
export function parsePurchasingPresetPublishResponse(
  input: unknown,
): ContractDecodeResult<CommercePurchasingPresetPublishResponse> {
  return checkContract(
    purchasingPresetPublishResponseSchema,
    input,
    invalidPurchasingEnvelope,
  );
}
export function parsePurchasingReconcileRequest(
  input: unknown,
): ContractDecodeResult<CommercePurchasingReconcileRequest> {
  return checkContract(
    purchasingReconcileRequestSchema,
    input,
    invalidPurchasingEnvelope,
  );
}
export function parsePurchasingReconcileResponse(
  input: unknown,
): ContractDecodeResult<CommercePurchasingReconcileResponse> {
  return checkContract(
    purchasingReconcileResponseSchema,
    input,
    invalidPurchasingEnvelope,
  );
}
function invalidPurchasingEnvelope(): ContractRejection {
  return {
    code: "parse",
    reason: "invalid purchasing envelope",
    details: null,
  };
}
