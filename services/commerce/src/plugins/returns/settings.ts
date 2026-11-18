// The returns plugin's settings (Plan 77 step 3): how many days after
// fulfilment a buyer may still ask for a return.
import type { CommercePluginSettingsV1 } from "@seams/commerce-client";

import type { BuiltInPluginSettings } from "../plugin-state.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const RETURNS_SETTINGS: BuiltInPluginSettings = {
  defaults: { returnWindowDays: 30 },
  problem: (settings) => {
    const days = settings.returnWindowDays;
    return typeof days === "number" && days >= 0 && days <= 365
      ? undefined
      : "returnWindowDays";
  },
};

/** How long after fulfilment a buyer may ask for a return. */
export function returnWindowMs(settings: CommercePluginSettingsV1): number {
  return Number(settings.returnWindowDays) * DAY_MS;
}
