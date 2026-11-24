import { moveStoredValue } from "@purin-labs/std";

// The browser keeps the simulator's custom vitrine orders under this key.
const VITRINE_CUSTOM_ORDERS_STORAGE_KEY =
  "pantry.kitchen.vitrineCustomOrders.v1";
// The key before the product names changed; its value moves one time.
const RENAMED_VITRINE_CUSTOM_ORDERS_STORAGE_KEY =
  "pantry.bakeryos.vitrineCustomOrders.v1";

/** The stored custom orders, or null when the browser keeps none. */
export function readStoredVitrineOrders(): string | null {
  if (typeof globalThis.localStorage === "undefined") return null;
  moveStoredValue(
    globalThis.localStorage,
    RENAMED_VITRINE_CUSTOM_ORDERS_STORAGE_KEY,
    VITRINE_CUSTOM_ORDERS_STORAGE_KEY,
  );
  return globalThis.localStorage.getItem(VITRINE_CUSTOM_ORDERS_STORAGE_KEY);
}

/** Stores the custom orders, or removes them when `json` is null. */
export function writeStoredVitrineOrders(json: string | null): void {
  if (typeof globalThis.localStorage === "undefined") return;
  if (json === null)
    globalThis.localStorage.removeItem(VITRINE_CUSTOM_ORDERS_STORAGE_KEY);
  else globalThis.localStorage.setItem(VITRINE_CUSTOM_ORDERS_STORAGE_KEY, json);
}
