/**
 * The purge entries of the tables of the integrations (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const INTEGRATIONS_PURGE_ENTRIES = [
  {
    order: 520,
    table: "credential_rotation",
    action: "erase",
    statement: "DELETE FROM credential_rotation",
  },
  {
    order: 550,
    table: "custom_connector_setup_attempt",
    action: "erase",
    statement: "DELETE FROM custom_connector_setup_attempt",
  },
  {
    order: 560,
    table: "custom_connector_account_binding",
    action: "erase",
    statement: "DELETE FROM custom_connector_account_binding",
  },
  {
    order: 570,
    table: "custom_connector_revision",
    action: "erase",
    statement: "DELETE FROM custom_connector_revision",
  },
  {
    order: 720,
    table: "mail_classification_eligibility",
    action: "erase",
    statement: "DELETE FROM mail_classification_eligibility",
  },
  {
    order: 760,
    table: "provider_account_cleanup",
    action: "erase",
    statement: "DELETE FROM provider_account_cleanup",
  },
  {
    order: 1050,
    table: "custom_connector",
    action: "erase",
    statement: "DELETE FROM custom_connector",
  },
  {
    order: 1130,
    table: "discord_interaction_install",
    action: "erase",
    statement: "DELETE FROM discord_interaction_install",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
