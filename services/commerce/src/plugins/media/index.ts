// The media built-in plugin (Plan 77 step 3). Code outside this
// directory reaches the plugin only through this file.
import type { CommerceMediaCommandV1 } from "@purin-labs/commerce-client";

export * from "./media.ts";
export * from "./media-store.ts";
export { MEDIA_SCHEMA } from "./schema.ts";
export {
  MEDIA_BUYER_ROUTE_KINDS,
  MEDIA_ROUTE_ACCESS,
  MEDIA_ROUTES,
  type MediaRoute,
} from "./routes.ts";
export { MEDIA_COMMAND_EVENTS } from "./events.ts";

export { removeProductMedia } from "./media.ts";

/** The commands that this plugin commits through the ledger. */
export type MediaCommand = CommerceMediaCommandV1;
