// A merchant's state of each plugin (Plan 77 step 3). A plugin with no row
// is active at revision 1 with no settings; a change writes the row with the
// next revision. A built-in plugin's settings (schema 79) are what staff set;
// the plugin gives a default for each one that they did not.
import type { CommercePluginSettingsV1 } from "@seams/commerce-client";
import type { BuiltInPluginId, PluginState } from "@seams/commerce-contracts";

import type { CommerceDatabase } from "../database.ts";

export type PluginStateRecord = Readonly<{
  state: PluginState;
  revision: number;
  settings: CommercePluginSettingsV1;
}>;

/** What a built-in plugin's settings are, and what it accepts. */
export type BuiltInPluginSettings = Readonly<{
  /** A value for each setting that the definition names. */
  defaults: CommercePluginSettingsV1;
  /**
   * The key of a setting whose value the plugin refuses, or undefined; the
   * settings have the defaults filled in and the kinds that the definition
   * names.
   */
  problem: (settings: CommercePluginSettingsV1) => string | undefined;
}>;

export function readPluginState(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
): PluginStateRecord {
  const row = database
    .prepare(
      `SELECT state, revision, settings_json AS settingsJson FROM plugin_state
       WHERE merchant_id = ? AND plugin_id = ?`,
    )
    .get<
      Readonly<{ state: PluginState; revision: number; settingsJson: string }>
    >(merchantId, pluginId);
  return row === undefined
    ? { state: "active", revision: 1, settings: {} }
    : {
        state: row.state,
        revision: row.revision,
        settings: JSON.parse(row.settingsJson) as CommercePluginSettingsV1,
      };
}

/** Whether a built-in plugin's routes answer and its pipeline steps run. */
export function pluginActive(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: BuiltInPluginId,
): boolean {
  return readPluginState(database, merchantId, pluginId).state === "active";
}

/**
 * Writes the next revision, with the settings it had when `next` has none;
 * it throws when another change came first.
 */
export function writePluginState(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  next: Readonly<{
    state: PluginState;
    revision: number;
    settings?: CommercePluginSettingsV1;
  }>,
  updatedAt: string,
): void {
  const settingsJson =
    next.settings === undefined ? null : JSON.stringify(next.settings);
  const written = database
    .prepare(
      `INSERT INTO plugin_state (
         merchant_id, plugin_id, revision, state, settings_json, updated_at
       )
       SELECT ?, ?, ?, ?, COALESCE(?, '{}'), ?
       WHERE COALESCE(
         (SELECT revision FROM plugin_state WHERE merchant_id = ? AND plugin_id = ?),
         1
       ) = ?
       ON CONFLICT (merchant_id, plugin_id) DO UPDATE SET
         revision = excluded.revision,
         state = excluded.state,
         settings_json = COALESCE(?, settings_json),
         updated_at = excluded.updated_at`,
    )
    .run(
      merchantId,
      pluginId,
      next.revision,
      next.state,
      settingsJson,
      updatedAt,
      merchantId,
      pluginId,
      next.revision - 1,
      settingsJson,
    );
  if (written.changes !== 1)
    throw new Error(`Plugin ${pluginId} changed during the write`);
}
