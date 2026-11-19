// The built-in plugins (Plan 77 step 3): their definitions come from
// BUILT_IN_PLUGINS in @purin-labs/commerce-contracts, and their routes from each
// plugin's routes.ts. Each route belongs to the core or to one plugin; a
// plugin whose definition does not name exactly the routes it defines stops
// Commerce at start.
import type { CommercePluginSettingsV1 } from "@purin-labs/commerce-client";
import {
  BUILT_IN_PLUGINS,
  type BuiltInPluginId,
  type PluginDefinition,
} from "@purin-labs/commerce-contracts";

import { PLUGIN_ROUTES } from "../http-routes.ts";
import { settingMatches } from "./merchant-plugins.ts";
import type { BuiltInPluginSettings } from "./plugin-state.ts";
import { RETURNS_SETTINGS } from "./returns/index.ts";
import type { CollectionsCommand } from "./collections/index.ts";
import type { MediaCommand } from "./media/index.ts";
import type { MarketsCommand } from "./markets/index.ts";
import type { DiscountsCommand } from "./discounts/index.ts";
import type { CustomersCommand } from "./customers/index.ts";
import type { DraftOrdersCommand } from "./draft-orders/index.ts";
import type { ReturnsCommand } from "./returns/index.ts";
import type { StoredValueCommand } from "./stored-value/index.ts";
import type { CompaniesCommand } from "./companies/index.ts";
import type { FoodServiceCommand } from "./food-service/index.ts";

export type BuiltInPlugin = PluginDefinition & { pluginId: BuiltInPluginId };

const ROUTE_OWNERS = new Map<string, BuiltInPlugin>();
for (const plugin of BUILT_IN_PLUGINS) {
  const defined = new Set<string>(
    (PLUGIN_ROUTES[plugin.pluginId] ?? []).map((route) => route.kind),
  );
  const named = new Set(plugin.contributions.routes);
  if (
    defined.size !== named.size ||
    [...named].some((route) => !defined.has(route))
  )
    throw new Error(
      `Plugin ${plugin.pluginId} names other routes than its routes.ts defines`,
    );
  for (const route of named) ROUTE_OWNERS.set(route, plugin);
}

/**
 * Each built-in plugin's settings. A plugin's defaults name exactly the
 * settings of its definition, with their kinds, or Commerce stops at start.
 */
const PLUGIN_SETTINGS: Partial<Record<BuiltInPluginId, BuiltInPluginSettings>> =
  { returns: RETURNS_SETTINGS };
for (const plugin of BUILT_IN_PLUGINS) {
  const defaults = PLUGIN_SETTINGS[plugin.pluginId]?.defaults ?? {};
  const named = plugin.contributions.settings;
  if (
    Object.keys(defaults).length !== named.length ||
    named.some(
      (setting) => !settingMatches(setting.valueKind, defaults[setting.key]),
    )
  )
    throw new Error(
      `Plugin ${plugin.pluginId} has other defaults than the settings it names`,
    );
}

/** A built-in plugin's settings: what staff set, else its defaults. */
export function builtInPluginSettings(
  pluginId: BuiltInPluginId,
  stored: CommercePluginSettingsV1,
): CommercePluginSettingsV1 {
  return { ...PLUGIN_SETTINGS[pluginId]?.defaults, ...stored };
}

/**
 * The field of a built-in plugin's settings that it refuses, or undefined:
 * a key that its definition does not name, a value of another kind, or a
 * value that the plugin itself refuses.
 */
export function builtInSettingsProblem(
  plugin: BuiltInPlugin,
  settings: CommercePluginSettingsV1,
): string | undefined {
  for (const [key, value] of Object.entries(settings)) {
    const setting = plugin.contributions.settings.find(
      (named) => named.key === key,
    );
    if (setting === undefined || !settingMatches(setting.valueKind, value))
      return `settings.${key}`;
  }
  const problem = PLUGIN_SETTINGS[plugin.pluginId]?.problem(
    builtInPluginSettings(plugin.pluginId, settings),
  );
  return problem === undefined ? undefined : `settings.${problem}`;
}

export function builtInPlugin(pluginId: string): BuiltInPlugin | undefined {
  return BUILT_IN_PLUGINS.find((plugin) => plugin.pluginId === pluginId);
}

/** The plugin that owns a route, or undefined for a core route. */
export function pluginOfRoute(routeKind: string): BuiltInPlugin | undefined {
  return ROUTE_OWNERS.get(routeKind);
}

/** Every command that a built-in plugin commits through the ledger. */
export type BuiltInPluginCommand =
  | CollectionsCommand
  | MediaCommand
  | MarketsCommand
  | DiscountsCommand
  | CustomersCommand
  | DraftOrdersCommand
  | ReturnsCommand
  | StoredValueCommand
  | CompaniesCommand
  | FoodServiceCommand;
