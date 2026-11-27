/**
 * The purge entries of the tables of authority (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const AUTHORITY_PURGE_ENTRIES = [
  {
    order: 40,
    table: "access_grant",
    action: "erase",
    statement: "DELETE FROM access_grant",
  },
  {
    order: 200,
    table: "agent_permission_request",
    action: "erase",
    statement: "DELETE FROM agent_permission_request",
  },
  {
    order: 490,
    table: "credential_access_denial",
    action: "keep",
    reason:
      "Metadata of each refused credential read: its purpose, its reason and the handle, with no secret. It is the audit of access after the archive.",
  },
  {
    order: 500,
    table: "credential_ref",
    action: "erase",
    statement: "DELETE FROM credential_ref",
  },
  {
    order: 510,
    table: "credential_revocation_operation",
    action: "keep",
    reason:
      "Counts of what each credential revocation removed: the receipt that the revocation happened.",
  },
  {
    order: 1170,
    table: "external_vault_import",
    action: "erase",
    statement: "DELETE FROM external_vault_import",
  },
  {
    order: 1190,
    table: "held_output_request",
    action: "erase",
    statement: "DELETE FROM held_output_request",
  },
  {
    order: 1330,
    table: "organisation_capability_policy",
    action: "erase",
    statement: "DELETE FROM organisation_capability_policy",
  },
  {
    order: 1530,
    table: "person_authz_role",
    action: "erase",
    statement: "DELETE FROM person_authz_role",
  },
  {
    order: 1570,
    table: "person_authz_audit",
    action: "erase",
    statement: "DELETE FROM person_authz_audit",
  },
  {
    order: 1580,
    table: "policy_snapshot",
    action: "erase",
    statement: "DELETE FROM policy_snapshot",
  },
  {
    order: 1810,
    table: "vault_item",
    action: "erase",
    statement: "DELETE FROM vault_item",
  },
  {
    order: 1820,
    table: "vault_item_event",
    action: "erase",
    statement: "DELETE FROM vault_item_event",
  },
  {
    order: 1830,
    table: "vault_secret",
    action: "erase",
    statement: "DELETE FROM vault_secret",
  },
  {
    order: 1840,
    table: "vault_store",
    action: "erase",
    statement: "DELETE FROM vault_store",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
