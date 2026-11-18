import { describe, expect, it } from "vitest";

import {
  buildHomeView,
  type HomeViewBuildInput,
} from "../src/control/routes/workspace";
import { requireCaseId } from "./test-ids";

const OBSERVED_AT = "2026-07-26T00:00:00.000Z";

describe("CafeOS Home view", () => {
  it("keeps governed work bounded and removes technical action fields", () => {
    const input: HomeViewBuildInput = {
      generatedAt: Date.parse(OBSERVED_AT),
      projection: readyProjection(),
      role: "viewer",
      operationsUnavailable: false,
      actionLedger: Array.from({ length: 10 }, createActionActivity),
    };

    const view = buildHomeView(input);

    expect(view.home.attention).toHaveLength(5);
    expect(
      view.home.attention.every((item) => item.kind === "governed_action"),
    ).toBe(true);
    expect(view.home.attention[0]).not.toHaveProperty("actionNonce");
    expect(view.home.attention[0]).not.toHaveProperty("resourceKey");
    expect(view.home.today).toEqual([]);
    expect(view.home.sourceObservations[0]).toMatchObject({
      kind: "governed_work",
      status: "current",
    });
    expect(view.home.sourceObservations[0]?.observedAt).toMatch(
      /^2026-07-26T00:00:00\.00[0-9]Z$/u,
    );
    expect(view.home.sourceObservations[1]).toEqual({
      kind: "workspace_readiness",
      status: "current",
      observedAt: OBSERVED_AT,
    });
  });

  it("returns a recoverable blocker when governed operations are unavailable", () => {
    const view = buildHomeView({
      generatedAt: Date.parse(OBSERVED_AT),
      projection: readyProjection(),
      role: "viewer",
      operationsUnavailable: true,
      actionLedger: [],
    });

    expect(view.home.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "synchronization",
          title: "Operations are unavailable",
          nextAction: expect.objectContaining({
            destination: { kind: "operations" },
          }),
        }),
      ]),
    );
  });
});

function readyProjection(): HomeViewBuildInput["projection"] {
  return {
    organisation: {
      organisation_id: "organisation_home_view",
      name: "Home view workspace",
      plan: "beta",
      lifecycle: {
        kind: "active",
        organisation_id: "organisation_home_view",
        activation_receipt_id: "receipt_home_view",
        activated_at: Date.parse(OBSERVED_AT),
        environment: "development",
      },
      capability_profile: "read_and_propose",
      created_at: Date.parse(OBSERVED_AT),
    },
    readiness: {
      kind: "ready",
      readiness_version: 1,
      readiness_hash: "home_view_hash",
      requirements: [],
      configuration_version: 1,
      approval_authentication: [],
      assessed_at: Date.parse(OBSERVED_AT),
    },
    updated_at: Date.parse(OBSERVED_AT),
  };
}

function createActionActivity(
  _value: unknown,
  index: number,
): HomeViewBuildInput["actionLedger"][number] {
  return {
    action: {
      nonce: {
        value: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      },
      host: "satyr.commerce",
      verb: "commerce.order.cancel",
      resourceKey: `commerce:cancel_order:order_home_${index}`,
    },
    caseId: requireCaseId(`case_home_${index}`),
    proposalId: `proposal_home_${index}`,
    state: "proposed",
    createdAt: Date.parse(OBSERVED_AT) + index,
    updatedAt: Date.parse(OBSERVED_AT) + index,
  };
}
