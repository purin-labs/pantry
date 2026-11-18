import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { unstable_readConfig, unstable_getVarsForDev } from "wrangler";
import { describe, expect, it } from "vitest";
import {
  readSquareConfiguration,
  squareOnboardingAdapter,
  type SquareApplication,
} from "../src/provider-adapters/square";

describe("actual Wrangler configuration loading", function configurationLoading() {
  it("loads the local profile and disposable secrets into a Sandbox application", async function sandboxLoading() {
    const config = unstable_readConfig({
      config: resolve("wrangler.jsonc"),
      env: "local",
    });
    const directory = mkdtempSync(resolve(tmpdir(), "satyr-config-"));
    try {
      writeFileSync(
        resolve(directory, ".dev.vars.local"),
        secretFixture("SQUARE_OAUTH_CLIENT_SECRET"),
      );
      const bindings = unstable_getVarsForDev(
        resolve(directory, "wrangler.jsonc"),
        undefined,
        config.vars,
        "local",
        true,
        config.secrets,
      );
      const configuration = readSquareConfiguration({
        SQUARE_OAUTH_ENVIRONMENT: String(
          bindings.SQUARE_OAUTH_ENVIRONMENT.value,
        ),
        SQUARE_OAUTH_CLIENT_ID: String(bindings.SQUARE_OAUTH_CLIENT_ID.value),
        SQUARE_OAUTH_CLIENT_SECRET: String(
          bindings.SQUARE_OAUTH_CLIENT_SECRET.value,
        ),
      });
      expect(configuration.kind).toBe("configured");
      if (configuration.kind !== "configured")
        throw new Error("Local Square profile is invalid");
      const url = new URL(
        await squareOnboardingAdapter.authorizationUrl({
          configuration: configuration.application,
          context: { provider: "square" },
          state: "test-state",
          redirectUri:
            "https://localhost:3003/v1/control/providers/square/callback",
          pkceVerifier: null,
        }),
      );
      expect(url.origin).toBe("https://connect.squareupsandbox.com");
      expect(config.vars.SQUARE_OAUTH_ENVIRONMENT).toBe("development");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("rejects incomplete configuration and recognizable cross-environment app IDs", function invalidApplications() {
    expect(readSquareConfiguration({})).toEqual({ kind: "unconfigured" });
    expect(
      readSquareConfiguration({
        SQUARE_OAUTH_CLIENT_ID: "sandbox-client",
        SQUARE_OAUTH_CLIENT_SECRET: "secret",
      }),
    ).toEqual({ kind: "invalid", setting: "SQUARE_OAUTH_ENVIRONMENT" });
    expect(
      readSquareConfiguration({
        SQUARE_OAUTH_CLIENT_ID: "sandbox-client",
        SQUARE_OAUTH_CLIENT_SECRET: "secret",
        SQUARE_OAUTH_ENVIRONMENT: "production",
      }),
    ).toEqual({ kind: "invalid", setting: "SQUARE_OAUTH_CLIENT_ID" });
    expect(
      readSquareConfiguration({
        SQUARE_OAUTH_CLIENT_ID: "sq0idp-client",
        SQUARE_OAUTH_CLIENT_SECRET: "secret",
        SQUARE_OAUTH_ENVIRONMENT: "development",
      }),
    ).toEqual({ kind: "invalid", setting: "SQUARE_OAUTH_CLIENT_ID" });
  });

  it("keeps explicit production identities", function productionIdentities() {
    const platform = unstable_readConfig({
      config: resolve("wrangler.jsonc"),
      env: "production",
    });
    const commerceEngine = unstable_readConfig({
      config: resolve("../commerce/wrangler.jsonc"),
      env: "production",
    });
    expect(platform.name).toBe("satyr-edge");
    expect(platform.d1_databases[0].database_id).toBe(
      "9c1e5467-2985-4ca9-8cb0-3b3b933249ef",
    );
    expect(platform.vars.SQUARE_OAUTH_ENVIRONMENT).toBe("production");
    expect(commerceEngine.name).toBe("underclerk");
  });
});

function secretFixture(key: string): string {
  return `${key}=disposable-test-secret`;
}

// A raw object cannot bypass application validation.
// @ts-expect-error SquareApplication requires the private boundary marker.
const invalidApplication: SquareApplication = {
  environment: "production",
  clientId: "sandbox-client",
  clientSecret: "secret",
};
void invalidApplication;
