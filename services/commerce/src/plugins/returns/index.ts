// The returns built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type {
  CommerceReturnCommandV1,
  ExchangeCommerceOrderLinesV1,
} from "@purin-labs/commerce-client";

export * from "./returns.ts";
export { ORDER_RETURN_SCHEMA } from "./schema.ts";
export {
  RETURNS_BUYER_ROUTE_KINDS,
  RETURNS_ROUTE_ACCESS,
  RETURNS_ROUTES,
  type ReturnsRoute,
} from "./routes.ts";
export { RETURNS_COMMAND_EVENTS } from "./events.ts";
export { RETURNS_SETTINGS } from "./settings.ts";

/** The commands that this plugin commits through the ledger. */
export type ReturnsCommand =
  CommerceReturnCommandV1 | ExchangeCommerceOrderLinesV1;
