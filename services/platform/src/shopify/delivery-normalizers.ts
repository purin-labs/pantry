// The normalizers of the Shopify deliveries (Refactor 17, step A2.5). Each
// one gives the normalizer of one Shopify payload to the delivery intake of
// commerce, which checks the canonical delivery.
import type { CanonicalCommerceDelivery } from "@purin-labs/commerce-contracts";
import {
  normalizeShopifyCatalog,
  normalizeShopifyInventory,
  normalizeShopifyOrder,
  normalizeShopifyResource,
} from "@purin-labs/commerce-contracts/shopify-normalizer";
import {
  commerceDeliveryIntake,
  type CommerceWasmError,
} from "../commerce/contract/delivery-intake";
import type { Result } from "@purin-labs/kernel/result";

export function normalizeShopifyCommerceOrderDelivery(
  input: unknown,
): Result<CanonicalCommerceDelivery, CommerceWasmError> {
  return commerceDeliveryIntake
    .use()
    .normalizeCommerceDelivery(input, normalizeShopifyOrder);
}

export function normalizeShopifyCommerceCatalogDelivery(
  input: unknown,
): Result<CanonicalCommerceDelivery, CommerceWasmError> {
  return commerceDeliveryIntake
    .use()
    .normalizeCommerceDelivery(input, normalizeShopifyCatalog);
}

export function normalizeShopifyCommerceInventoryDelivery(
  input: unknown,
): Result<CanonicalCommerceDelivery, CommerceWasmError> {
  return commerceDeliveryIntake
    .use()
    .normalizeCommerceDelivery(input, normalizeShopifyInventory);
}

export function normalizeShopifyCommerceResourceDelivery(
  input: unknown,
): Result<CanonicalCommerceDelivery, CommerceWasmError> {
  return commerceDeliveryIntake
    .use()
    .normalizeCommerceDelivery(input, normalizeShopifyResource);
}
