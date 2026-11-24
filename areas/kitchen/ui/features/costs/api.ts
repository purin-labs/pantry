import type {
  CostUnit,
  CostsSheetSaved,
} from "@purin-labs/kitchen-control-api";
import type { ControlMutationIntent } from "@purin-labs/control/portal/control-client";

export type CostsMutation = (
  path: string,
  body: unknown,
  intent: ControlMutationIntent,
) => Promise<unknown>;

export function costsPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/costs`;
}

export function costsError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Costs and margins are unavailable. Try again.";
}

/** The notice of a sheet save that saved some records before a refusal. */
export function partlySavedNotice(
  saved: CostsSheetSaved,
  reason: string,
): string {
  const parts: string[] = [];
  const prices = saved.offerIds.length;
  const packs = saved.inventoryItemIds.length;
  if (prices > 0) parts.push(`${prices} ${prices === 1 ? "price" : "prices"}`);
  if (packs > 0) {
    parts.push(`${packs} supplier ${packs === 1 ? "pack" : "packs"}`);
  }
  return `Saved ${parts.join(" and ")}. The other changes did not save: ${reason} Save again to send them.`;
}

export function formatCostQuantity(amount: number, unit: CostUnit): string {
  const rounded =
    Math.abs(amount) >= 100
      ? Math.round(amount * 10) / 10
      : Math.round(amount * 100) / 100;
  const label: Record<CostUnit, string> = {
    each: "ea",
    gram: "g",
    kilogram: "kg",
    milliliter: "ml",
    liter: "L",
  };
  return `${rounded.toLocaleString()} ${label[unit]}`;
}

export function compatibleUnitsForBase(baseUnit: CostUnit): readonly CostUnit[] {
  switch (baseUnit) {
    case "gram":
    case "kilogram":
      return ["gram", "kilogram"];
    case "milliliter":
    case "liter":
      return ["milliliter", "liter"];
    case "each":
      return ["each"];
  }
}
