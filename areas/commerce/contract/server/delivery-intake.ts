import type { CanonicalCommerceDelivery } from "@purin-labs/commerce-contracts";
import type { CommerceBoundaryResponse } from "@purin-labs/commerce-contracts/commerce-boundary";
import type { Result } from "@purin-labs/kernel/result";
import { definePort } from "@purin-labs/kernel/port";
import type {
  AppliedCommerceDeliveryResult,
  ApplyCommerceDeliveryInput,
  CommerceProjectionError,
  CommerceSystemStorageAuthority,
  InventoryStockChange,
} from "./commerce-projection";

export type {
  AppliedCommerceDeliveryResult,
  CommerceProjectionError,
  CommerceSystemStorageAuthority,
} from "./commerce-projection";

export type CommerceWasmError =
  | { readonly code: "commerce_wasm_input_invalid" }
  | { readonly code: "commerce_wasm_response_invalid" }
  | {
      readonly code: "commerce_wasm_rejected";
      readonly reason: string;
    };

/**
 * Runs a normalizer of a provider payload and checks the canonical delivery
 * that it returns (`normalizeCommerceDelivery` of `commerce-wasm.ts`).
 */
type NormalizeCommerceDelivery = (
  input: unknown,
  typescript: (input: unknown) => CommerceBoundaryResponse,
) => Result<CanonicalCommerceDelivery, CommerceWasmError>;

/**
 * Applies one canonical delivery to the commerce projection
 * (`applyCommerceDelivery` of `actors/commerce-projection.ts`). Each change of
 * the available stock of a position is added to `stockChanges`.
 */
type ApplyCommerceDelivery = (
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  commerceSystem: CommerceSystemStorageAuthority,
  stockChanges?: InventoryStockChange[],
) => Result<AppliedCommerceDeliveryResult, CommerceProjectionError>;

/**
 * The intake of a provider delivery, as a service interface of the commerce
 * contract. A provider module, such as Shopify, gives its normalizer of a
 * provider payload; commerce checks the canonical delivery that it returns
 * and applies it to the commerce projection. The Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type CommerceDeliveryIntake = Readonly<{
  /** Runs a provider normalizer and checks the canonical delivery. */
  normalizeCommerceDelivery: NormalizeCommerceDelivery;
  /** Applies one canonical delivery to the commerce projection. */
  applyCommerceDelivery: ApplyCommerceDelivery;
}>;

export const commerceDeliveryIntake = definePort<CommerceDeliveryIntake>(
  "commerce_delivery_intake",
);
