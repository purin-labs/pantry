// The draft-orders built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type { CommerceDraftOrderCommandV1 } from "@purin-labs/commerce-client";

export * from "./draft-orders.ts";
export { DRAFT_ORDER_SCHEMA } from "./schema.ts";
export {
  DRAFT_ORDERS_BUYER_ROUTE_KINDS,
  DRAFT_ORDERS_ROUTE_ACCESS,
  DRAFT_ORDERS_ROUTES,
  type DraftOrdersRoute,
} from "./routes.ts";
export { DRAFT_ORDERS_COMMAND_EVENTS } from "./events.ts";

export { draftOrderCitesVariant } from "./draft-orders.ts";

/** The commands that this plugin commits through the ledger. */
export type DraftOrdersCommand = CommerceDraftOrderCommandV1;
