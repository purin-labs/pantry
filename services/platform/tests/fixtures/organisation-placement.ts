import { parseInitialOrganisationPlacement } from "@purin-labs/tenancy/placement";

const parsedPlacement = parseInitialOrganisationPlacement({
  kind: "affinity",
  placementEpoch: 1,
  placementCellId: "multi-region-preview",
  locationHint: "wnam",
});

if (!parsedPlacement.ok) {
  throw new Error(parsedPlacement.error.path);
}

export const TEST_INITIAL_ORGANISATION_PLACEMENT = parsedPlacement.value;

export const TEST_ORGANISATION_PLACEMENT_PROFILE = JSON.stringify({
  databaseBinding: "DB",
  kind: TEST_INITIAL_ORGANISATION_PLACEMENT.kind,
  placementCellId: TEST_INITIAL_ORGANISATION_PLACEMENT.placementCellId,
  locationHint: TEST_INITIAL_ORGANISATION_PLACEMENT.locationHint,
});

export const TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW = {
  placementKind: TEST_INITIAL_ORGANISATION_PLACEMENT.kind,
  placementEpoch: 1,
  placementCellId: TEST_INITIAL_ORGANISATION_PLACEMENT.placementCellId,
  locationHint: TEST_INITIAL_ORGANISATION_PLACEMENT.locationHint,
  residencyJurisdiction: null,
  fenceToken: "fixture-control-fence",
  status: "active",
  createdAt: 1,
  activatedAt: 1,
  frozenAt: null,
  abandonedAt: null,
  retiredAt: null,
};
