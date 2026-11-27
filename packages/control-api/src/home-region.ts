/**
 * The region that holds an organisation's data and runs its agents. Pantry
 * places a new organisation in the deployed region nearest to the person who
 * makes it, at a Portal sign-up and at a Slack install alike. No Portal page
 * offers a choice.
 */
type OrganisationHomeRegionArea =
  "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

type OrganisationHomeRegion = Readonly<{
  id: string;
  area: OrganisationHomeRegionArea;
}>;

/** `suggested` is the choice nearest to the request, and one of `choices`. */
export type OrganisationHomeRegions = Readonly<{
  suggested: string;
  choices: readonly OrganisationHomeRegion[];
}>;
