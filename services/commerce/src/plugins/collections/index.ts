// The collections built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type { CommerceCollectionCommandV1 } from "@purin-labs/commerce-client";

export * from "./collections.ts";
export { COLLECTION_SCHEMA } from "./schema.ts";
export {
  COLLECTIONS_BUYER_ROUTE_KINDS,
  COLLECTIONS_ROUTE_ACCESS,
  COLLECTIONS_ROUTES,
  type CollectionsRoute,
} from "./routes.ts";
export { COLLECTIONS_COMMAND_EVENTS } from "./events.ts";

export { removeProductFromCollections } from "./collections.ts";

/** The commands that this plugin commits through the ledger. */
export type CollectionsCommand = CommerceCollectionCommandV1;
