/**
 * The purge entries of the tables of commerce (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const COMMERCE_PURGE_ENTRIES = [
  {
    order: 410,
    table: "commerce_capability_activation",
    action: "erase",
    statement: "DELETE FROM commerce_capability_activation",
  },
  {
    order: 420,
    table: "commerce_export_preset_publication",
    action: "erase",
    statement: "DELETE FROM commerce_export_preset_publication",
  },
  {
    order: 430,
    table: "commerce_lab_run",
    action: "erase",
    statement: "DELETE FROM commerce_lab_run",
  },
  {
    order: 440,
    table: "commerce_lab_organisation",
    action: "erase",
    statement: "DELETE FROM commerce_lab_organisation",
  },
  {
    order: 880,
    table: "supplier_payout_certification",
    action: "erase",
    statement: "DELETE FROM supplier_payout_certification",
  },
  {
    order: 1520,
    table: "paid_receipt",
    action: "erase",
    statement: "DELETE FROM paid_receipt",
  },
  {
    order: 1740,
    table: "supplier_destination_revision",
    action: "erase",
    statement: "DELETE FROM supplier_destination_revision",
  },
  {
    order: 1750,
    table: "supplier_payout",
    action: "erase",
    statement: "DELETE FROM supplier_payout",
  },
  {
    order: 1760,
    table: "supplier_payable",
    action: "erase",
    statement: "DELETE FROM supplier_payable",
  },
  {
    order: 1770,
    table: "supplier_payout_attempt",
    action: "erase",
    statement: "DELETE FROM supplier_payout_attempt",
  },
  {
    order: 1780,
    table: "supplier_payout_event",
    action: "erase",
    statement: "DELETE FROM supplier_payout_event",
  },
  {
    order: 1790,
    table: "commerce_webhook_subscription",
    action: "erase",
    statement: "DELETE FROM commerce_webhook_subscription",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
