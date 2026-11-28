/**
 * The plan catalog (Plan 95, "Plans"). `organisation.plan` names one entry.
 * A new plan needs an entry here and a D1 patch for the plan column, not a
 * table.
 */
export type OrganisationPlanId = "beta";

export type OrganisationPlan = Readonly<{
  id: OrganisationPlanId;
  /** The name that the Portal and the agent show. */
  name: string;
  /** Plan 88 D3: the free Jev use of each UTC month, as TypeSafe cost. */
  freeJevUseMicrousd: number;
  /** The monthly limit of paid Jev use until the owner sets one, in US cents. */
  defaultSpendingLimitMinor: number;
  /** The highest monthly limit that an owner can set, in US cents. */
  highestSpendingLimitMinor: number;
}>;

const PLAN_CATALOG: Readonly<Record<OrganisationPlanId, OrganisationPlan>> =
  Object.freeze({
    beta: Object.freeze({
      id: "beta",
      name: "Beta",
      freeJevUseMicrousd: 1_000_000,
      defaultSpendingLimitMinor: 500,
      highestSpendingLimitMinor: 1_000,
    }),
  });

/** The plan of a new Organisation, and of each Organisation today. */
export const DEFAULT_PLAN_ID: OrganisationPlanId = "beta";

export function organisationPlan(id: OrganisationPlanId): OrganisationPlan {
  return PLAN_CATALOG[id];
}

/** The catalog entry of a stored plan value, or null for an unknown value. */
export function parseOrganisationPlan(raw: unknown): OrganisationPlan | null {
  return typeof raw === "string" && Object.hasOwn(PLAN_CATALOG, raw)
    ? PLAN_CATALOG[raw as OrganisationPlanId]
    : null;
}
