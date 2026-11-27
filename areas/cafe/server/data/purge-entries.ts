/**
 * The purge entries of the tables of the Café (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const CAFE_PURGE_ENTRIES = [
  {
    order: 350,
    table: "cafe_counter_receipt_setting",
    action: "erase",
    statement: "DELETE FROM cafe_counter_receipt_setting",
  },
  {
    order: 360,
    table: "cafe_terminal_assignment",
    action: "erase",
    statement: "DELETE FROM cafe_terminal_assignment",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
