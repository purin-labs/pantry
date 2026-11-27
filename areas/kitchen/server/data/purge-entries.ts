/**
 * The purge entries of the tables of the Kitchen (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const KITCHEN_PURGE_ENTRIES = [
  {
    order: 220,
    table: "bake_run",
    action: "erase",
    statement: "DELETE FROM bake_run",
  },
  {
    order: 230,
    table: "bake_proposal",
    action: "erase",
    statement: "DELETE FROM bake_proposal",
  },
  {
    order: 240,
    table: "bake_stock_level",
    action: "erase",
    statement: "DELETE FROM bake_stock_level",
  },
  {
    order: 250,
    table: "bake_authority",
    action: "erase",
    statement: "DELETE FROM bake_authority",
  },
  {
    order: 260,
    table: "bakery_agent_run_save",
    action: "erase",
    statement: "DELETE FROM bakery_agent_run_save",
  },
  {
    order: 270,
    table: "bakery_agent_scenario_save",
    action: "erase",
    statement: "DELETE FROM bakery_agent_scenario_save",
  },
  {
    order: 280,
    table: "bakery_cost_plan",
    action: "erase",
    statement: "DELETE FROM bakery_cost_plan",
  },
  {
    order: 290,
    table: "bakery_cost_product_plan",
    action: "erase",
    statement: "DELETE FROM bakery_cost_product_plan",
  },
  {
    order: 300,
    table: "bakery_lot_invoice_cost",
    action: "erase",
    statement: "DELETE FROM bakery_lot_invoice_cost",
  },
  {
    order: 310,
    table: "bakery_surface_timeline_event",
    action: "erase",
    statement: "DELETE FROM bakery_surface_timeline_event",
  },
  {
    order: 320,
    table: "bakery_surface_effect_delivery",
    action: "erase",
    statement: "DELETE FROM bakery_surface_effect_delivery",
  },
  {
    order: 330,
    table: "bakery_workflow",
    action: "erase",
    statement: "DELETE FROM bakery_workflow",
  },
  {
    order: 340,
    table: "bakery_workflow_revision",
    action: "erase",
    statement: "DELETE FROM bakery_workflow_revision",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
