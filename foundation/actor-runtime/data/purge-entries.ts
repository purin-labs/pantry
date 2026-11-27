/**
 * The purge entries of the tables of the Actor runtime (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const ACTOR_RUNTIME_PURGE_ENTRIES = [
  {
    order: 1150,
    table: "durable_object_registry",
    action: "keep",
    reason:
      "The Actor registry, which the placement owns. The harness erasure empties the Actors that it names.",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
