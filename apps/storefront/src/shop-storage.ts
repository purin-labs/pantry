/**
 * The shop whose data a browser storage key holds. Every order page shares
 * the origin `menu.<domain>`, and every café storefront has the same id, so
 * a key names the merchant too.
 */
export type StorageShop = Readonly<{
  merchantId: string;
  storefrontId: string;
}>;

/** The order status link that a buyer returns to. */
export function orderStatusStorageKey(shop: StorageShop): string {
  return shopStorageKey("order-status", shop);
}

/** The checkout that the page restores after a reload. */
export function checkoutStorageKey(shop: StorageShop): string {
  return shopStorageKey("checkout", shop);
}

/** The kiosk mode of a shop's device. */
export function kioskStorageKey(shop: StorageShop): string {
  return shopStorageKey("kiosk", shop);
}

function shopStorageKey(kind: string, shop: StorageShop): string {
  return `pantry.${kind}.${shop.merchantId}.${shop.storefrontId}`;
}
