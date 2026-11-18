import type {
  DurableObjectLocationHint,
  PlacementCellId,
  PlacementEpoch,
  OrganisationPlacement,
} from "./placement";

declare const placementEpoch: PlacementEpoch;
declare const placementCellId: PlacementCellId;
declare const locationHint: DurableObjectLocationHint;

const affinityPlacement: OrganisationPlacement = {
  kind: "affinity",
  placementEpoch,
  placementCellId,
  locationHint,
};

const residencyPlacement: OrganisationPlacement = {
  kind: "residency",
  placementEpoch,
  placementCellId,
  locationHint,
  residencyJurisdiction: "eu",
};

const affinityWithResidency: OrganisationPlacement = {
  kind: "affinity",
  placementEpoch,
  placementCellId,
  locationHint,
  // @ts-expect-error affinity placement cannot carry a hard residency claim.
  residencyJurisdiction: "eu",
};

// @ts-expect-error residency placement requires an admitted jurisdiction.
const residencyWithoutJurisdiction: OrganisationPlacement = {
  kind: "residency",
  placementEpoch,
  placementCellId,
  locationHint,
};

void affinityPlacement;
void residencyPlacement;
void affinityWithResidency;
void residencyWithoutJurisdiction;
