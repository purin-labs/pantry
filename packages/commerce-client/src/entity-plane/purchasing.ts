import type {
  CommercePurchasingPresetPublishRequest,
  CommercePurchasingPresetPublishResponse,
  CommercePurchasingReconcileRequest,
  CommercePurchasingReconcileResponse,
} from "@purin-labs/commerce-contracts/entity-plane-purchasing";
export type {
  CommercePurchasingPresetPublishRequest,
  CommercePurchasingPresetPublishResponse,
  CommercePurchasingReconcileRequest,
  CommercePurchasingReconcileResponse,
} from "@purin-labs/commerce-contracts/entity-plane-purchasing";
export {
  SUPPLIER_DIRECTORY_LIST_ID,
  SUPPLIER_ENTITY_TYPE_ID,
  REPLENISHMENT_QUEUE_LIST_ID,
  SUPPLY_COST_TERMS_LIST_ID,
  SUPPLIER_INVENTORY_ITEM_DEFINITION_ID,
  SUPPLIERS_VIEW_ID,
  REPLENISHMENT_QUEUE_VIEW_ID,
  SUPPLY_COST_TERMS_VIEW_ID,
} from "@purin-labs/commerce-contracts/entity-plane-purchasing";
import * as purchasingContracts from "@purin-labs/commerce-contracts/entity-plane-purchasing";
import { decodeRecord } from "./record-decoding.ts";

export function parsePurchasingPresetPublishRequest(
  value: unknown,
): CommercePurchasingPresetPublishRequest {
  return decodeRecord(
    purchasingContracts.parsePurchasingPresetPublishRequest,
    value,
  );
}

export function parsePurchasingPresetPublishResponse(
  value: unknown,
): CommercePurchasingPresetPublishResponse {
  return decodeRecord(
    purchasingContracts.parsePurchasingPresetPublishResponse,
    value,
  );
}

export function parsePurchasingReconcileRequest(
  value: unknown,
): CommercePurchasingReconcileRequest {
  return decodeRecord(
    purchasingContracts.parsePurchasingReconcileRequest,
    value,
  );
}

export function parsePurchasingReconcileResponse(
  value: unknown,
): CommercePurchasingReconcileResponse {
  return decodeRecord(
    purchasingContracts.parsePurchasingReconcileResponse,
    value,
  );
}
