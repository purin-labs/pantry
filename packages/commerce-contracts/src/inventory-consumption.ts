import type { InventoryConsumptionPlan } from "./records/commerce-records.ts";

// Location plans override organisation plans; ambiguous matches fail closed.
export function selectInventoryConsumptionPlan(
  plans: readonly InventoryConsumptionPlan[],
  variantId: string,
  locationId: string | null,
): InventoryConsumptionPlan | undefined {
  const local = [];
  const organisation = [];
  for (const plan of plans) {
    if (plan.variantId !== variantId || plan.lifecycle !== "active") continue;
    if (plan.scope.kind === "organisation") organisation.push(plan);
    else if (plan.scope.locationId === locationId) local.push(plan);
  }
  if (local.length > 0) return local.length === 1 ? local[0] : undefined;
  return organisation.length === 1 ? organisation[0] : undefined;
}
