/**
 * The purge entries of the tables of the connections (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const CONNECTIONS_PURGE_ENTRIES = [
  {
    order: 730,
    table: "organisation_commerce_system",
    action: "erase",
    statement: "DELETE FROM organisation_commerce_system",
  },
  {
    order: 770,
    table: "provider_authorization_state",
    action: "erase",
    statement: "DELETE FROM provider_authorization_state",
  },
  {
    order: 780,
    table: "provider_provisioning_receipt",
    action: "erase",
    statement: "DELETE FROM provider_provisioning_receipt",
    where:
      "provisioning_attempt_id IN (SELECT provisioning_attempt_id FROM provider_provisioning_attempt WHERE organisation_id = ?)",
  },
  {
    order: 790,
    table: "provider_provisioning_attempt",
    action: "erase",
    statement: "DELETE FROM provider_provisioning_attempt",
  },
  {
    order: 800,
    table: "provider_connection_attempt",
    action: "erase",
    statement: "DELETE FROM provider_connection_attempt",
  },
  {
    order: 810,
    table: "provider_default_account_history",
    action: "erase",
    statement: "DELETE FROM provider_default_account_history",
  },
  {
    order: 820,
    table: "provider_manifest_observation",
    action: "erase",
    statement: "DELETE FROM provider_manifest_observation",
  },
  {
    order: 830,
    table: "provider_resource_cursor",
    action: "erase",
    statement: "DELETE FROM provider_resource_cursor",
  },
  {
    order: 840,
    table: "provider_discovered_resource",
    action: "erase",
    statement: "DELETE FROM provider_discovered_resource",
    where:
      "snapshot_revision IN (SELECT snapshot_revision FROM provider_resource_snapshot WHERE organisation_id = ?)",
  },
  {
    order: 850,
    table: "provider_resource_snapshot",
    action: "erase",
    statement: "DELETE FROM provider_resource_snapshot",
  },
  {
    order: 860,
    table: "provider_webhook",
    action: "erase",
    statement: "DELETE FROM provider_webhook",
  },
  {
    order: 1000,
    table: "integration_account",
    action: "pseudonymize",
    reason:
      "Each account loses its provider identity and is revoked; the directory's revoked Slack connections name it. A custom API account is erased with its connector.",
  },
  {
    order: 1030,
    table: "provider_credential_generation",
    action: "pseudonymize",
    reason:
      "Each generation loses its credential reference. The generations of a custom API connection are erased.",
  },
  {
    order: 1040,
    table: "provider_connection",
    action: "pseudonymize",
    reason:
      "Each connection loses its provider subject and its credential reference and is revoked. A custom API connection is erased with its connector.",
  },
  {
    order: 1800,
    table: "commerce_merchant_binding",
    action: "erase",
    statement: "DELETE FROM commerce_merchant_binding",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
