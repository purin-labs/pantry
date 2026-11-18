import { hasExactKeys, isRecord } from "@seams/std";

/**
 * The region that holds an organisation's data and runs its agents. A person
 * chooses it when they create the organisation.
 */
export type OrganisationHomeRegionArea =
  "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

export type OrganisationHomeRegion = Readonly<{
  id: string;
  area: OrganisationHomeRegionArea;
}>;

/** `suggested` is the choice nearest to the request, and one of `choices`. */
export type OrganisationHomeRegions = Readonly<{
  suggested: string;
  choices: readonly OrganisationHomeRegion[];
}>;

const AREAS: Readonly<Record<OrganisationHomeRegionArea, true>> = {
  wnam: true,
  enam: true,
  sam: true,
  weur: true,
  eeur: true,
  apac: true,
  oc: true,
  afr: true,
  me: true,
};

export function isOrganisationHomeRegionArea(
  raw: unknown,
): raw is OrganisationHomeRegionArea {
  return typeof raw === "string" && Object.hasOwn(AREAS, raw);
}

export function parseOrganisationHomeRegions(
  raw: unknown,
): OrganisationHomeRegions | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["suggested", "choices"]) ||
    typeof raw.suggested !== "string" ||
    !Array.isArray(raw.choices)
  ) {
    return null;
  }
  const choices: OrganisationHomeRegion[] = [];
  for (const choice of raw.choices) {
    if (
      !isRecord(choice) ||
      !hasExactKeys(choice, ["id", "area"]) ||
      typeof choice.id !== "string" ||
      choice.id.length === 0 ||
      !isOrganisationHomeRegionArea(choice.area)
    ) {
      return null;
    }
    choices.push({ id: choice.id, area: choice.area });
  }
  return choices.some(isChoice.bind(null, raw.suggested))
    ? { suggested: raw.suggested, choices }
    : null;
}

function isChoice(id: string, choice: OrganisationHomeRegion): boolean {
  return choice.id === id;
}
