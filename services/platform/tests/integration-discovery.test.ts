// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { IntegrationDiscoveryView } from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";
import { parseIntegrationDiscoveryView } from "../src/access-control/integration-discovery";
import { PROVIDER_ADAPTERS } from "../src/provider-adapters/catalogue";
import type { ActiveIntegrationProvider } from "@purin-labs/connections/data/integration-provider-directory";

describe("agent integration discovery", function integrationDiscoverySuite() {
  it("accepts only the bounded redacted model projection", function parsesProjection() {
    const view = validView();
    expect(parseIntegrationDiscoveryView(view)).toEqual({
      ok: true,
      value: view,
    });
    expect(
      parseIntegrationDiscoveryView({
        ...view,
        accounts: [
          {
            ...view.accounts[0],
            providerAccountId: "acct_secret",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: { code: "integration_discovery_unavailable", stage: "accounts" },
    });
    expect(
      parseIntegrationDiscoveryView({
        ...view,
        accounts: [
          {
            ...view.accounts[0],
            readableDataClasses: ["payments", "mail"],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseIntegrationDiscoveryView({
        ...view,
        accounts: [view.accounts[0], view.accounts[0]],
      }).ok,
    ).toBe(false);
  });

  it("accepts every provider the adapter catalogue can project", function parsesEveryProvider() {
    const view = validView();
    for (const provider of Object.keys(
      PROVIDER_ADAPTERS,
    ) as ActiveIntegrationProvider[]) {
      const projected = {
        ...view,
        accounts: [
          {
            ...view.accounts[0],
            provider,
            configuredDataClasses: [...PROVIDER_ADAPTERS[provider].dataClasses],
          },
        ],
      };
      expect(parseIntegrationDiscoveryView(projected), provider).toEqual({
        ok: true,
        value: projected,
      });
    }
  });
});

function validView(): IntegrationDiscoveryView {
  return {
    observedAt: 1,
    accounts: [
      {
        accountRef: `integration_ref_${"a".repeat(64)}`,
        provider: "stripe",
        displayName: "Cafe Stripe",
        connection: "available",
        configuredDataClasses: ["payments"],
        readableDataClasses: [],
      },
    ],
    truncated: false,
  };
}
