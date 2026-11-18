// The customers built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type { CommerceCustomerCommandV1 } from "@seams/commerce-client";

export * from "./customers.ts";
export * from "./customer-vault.ts";
export { CUSTOMER_SCHEMA } from "./schema.ts";
export {
  CUSTOMERS_BUYER_ROUTE_KINDS,
  CUSTOMERS_ROUTE_ACCESS,
  CUSTOMERS_ROUTES,
  type CustomersRoute,
} from "./routes.ts";
export { CUSTOMERS_COMMAND_EVENTS } from "./events.ts";

/** The commands that this plugin commits through the ledger. */
export type CustomersCommand = CommerceCustomerCommandV1;
