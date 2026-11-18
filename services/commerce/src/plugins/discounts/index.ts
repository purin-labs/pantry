// The discounts built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type { CommerceDiscountCommandV1 } from "@seams/commerce-client";

export * from "./discounts.ts";
export { DISCOUNT_SCHEMA } from "./schema.ts";
export {
  DISCOUNTS_BUYER_ROUTE_KINDS,
  DISCOUNTS_ROUTE_ACCESS,
  DISCOUNTS_ROUTES,
  type DiscountsRoute,
} from "./routes.ts";
export { DISCOUNTS_COMMAND_EVENTS } from "./events.ts";

export { discountCitesProduct } from "./discounts.ts";

/** The commands that this plugin commits through the ledger. */
export type DiscountsCommand = CommerceDiscountCommandV1;
