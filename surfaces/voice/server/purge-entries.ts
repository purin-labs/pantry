/**
 * The purge entries of the tables of voice (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const VOICE_PURGE_ENTRIES = [
  {
    order: 1850,
    table: "voice_confirmation",
    action: "erase",
    statement: "DELETE FROM voice_confirmation",
  },
  {
    order: 1860,
    table: "voice_mac",
    action: "erase",
    statement: "DELETE FROM voice_mac",
  },
  {
    order: 1870,
    table: "voice_transcription_use",
    action: "erase",
    statement: "DELETE FROM voice_transcription_use",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
