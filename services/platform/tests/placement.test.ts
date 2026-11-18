import { describe, expect, it } from "vitest";

import {
  parseInitialOrganisationPlacement,
  parseOrganisationPlacement,
} from "../src/placement";

describe("organisation placement boundary", () => {
  it("parses an admitted hard-residency placement", () => {
    const parsed = parseInitialOrganisationPlacement({
      kind: "residency",
      placementEpoch: 1,
      placementCellId: "eu-residency",
      locationHint: "weur",
      residencyJurisdiction: "eu",
    });

    expect(parsed.ok).toBe(true);
  });

  it("rejects affinity placement carrying a residency claim", () => {
    const parsed = parseOrganisationPlacement({
      kind: "affinity",
      placementEpoch: 1,
      placementCellId: "multi-region-preview",
      locationHint: "wnam",
      residencyJurisdiction: "eu",
    });

    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "invalid_organisation_placement",
        path: "placement.residencyJurisdiction",
      },
    });
  });

  it("rejects unsupported location hints and initial epochs", () => {
    expect(
      parseInitialOrganisationPlacement({
        kind: "affinity",
        placementEpoch: 1,
        placementCellId: "multi-region-preview",
        locationHint: "anywhere",
      }).ok,
    ).toBe(false);

    expect(
      parseInitialOrganisationPlacement({
        kind: "affinity",
        placementEpoch: 2,
        placementCellId: "multi-region-preview",
        locationHint: "wnam",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "invalid_organisation_placement",
        path: "placement.placementEpoch",
      },
    });
  });
});
