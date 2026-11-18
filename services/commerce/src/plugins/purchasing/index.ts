import type { PurchasingExtension } from "../built-in-ports.ts";
import { PURCHASING_PRESET } from "./purchasing-preset.ts";
import { PurchasingReplenishment } from "./purchasing-replenishment.ts";
import { checkReceiptPurchase } from "./receipt-purchase.ts";
import { checkPurchaseRequestPatch } from "./purchase-request.ts";

export const purchasingExtension: PurchasingExtension = {
  preset: PURCHASING_PRESET,
  replenishment: (context) => new PurchasingReplenishment(context),
  checkReceiptPurchase,
  checkRequestPatch: checkPurchaseRequestPatch,
};
export {
  PURCHASING_BUYER_ROUTE_KINDS,
  PURCHASING_ROUTE_ACCESS,
  PURCHASING_ROUTES,
  type PurchasingRoute,
} from "./routes.ts";
