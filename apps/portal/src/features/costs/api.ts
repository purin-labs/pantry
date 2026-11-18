import type { CostUnit } from "@seams/control-api";
import type { ControlMutationIntent } from "../../control-client";

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
