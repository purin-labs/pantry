// The stored-value built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type { CommerceStoredValueCommandV1 } from "@purin-labs/commerce-client";

export * from "./stored-value.ts";
export { STORED_VALUE_SCHEMA } from "./schema.ts";
export {
  STORED_VALUE_BUYER_ROUTE_KINDS,
  STORED_VALUE_ROUTE_ACCESS,
  STORED_VALUE_ROUTES,
  type StoredValueRoute,
} from "./routes.ts";
export { STORED_VALUE_COMMAND_EVENTS } from "./events.ts";

/** The commands that this plugin commits through the ledger. */
export type StoredValueCommand = CommerceStoredValueCommandV1;
