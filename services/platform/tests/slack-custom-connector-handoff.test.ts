import { describe, expect, it } from "vitest";

import { customConnectorSetupHandoff } from "@purin-labs/surface-slack/server/case-processing";

describe("Slack custom connector setup handoff", () => {
  it("keeps viewers out of connector authoring", () => {
    expect(
      customConnectorSetupHandoff({
        text: "Create a custom connector for this service",
        mayConfigure: false,
        portalUrl: "https://pantry.example/ignored",
      }),
    ).toBe(
      "You can view connector setup, but an owner or admin must create and connect a custom API.",
    );
  });

  it("leaves ordinary API discussion with the agent", () => {
    expect(
      customConnectorSetupHandoff({
        text: "Summarize the API errors from yesterday",
        mayConfigure: true,
        portalUrl: "https://pantry.example/ignored",
      }),
    ).toBeNull();
  });
});
