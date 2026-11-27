/**
 * The purge entries of the tables of Slack (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const SLACK_PURGE_ENTRIES = [
  {
    order: 870,
    table: "slack_message_proposal",
    action: "erase",
    statement: "DELETE FROM slack_message_proposal",
  },
  {
    order: 1010,
    table: "external_identity_link",
    action: "erase",
    statement: "DELETE FROM external_identity_link",
  },
  {
    order: 1020,
    table: "external_identity_link_challenge",
    action: "erase",
    statement: "DELETE FROM external_identity_link_challenge",
  },
  {
    order: 1730,
    table: "slack_conversation_fact",
    action: "erase",
    statement: "DELETE FROM slack_conversation_fact",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
