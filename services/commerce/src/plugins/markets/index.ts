// The markets built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type { CommerceMarketCommandV1 } from "@seams/commerce-client";

export * from "./markets.ts";
export { MARKET_SCHEMA } from "./schema.ts";
export {
  MARKETS_BUYER_ROUTE_KINDS,
  MARKETS_ROUTE_ACCESS,
  MARKETS_ROUTES,
  type MarketsRoute,
} from "./routes.ts";
export { MARKETS_COMMAND_EVENTS } from "./events.ts";

export { marketCitesVariant } from "./markets.ts";

/** The commands that this plugin commits through the ledger. */
export type MarketsCommand = CommerceMarketCommandV1;
