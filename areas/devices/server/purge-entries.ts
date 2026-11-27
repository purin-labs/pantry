/**
 * The purge entries of the tables of the devices (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const DEVICES_PURGE_ENTRIES = [
  {
    order: 1060,
    table: "device_alert",
    action: "erase",
    statement: "DELETE FROM device_alert",
  },
  {
    order: 1070,
    table: "device_alert_setting",
    action: "erase",
    statement: "DELETE FROM device_alert_setting",
  },
  {
    order: 1080,
    table: "device_camera_policy",
    action: "erase",
    statement: "DELETE FROM device_camera_policy",
  },
  {
    order: 1090,
    table: "device_enrollment",
    action: "erase",
    statement: "DELETE FROM device_enrollment",
  },
  {
    order: 1100,
    table: "device_event",
    action: "erase",
    statement: "DELETE FROM device_event",
  },
  {
    order: 1110,
    table: "device_gateway",
    action: "erase",
    statement: "DELETE FROM device_gateway",
  },
  {
    order: 1120,
    table: "device_snapshot",
    action: "erase",
    statement: "DELETE FROM device_snapshot",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
