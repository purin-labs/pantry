import type { applyCommerceDelivery } from "../../actors/commerce-projection";
import type { normalizeCommerceDelivery } from "../commerce-wasm";
import { definePort } from "../../port";

export type {
  AppliedCommerceDeliveryResult,
  CommerceProjectionError,
  CommerceSystemStorageAuthority,
} from "../../actors/commerce-projection";
export type { CommerceWasmError } from "../commerce-wasm";

/**
 * The intake of a provider delivery, as a service interface of the commerce
 * contract. A provider module, such as Shopify, gives its normalizer of a
 * provider payload; commerce checks the canonical delivery that it returns
 * and applies it to the commerce projection. The Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type CommerceDeliveryIntake = Readonly<{
  /** Runs a provider normalizer and checks the canonical delivery. */
  normalizeCommerceDelivery: typeof normalizeCommerceDelivery;
  /** Applies one canonical delivery to the commerce projection. */
  applyCommerceDelivery: typeof applyCommerceDelivery;
}>;

export const commerceDeliveryIntake = definePort<CommerceDeliveryIntake>(
  "commerce_delivery_intake",
);
